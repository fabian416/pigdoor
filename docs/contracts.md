# Contratos de datos entre el backend y el verificador

Tres objetos JSON. Los dos primeros los produce el backend (o la app); el tercero lo produce el
verificador y lo puede comprobar cualquiera. Esquemas en `packages/core/src/condition.ts`,
`deterministic.ts` y `envelope.ts`; ejemplos en `examples/`.

## 1. Condition (se congela antes de fondear)

Dos tipos, distinguidos por `kind`. Campos comunes:

```json
{
  "version": "1",
  "kind": "purchase | task",
  "payer": "G...",                      // quien pone la plata (Lendoor; el padre)
  "receiver": "G... | C...",            // quien cobra el hito (la tienda; Sasha)
  "receiverName": "Casa Hogar Electro",
  "asset": { "code": "USDC", "issuer": "G..." },
  "maxAmount": "290",                   // decimal como string, máx. 7 decimales
  "window": { "notBefore": "ISO-8601", "notAfter": "ISO-8601" },
  "settlement": { "role": "escrow_funded | payee_prepaid" },
  "evidence": { "type": "invoice_photo | receipt_photo | delivery_note_photo | task_photo | document", "mustShow": ["..."] },
  "sourceText": "lo que escribió la persona, textual"
}
```

- `kind: "purchase"` agrega `category` e `items[]` (Lendoor: `["lavarropas"]`).
- `kind: "task"` agrega `task: { title, doneWhen[] }` (Piggy: "Hacer la cama", 2-4 frases observables).
- `settlement.role`: `escrow_funded` cuando el escrow le paga a un tercero (corren los dos verificadores);
  `payee_prepaid` cuando la liberación es el pago a quien hizo la cosa (corre el semántico más la
  integridad del escrow: condición comprometida y fondeo).

Ejemplos: `examples/lendoor/condition.json`, `examples/piggy/condition.json`.

`conditionHash = sha256(JCS(condition))` (RFC 8785). Ese hash va en el escrow (campo de
descripción o metadata del hito) y en el sobre. Si cambia una coma, cambia el hash.

Flujo: texto → `draftCondition()` (modelo) → la app pone `payer`, `receiver`, `asset` →
`bindCondition()` → `conditionHash()`. El modelo nunca elige direcciones.

## 2. EscrowFacts (lo que el backend lee del escrow al momento de verificar)

```json
{
  "milestoneReceiver": "G...",          // a quién paga el hito, leído del escrow
  "milestoneAmount": "100",             // cuánto paga el hito
  "fundedAt": "ISO-8601 | null",        // confirmación de funding on-chain
  "fundingTxHash": "hex",
  "evidenceSubmittedAt": "ISO-8601",    // cuándo el proveedor subió la evidencia
  "committedConditionHash": "hex"       // el conditionHash escrito en el escrow al crearlo
}
```

El verificador determinístico compara esto con la condición: **condición comprometida**, destino,
tope, ventana, fondeo. Corre igual para `escrow_funded` y `payee_prepaid`: en el segundo caso no hay
una liquidación externa que verificar, así que estos chequeos son la integridad del propio escrow y
no un segundo verificador. `status` lo informa el escrow y decide si se puede verificar (409 si ya
está RELEASED o REFUNDED). `committedConditionHash` es el hash que el backend escribió en el escrow
(descripción del hito) al crearlo, leído de vuelta del escrow: así nadie puede presentar después
una condición más laxa. Sin ese hash el veredicto es REVIEW, nunca ALLOW.

## 3. VerificationEnvelope (salida del verificador)

Nombres de campo = `VerificationEnvelope` de Trustless Work (agentic-escrow-research), más
`conditionHash`.

```json
{
  "agreementId": "C...",                // contract id del escrow
  "milestoneId": "1",
  "verifier": "G...",                   // clave pública del verificador (releaseSigner)
  "verifierType": "automated_agent",
  "criteria": [ { "id", "verifier", "result": "PASS|FAIL|UNKNOWN", "code", "reason", "mandatory" } ],
  "evidence": [ { "type", "uri", "sha256", "mimeType", "uploader", "createdAt" } ],
  "proofHash": "sha256(JCS({conditionHash, evidence: [sha256...] ordenados}))",
  "verdict": { "decision": "ALLOW|DENY|REVIEW", "reasons": ["OK"], "semanticScore": 85, "policyVersion": "1" },
  "timestamp": "ISO-8601",
  "conditionHash": "hex",
  "signature": "base64(ed25519(verifier, 'conditional-release-verdict-v1:' + sha256(JCS(sobre sin signature))))"
}
```

Qué hace el backend con cada decisión:

| decision | acción |
|---|---|
| `ALLOW` | el servicio verificador firma el release del hito; el sobre se guarda (y se ancla, si hay IPFS) |
| `DENY` | no se toca nada; se muestra `reasons` al proveedor; puede reintentar con otra evidencia dentro de la ventana |
| `REVIEW` | se escala a `disputeResolvers`; nada se mueve |

`verifyEnvelope(json)` recalcula `proofHash` y verifica la firma contra `verifier`. Lo puede correr
el frontend, un indexer o un tercero.

## 4. Anclaje del sobre (lo que se escribe en el escrow)

El backend guarda el sobre (IPFS o storage público) y escribe en el campo `evidence` del hito, con
`change-milestone-status` (lo firma un `serviceProvider`: o el verificador figura también en ese rol,
o lo escribe el backend), una sola línea:

```
verdict-v1 sha256=<sha256 de los bytes canónicos del sobre> uri=ipfs://<cid> | https://...
```

`anchorReference(envelope, uri)` y `formatAnchorReference()` la generan. Cualquiera la lee del
escrow, la pasa a `resolveEnvelope(ref, { expect: { agreementId, milestoneId, conditionHash, verifier } })`
y obtiene: el sobre, o la razón exacta por la que no vale (hash distinto, firma inválida, otro hito...).
CLI: `node packages/semantic/src/verify-cli.ts "verdict-v1 sha256=... uri=..."`.

## 5. Ciclo de vida del hito (`nextStep()`)

| Estado | Veredicto | Ahora | Acción | Quién |
|---|---|---|---|---|
| FUNDED | ALLOW | antes de `notAfter` | `RELEASE` | verificador |
| FUNDED | REVIEW | antes | `ESCALATE` → DISPUTED | verificador |
| FUNDED | DENY | antes | `WAIT` (el proveedor puede reintentar) | — |
| FUNDED o DISPUTED | cualquiera o ninguno | **después de `notAfter`** | `REFUND` | **dispute resolver** (el pagador abre la disputa; en Trustless Work la plata sale solo por release, resolve-dispute o withdraw-remaining-funds) |
| DISPUTED | — | antes | `WAIT` | dispute resolver |
| RELEASED / REFUNDED | — | — | `NONE` | — |

La fila en negrita es la regla "un verificador caído no deja la plata trabada": el vencimiento le
gana a todo veredicto, incluso a un ALLOW que nadie ejecutó. Quien ejecuta el reembolso es el
dispute resolver del escrow (el contrato de Trustless Work no tiene reembolso por tiempo); el
verificador no tiene ese rol, así que no puede bloquearlo. `refundGraceSeconds` da margen para
ejecutar el release.

## 6. Caso de disputa (`openDispute()`)

Cuando hay REVIEW o alguien impugna: `{ agreementId, milestoneId, openedAt, openedBy, trigger, condition,
envelope, modelReading?, evidenceLinks[], questions[], challengeNote? }`. Las `questions` salen de los
códigos abiertos (ej. `DOCUMENT_ILLEGIBLE` → "pedir una foto más clara"). El sobre va intacto para que
el resolutor lo re-verifique.

## 7. Endpoints del servicio verificador (`services/verifier`)

| Método y ruta | Entrada | Salida |
|---|---|---|
| `GET /health` | — | `{ ok, verifier (G...), model, autoRelease, acceptReadings, authenticated }`. Regla para el backend: si `acceptReadings` es true, el servicio está en modo demo y ningún veredicto debe disparar un release real |
| `POST /conditions` | `{ text, payer, receiver, asset, settlementRole, defaultDeadline }` | `{ condition, conditionHash, draft }` (503 sin credenciales de modelo) |
| `POST /agreements/:id/underwrite` | `{ condition, facts: { score, kycOk, kycValidUntil, approvedLimit, outstanding, evaluatedAt }, policy: { minScore, maxDisbursement, version } }` | `{ id, envelope, anchor, fundable }` — el veredicto del underwriter de Lendoor, `milestoneId: "underwriting"`, firmado con `UNDERWRITER_SECRET` si está, antes de fondear |
| `POST /agreements/:id/milestones/:m/verify` | `{ condition, evidence[], image \| reading, fx? }` | `{ id, envelope, anchor, anchorError?, nextStep, status, release?, releaseError?, disputeError?, demo }`. El estado del hito se lee del escrow, nunca del body; 409 si ya está RELEASED o REFUNDED; 503 si el modelo no respondió (reintentar, no se firma nada). Si una escritura al escrow falla, el sobre firmado ya quedó guardado y servido: el error viene en `anchorError` / `releaseError` / `disputeError`, nunca se pierde el veredicto |
| `GET /envelopes/:sha256` | — | los bytes canónicos del sobre (destino del anclaje) |
| `GET /envelopes` | — | `{ ids }` |
| `POST /envelopes/:sha256/challenge` | `{ openedBy, note, condition, evidenceLinks? }` | `{ caseId, case }` y marca el hito en disputa |
| `GET /cases/:id` | — | el caso |

El backend de producto llama a `verify` cuando el proveedor sube la evidencia; el servicio lee los
hechos del escrow por su cuenta (`EscrowClient`), nunca confía en los que le manden.

## 8. Roles del escrow al desplegar (Trustless Work V2, `POST /escrow/multi-release/v2/deploy`)

Lo que el backend manda al crear cada escrow. Las reglas entre paréntesis son las del DTO
`MultiReleaseRolesV2Dto` de la API V2 (`beta.api.trustlesswork.com`): `disputeResolvers` **no puede
solaparse con ningún otro rol**, `admin` **debe ser distinto de todos**, el resto puede repetirse. El
verificador firma la liberación con `approve-and-release-milestones`, que exige al firmante en
`approvers` **y** `releaseSigners` (lo verifica el contrato); y escribe la línea de anclaje con
`change-milestone-status`, que exige un `serviceProvider`. Por eso va en los tres. No es admin, no es
resolutor y no fondea: puede aprobar y liberar hitos que ya existen, nada más.

| Rol | Lendoor · Ana (290 USDC) | Piggy · Sasha (2 USDC) | Por qué |
|---|---|---|---|
| `approvers` | `[VERIFIER]` | `[VERIFIER]` | quien aprueba el hito es el veredicto firmado |
| `releaseSigners` | `[VERIFIER]` | `[VERIFIER]` | la misma clave que firma el sobre libera la plata |
| `serviceProviders` | `[VERIFIER]` | `[VERIFIER]` | para escribir `verdict-v1 sha256=… uri=…` en `evidence` |
| `disputeResolvers` | `[LENDOOR_OPS]` | `[PARENT]` | resuelve REVIEW y ejecuta el reembolso tras `notAfter`; no puede ser ninguna otra clave |
| `platform` | `[LENDOOR_BACKEND]` | `[PIGGY_BACKEND]` | cobra `platformFee` (poner `0`; si la API lo rechaza, el mínimo que acepte) |
| `admin` | `[LENDOOR_ADMIN]` | `[PIGGY_ADMIN]` | `update`, `manage-milestones`, `extend-ttl`; clave aparte, distinta de todas |
| `observers` | `[FUNDER]` (opcional) | `[]` | solo lectura; el socio que fondea el libro de Lendoor |
| `signer` (deploy) y `signer` (fund) | `LENDOOR_BACKEND` | `PIGGY_BACKEND` (o `PARENT`) | quien despliega y fondea; el pagador no es un rol |
| `milestones[0].receiver` | `STORE` | `SASHA` | el `receiver` de la condición; el verificador compara los dos |
| `milestones[0].amount` | `290` | `2` | igual a `maxAmount` de la condición |
| `milestones[0].description` | `condition-v1 sha256=<conditionHash>` | idem | el hash comprometido; sin él todo veredicto es REVIEW |
| `milestones[0].approvalsTarget` | `1` (default) | `1` | con `2` y `approvers = [VERIFIER, PLATFORM]` el verificador solo no puede liberar: endurecimiento para después del hackathon |
| `trustline` | `{ "contractId": "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA" }` | idem | USDC de Circle en testnet (SAC) |
| `engagementId` | `lendoor-ana-0001` | `piggy-sasha-0001` | el `agreementId` de los sobres es el `contractId` que devuelve el deploy, no este |

Cuentas: cada `G...` debe existir en testnet (friendbot). `STORE` y `SASHA` necesitan trustline a USDC
para cobrar; quien fondea necesita saldo USDC; el verificador solo XLM para fees (la API arma la
transacción con el firmante como cuenta origen). El índice del hito en la API es 0; en este servicio
es `"1"` (`index = Number(milestoneId) - 1`).

Esta tabla está escrita como spec en `examples/lendoor/escrow.json` y `examples/piggy/escrow.json`
(tokens `$VERIFIER`, `$RESOLVER`, `$ADMIN`, `$PLATFORM`, `$RECEIVER`, `$CONDITION_HASH`), y
`services/verifier/src/tw-deploy.ts` la despliega y fondea con la API V2 (comando en el README). El
cliente real está en `services/verifier/src/trustless-work.ts`: lee el escrow y la cola de depósitos
(`GET /escrow/multi-release/v2/:id`, `GET /escrows/:id/deposits`), escribe el anclaje con
`change-milestone-status` (status `completed` si ALLOW, `verdict:DENY` / `verdict:REVIEW` si no),
libera con `approve-and-release-milestones` y escala con `dispute-milestones`; cada escritura firma el
XDR que devuelve la API con la clave del verificador y lo manda a `POST /stellar/send-transaction`.
`fundedAt` es el depósito en el activo del trustline con el que la suma alcanza el total de los hitos.

**Corrida real (26/10):** la key de testnet que da dapp.trustlesswork.com es de la API **V1**
(`dev.api.trustlesswork.com`); la V2 exige credencial emitida por el backoffice. Por eso la evidencia
on-chain del README salió de `services/verifier/src/tw1-live.ts` (V1: roles singulares `approver`,
`serviceProvider`, `platformAddress`, `releaseSigner`, `disputeResolver`; `receiver` por hito; índices
`"0"`; `approve-milestone` y `release-milestone-funds` son dos transacciones) corriendo dentro del
contenedor del servicio público, con su misma clave y su mismo almacén de sobres. `tw1-op.ts` hace
disputa y resolución (`distributions: [{ address, amount }]`).

Las claves del verificador y del underwriter son fijas por despliegue (`VERIFIER_SECRET`,
`UNDERWRITER_SECRET`); sus direcciones públicas están en el README para que el backend las copie en
los roles. La smart account de OpenZeppelin con política de gasto como `releaseSigner` queda como
roadmap: la API V2 construye cada transacción con una wallet `G` como firmante, así que una cuenta
contrato no puede liberar a través de ella (habría que armar la invocación por fuera de la API).

## Códigos de razón

La lista completa y normativa es `REASON_CODES` en `packages/core/src/criteria.ts`:
`OK · NO_CRITERIA · CONDITION_NOT_COMMITTED · CONDITION_MISMATCH · DESTINATION_MISMATCH · AMOUNT_OVER_MAX ·
EVIDENCE_OUT_OF_WINDOW · ESCROW_NOT_FUNDED · SCORE_BELOW_THRESHOLD · KYC_INVALID · AMOUNT_OVER_LIMIT ·
AMOUNT_OVER_POLICY · MERCHANT_MISMATCH · ITEMS_MISMATCH · DOC_DATE_OUT_OF_WINDOW · DOC_DATE_UNREADABLE ·
DOC_TOTAL_OVER_MAX · DOC_TOTAL_UNREADABLE · DOC_CURRENCY_UNKNOWN · DOCUMENT_ILLEGIBLE · TASK_NOT_VISIBLE ·
TASK_NOT_DONE · PHOTO_STAGED · MODEL_OUTPUT_INVALID · MODEL_REFUSED · MODEL_ERROR · LOW_CONFIDENCE`

## Regla de decisión (`decide()`, versión de política "1")

1. Sin criterios → `REVIEW`.
2. Algún criterio obligatorio en `FAIL` → `DENY` con todos los códigos.
3. Algún obligatorio en `UNKNOWN` → `REVIEW`.
4. Score semántico < 40 → `DENY`; entre 40 y 69 → `REVIEW`; ≥ 70 → `ALLOW`.

El total del remito en otra moneda (ARS) es informativo salvo que se pase un tipo de cambio: el
monto que de verdad se paga ya está acotado on-chain por el chequeo determinístico.
