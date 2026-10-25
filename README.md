# Witness

> **Proof before payment: money that moves only when the condition is proven.**
> Piggy × Lendoor at [HackMeridian 2026](https://www.hackmeridian.com/build), Lisbon, 25–26 October · Scale · Stellar Composed.

Money locked in a Stellar escrow is released only when the evidence says what it has to say.
Four pieces: a **Condition** committed by hash before funds move, **Evidence** sealed in an
envelope, a **Verdict** signed by a verifier each product plugs in, and the **Escrow** (Trustless
Work) that releases or holds.

Two products, two verifiers, one envelope format:

- **Piggy, families**: the allowance when the chore is done. The AI describes the photo against
  the "done when" statements; code decides. One verifier, because the release *is* the payment.
- **Lendoor, credit**: the partner's capital when underwriting says yes, paid to the store against
  the invoice. Two verifiers on the same escrow: the deterministic one proves the money goes to the
  committed address, within the cap, inside the window, from a funded escrow; the semantic one proves
  the invoice says what it must. Plus the **underwriter** verdict (score, KYC, line, policy) signed
  for the funder before funding, so whoever put the money in can audit every decision without
  trusting Lendoor.

The model never compares or adds: it only extracts fields under a strict schema. Every comparison
and every decision is deterministic code.

The result is a signed `VerificationEnvelope` that follows the
[Trustless Work research vocabulary](https://github.com/Trustless-Work/agentic-escrow-research/blob/main/research-notes/verification-and-evidence-envelope-2026-09-21.md),
so their tooling can read ours. Anyone can verify the signature.

## Layout

| Path | What |
|---|---|
| `packages/core` | Condition schema (purchase / task, `settlement.role`), RFC 8785 canonicalization and hashing, criteria and the decision rule, deterministic verifier, Lendoor underwriter verifier, signed envelope, anchoring (verify a verdict from the reference written in the escrow), milestone lifecycle (refund after the deadline), dispute case. Pure TypeScript, no I/O beyond an injectable fetch. |
| `packages/semantic` | Semantic verifiers (Claude with structured outputs): invoice reading for purchases, task-photo reading for chores; the trigger agent that turns the payer's words into a condition; `cli.ts` (run one verdict) and `verify-cli.ts` (re-verify an anchored envelope). |
| `examples/lendoor`, `examples/piggy` | The two flows from the deck: Ana's washing machine (290 USDC, invoice, underwriting) and Sasha's bed (2 USDC, photo). |
| `services/verifier` | The verifier as its own process with its own key: `POST /agreements/:id/milestones/:m/verify` runs both verifiers, signs the envelope, serves it content-addressed at `GET /envelopes/:sha256` (the anchor target), writes the anchor line into the escrow and releases or escalates. The escrow provider sits behind an interface: in-memory for the demo, Trustless Work V2 to be wired after the integration spike. |
| `scripts/demo.sh` | Happy path, rejection path, independent re-verification. Offline by default; pass a photo to go live. |
| `.github/workflows/ci.yml` | Typecheck, tests and the offline demo on every push. |

## For the frontend and the product backend

Everything the UI shows comes from the verifier service; the JSON shapes are in
[`docs/contracts.md`](docs/contracts.md). Call sequence per flow:

**Lendoor · Ana's washing machine**
1. `POST /conditions` with Ana's request text, the store's address, Lendoor's payer address, `settlementRole: "escrow_funded"` → `condition` + `conditionHash`. Show the text next to the structured condition.
2. `POST /agreements/:id/underwrite` with the condition, the risk engine's facts and the policy → `fundable` and the underwriter's envelope. Show score, KYC, line, policy as four checks. Only if `fundable` the backend creates and funds the Trustless Work escrow, writing `conditionHash` in the milestone description.
3. The store uploads the invoice; the backend posts `POST /agreements/:id/milestones/:m/verify` with the condition, the evidence item (sha256 of the photo) and the photo → `envelope`, `anchor`, `nextStep`. Show the deterministic and the semantic criteria side by side, the decision, and the anchor link.
4. On `RELEASE` the backend (or the service with `AUTO_RELEASE=1`) releases the milestone; show the tx hash. On `DENY` show `verdict.reasons`; on `ESCALATE` show the dispute case.
5. Funder view: `GET /envelopes` and `GET /envelopes/:sha256`, each re-verifiable with `verifyEnvelope()` in the browser or `verify-cli.ts`.

**Piggy · Sasha's bed**
1. `POST /conditions` with the parent's text, Sasha's address, `settlementRole: "payee_prepaid"`.
2. Backend creates and funds the 2 USDC milestone with `conditionHash`.
3. Sasha's photo → `verify` → one semantic verifier (plus the escrow integrity checks) → `ALLOW` releases to Sasha, `DENY` shows why, `REVIEW` goes to the parent as dispute resolver.

Readings instead of photos are accepted only with `ACCEPT_READINGS=1` (demo mode, no model credentials needed); the example readings live in `examples/`.

## Run the verifier service

```bash
ACCEPT_READINGS=1 pnpm --filter @witness/verifier-service start   # demo mode: http://localhost:8787, in-memory escrow seeded with examples/lendoor/facts.json

curl -s localhost:8787/health
curl -s -X POST localhost:8787/agreements/demo/milestones/1/verify -H 'content-type: application/json' \
  -d "$(node -e 'const r=require;console.log(JSON.stringify({condition:r("./examples/lendoor/condition.json"),evidence:r("./examples/lendoor/evidence.json"),reading:r("./examples/lendoor/reading-good.json")}))')"
```

| Env | Meaning | Default |
|---|---|---|
| `VERIFIER_SECRET` | Stellar secret (S...) of the release signer; its public key is what the escrow lists | ephemeral, printed at start |
| `UNDERWRITER_SECRET` | Stellar secret of Lendoor's underwriter, so its verdicts carry their own address | the verifier key |
| `ANTHROPIC_API_KEY` | Credentials for the semantic verifier (or `ant auth login`) | unset → only precomputed readings accepted |
| `PUBLIC_URL` | Base URL used in anchor references | `http://localhost:8787` |
| `AUTO_RELEASE` | `1` to execute releases on ALLOW; otherwise the service only reports the next step | report only |
| `ACCEPT_READINGS` | `1` accepts precomputed document readings instead of photos. Demo only; refused together with `AUTO_RELEASE` because a posted reading could release funds | off |
| `API_TOKEN` | Bearer token the product backend must send on every write; reads (health, anchored envelopes, cases) stay public | unset = open, local dev only |
| `ESCROW` | `memory` or `tw` (Trustless Work V2; needs `TW_API_KEY`, `TW_BASE_URL`) | `memory` |
| `DATA_DIR` | Where envelopes and cases are stored | `./data` |
| `PORT` | Listen port | `8787` |

Why a separate process: if the service that funds the escrow also signed releases, the payer would be releasing to itself. Separate keys make the role split checkable on-chain.
| `docs/contracts.md` | The three JSON objects the backend and the verifier exchange. |

## Run

```bash
pnpm install
pnpm test

# both flows from the deck, offline, five signed envelopes re-verified
./scripts/demo.sh

# one verdict, live model on a photo (needs ANTHROPIC_API_KEY or `ant auth login`)
node packages/semantic/src/cli.ts --condition examples/lendoor/condition.json --facts examples/lendoor/facts.json \
  --evidence examples/lendoor/evidence.json --photo factura.jpg --fx ARS=1450
node packages/semantic/src/cli.ts --condition examples/piggy/condition.json --facts examples/piggy/facts.json \
  --evidence examples/piggy/evidence.json --photo cama.jpg

# Lendoor's underwriting verdict, before funding
node packages/semantic/src/cli.ts --condition examples/lendoor/condition.json --underwriting examples/lendoor/underwriting.json
```

## Prior work

Built by people from Lendoor and Piggy. Earlier work by the same team: credit delegation in
[lendoor-stellar](https://github.com/LuchoLeonel/lendoor-stellar) (Soroban) and
[lenclaw](https://github.com/fabian416/lenclaw) (agent credit on Base, March 2026). None of that
code is used here; the "model proposes, rules decide" pattern comes from lenclaw.

## License

Apache-2.0. Commits are signed off (DCO).
