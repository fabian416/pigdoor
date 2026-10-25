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
tope, ventana, fondeo. `committedConditionHash` es el hash que el backend escribió en el escrow
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
`change-milestone-status`, una sola línea:

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
| FUNDED o DISPUTED | cualquiera o ninguno | **después de `notAfter`** | `REFUND` | **cualquiera** |
| DISPUTED | — | antes | `WAIT` | dispute resolver |
| RELEASED / REFUNDED | — | — | `NONE` | — |

La fila en negrita es la regla "un verificador caído no deja la plata trabada": el vencimiento le
gana a todo veredicto, incluso a un ALLOW que nadie ejecutó. `refundGraceSeconds` da margen para
ejecutar el release.

## 6. Caso de disputa (`openDispute()`)

Cuando hay REVIEW o alguien impugna: `{ agreementId, milestoneId, openedAt, openedBy, trigger, condition,
envelope, modelReading?, evidenceLinks[], questions[], challengeNote? }`. Las `questions` salen de los
códigos abiertos (ej. `DOCUMENT_ILLEGIBLE` → "pedir una foto más clara"). El sobre va intacto para que
el resolutor lo re-verifique.

## 7. Endpoints del servicio verificador (`services/verifier`)

| Método y ruta | Entrada | Salida |
|---|---|---|
| `GET /health` | — | `{ ok, verifier (G...), model, autoRelease }` |
| `POST /conditions` | `{ text, payer, receiver, asset, defaultDeadline }` | `{ condition, conditionHash, draft }` (503 sin credenciales de modelo) |
| `POST /agreements/:id/underwrite` | `{ condition, facts: { score, kycOk, kycValidUntil, approvedLimit, outstanding, evaluatedAt }, policy: { minScore, maxDisbursement, version } }` | `{ id, envelope, anchor, fundable }` — el veredicto del underwriter de Lendoor, `milestoneId: "underwriting"`, firmado con `UNDERWRITER_SECRET` si está, antes de fondear |
| `POST /agreements/:id/milestones/:m/verify` | `{ condition, evidence[], image \| reading, fx?, status? }` | `{ id, envelope, anchor, nextStep, status, release? }` |
| `GET /envelopes/:sha256` | — | los bytes canónicos del sobre (destino del anclaje) |
| `GET /envelopes` | — | `{ ids }` |
| `POST /envelopes/:sha256/challenge` | `{ openedBy, note, condition, evidenceLinks? }` | `{ caseId, case }` y marca el hito en disputa |
| `GET /cases/:id` | — | el caso |

El backend de producto llama a `verify` cuando el proveedor sube la evidencia; el servicio lee los
hechos del escrow por su cuenta (`EscrowClient`), nunca confía en los que le manden.

## Códigos de razón

`OK · NO_CRITERIA · CONDITION_NOT_COMMITTED · CONDITION_MISMATCH · DESTINATION_MISMATCH · AMOUNT_OVER_MAX · EVIDENCE_OUT_OF_WINDOW · ESCROW_NOT_FUNDED ·
MERCHANT_MISMATCH · ITEMS_MISMATCH · DOC_DATE_OUT_OF_WINDOW · DOC_DATE_UNREADABLE · DOC_TOTAL_OVER_MAX ·
DOC_TOTAL_UNREADABLE · DOC_CURRENCY_UNKNOWN · DOCUMENT_ILLEGIBLE · MODEL_OUTPUT_INVALID · MODEL_REFUSED ·
MODEL_ERROR · LOW_CONFIDENCE`

## Regla de decisión (`decide()`, versión de política "1")

1. Sin criterios → `REVIEW`.
2. Algún criterio obligatorio en `FAIL` → `DENY` con todos los códigos.
3. Algún obligatorio en `UNKNOWN` → `REVIEW`.
4. Score semántico < 40 → `DENY`; entre 40 y 69 → `REVIEW`; ≥ 70 → `ALLOW`.

El total del remito en otra moneda (ARS) es informativo salvo que se pase un tipo de cambio: el
monto que de verdad se paga ya está acotado on-chain por el chequeo determinístico.
