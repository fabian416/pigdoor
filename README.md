# Witness

[![ci](https://github.com/fabian416/witness/actions/workflows/ci.yml/badge.svg)](https://github.com/fabian416/witness/actions/workflows/ci.yml)

> **Proof before payment: money that moves only when the condition is proven.**
> Piggy Wallet × Lendoor at [HackMeridian 2026](https://www.hackmeridian.com/build), Lisbon, 25–26 October · Scale category.

## The problem

Escrow already exists on Stellar. Proving the condition does not. Trustless Work's own research
note on evidence-gated release lists what their pilot does not establish:
*"that the evidence is true or complete"* — it checks integrity, addressing and a signature, not
content. Witness is that missing half: a verification layer that reads the evidence, decides by
rules, signs the verdict with the same key that releases the escrow, and anchors it so that whoever
funded the escrow can audit every decision without trusting us.

Two products with the same problem for different reasons:

- **Piggy, families.** The allowance when the chore is done. Today a parent checks by hand, or pays first.
- **Lendoor, credit.** The partner's capital when underwriting says yes, paid to the store against the
  invoice. Partners fund the book and need to audit each decision without trusting Lendoor. That is
  why the verdict goes on-chain and not into a database.

## How it works

```
  payer's words ──► trigger agent ──► Condition (JSON) ──► sha256(RFC 8785) = conditionHash
                                                                  │  written in the escrow milestone
                                                                  ▼
  Trustless Work multi-release escrow (Stellar testnet, USDC) ─── funded, milestone pays `receiver`
                                                                  │
  evidence (photo) ──► sha256 ──► verifier service ◄── escrow facts (receiver, amount, funding, status, conditionHash)
                                   │
                                   ├─ deterministic checks: committed condition, funded, destination, cap, window
                                   ├─ semantic verifier: Claude extracts fields under a strict schema; code compares
                                   ├─ (Lendoor, before funding) underwriter: score, KYC, line, policy
                                   ▼
                       decide() ──► Verdict ──► VerificationEnvelope, signed ed25519 by the verifier key
                                                │
                     ALLOW ──► approve-and-release milestone      anchor line in the milestone evidence:
                     DENY  ──► nothing moves, reasons shown       verdict-v1 sha256=<hex> uri=<GET /envelopes/:sha256>
                     REVIEW ─► dispute, human resolver            anyone re-verifies: hash, signature, agreement, condition
```

Four pieces. **Condition** committed by hash before funds move. **Evidence** sealed in an envelope that
names the exact bytes the model saw. **Verdict** signed by a verifier each product plugs in. **Escrow**
(Trustless Work) releases or holds.

What the model does and does not do: it extracts what is written or visible (names, items, dates,
totals, whether a task is done) under a strict JSON schema, and it says whether a name or an item list
refers to the expected merchant or goods. It never sees the amount cap or the policy, never compares
numbers, never computes the score and never decides. Dates, totals, amounts, destinations, hashes and
the decision itself are deterministic code (`packages/core`). Prompt injection is closed on the image
channel by construction (the model can only emit the schema); the text channel (the payer's own words
reaching the trigger prompt) is mitigated, not closed: the model can only emit a draft, and addresses,
asset and settlement role are bound by the app.

Two verifiers, one envelope: `settlement.role = escrow_funded` (Lendoor) runs the escrow checks and the
invoice reader, since the escrow pays a third party; `payee_prepaid` (Piggy) runs the escrow's own
integrity checks and the task-photo reader, since the release *is* the payment. The Lendoor
underwriter signs a separate verdict before funding with its own key.

## Demo

- Video: *pending*.
- Public verifier URL: *pending* (`PUBLIC_URL` of the deployed service; the anchors point there).
- Offline, right now: `./scripts/demo.sh` runs the five verdicts of the two flows and re-verifies them.

### On-chain evidence (Stellar testnet)

| Flow | Escrow contract | Deploy / fund tx | Release tx |
|---|---|---|---|
| Lendoor · Ana's washing machine (290 USDC) | *pending* | *pending* | *pending* |
| Piggy · Sasha's bed (2 USDC) | *pending* | *pending* | *pending* |

Verifier (release signer, in `approvers` + `releaseSigners` + `serviceProviders` of both escrows):
[`GBBRAFA4UK67BNR4FOJKVCQDF5U2MDNKN45TPMWSLIKNLS4WLHHVYSZ6`](https://stellar.expert/explorer/testnet/account/GBBRAFA4UK67BNR4FOJKVCQDF5U2MDNKN45TPMWSLIKNLS4WLHHVYSZ6) ·
Underwriter (signs Lendoor's funding verdict, no escrow role):
[`GAFF3ADHA4VIM2UHH5L677LK7MNRIL6V2HQHSYXVHQONTLMO7ZVKXO6J`](https://stellar.expert/explorer/testnet/account/GAFF3ADHA4VIM2UHH5L677LK7MNRIL6V2HQHSYXVHQONTLMO7ZVKXO6J).
Testnet keys, created 26 Oct for this submission. The role layout per escrow is in
[`docs/contracts.md` §8](docs/contracts.md). Tx links go to `https://stellar.expert/explorer/testnet/tx/<hash>`.
**Every hash in `examples/` and in the tests is synthetic** (`111…`, `222…`, `ESCROW-DEMO-0001`) until
the team's own transactions replace them.

## Built at HackMeridian vs prior work

**Built here (25–26 Oct 2026, every commit in this repo):** everything in this repository — condition
schema and hashing, both verifiers, the underwriter, the signed envelope, anchoring, lifecycle,
disputes, the verifier service, tests, CI, docs. First commit 25 Oct 13:56 UTC.

**Prior work by the same team, not used here:** credit delegation in
[lendoor-stellar](https://github.com/LuchoLeonel/lendoor-stellar) (Soroban loan manager, SCF #45) and
[lenclaw](https://github.com/fabian416/lenclaw) (agent credit on Base, March 2026). The "model proposes,
rules decide" pattern comes from lenclaw; no code does.

**Not finished at submission:** the Trustless Work V2 client (`services/verifier/src/escrow-client.ts`,
`trustlessWorkClient`) is an interface with the endpoints annotated, pending the testnet integration;
the OpenZeppelin smart-account release signer is roadmap.

## Layout

| Path | What |
|---|---|
| `packages/core` | Condition (purchase / task, `settlement.role`), RFC 8785 canonicalization and sha256, criteria and `decide()`, deterministic escrow checks, Lendoor underwriter, signed `VerificationEnvelope`, anchoring, milestone lifecycle, dispute case. Pure TypeScript. |
| `packages/semantic` | Claude with structured outputs: invoice reader (purchases) and task-photo reader (chores); the trigger agent (payer's words → condition draft); `cli.ts` (one verdict) and `verify-cli.ts` (re-verify an anchored envelope). |
| `services/verifier` | The verifier as its own process with its own key: `underwrite`, `verify`, content-addressed `GET /envelopes/:sha256` (the anchor target), challenges. Escrow behind `EscrowClient`: in-memory for the demo, Trustless Work V2 to wire. |
| `examples/lendoor`, `examples/piggy` | The deck's two flows, synthetic. |
| `docs/contracts.md` | The JSON objects the backend and the verifier exchange, endpoints, lifecycle (Spanish). |
| `scripts/demo.sh` | Five verdicts, five re-verifications, offline. |
| `Dockerfile`, `.github/workflows/ci.yml` | Container for the service; typecheck, tests and the demo on every push. |

## Setup

Prerequisites: Node ≥ 24 and pnpm 10 (`corepack enable`).

```bash
pnpm install
pnpm typecheck && pnpm test          # 99 tests
./scripts/demo.sh                     # offline: five signed envelopes in ./out, all re-verified

# one live verdict on a photo (needs ANTHROPIC_API_KEY)
node packages/semantic/src/cli.ts --condition examples/lendoor/condition.json --facts examples/lendoor/facts.json \
  --evidence examples/lendoor/evidence.json --photo factura.jpg --fx ARS=1450
node packages/semantic/src/cli.ts --condition examples/piggy/condition.json --facts examples/piggy/facts.json \
  --evidence examples/piggy/evidence.json --photo cama.jpg
# Lendoor's underwriting verdict, before funding
node packages/semantic/src/cli.ts --condition examples/lendoor/condition.json --underwriting examples/lendoor/underwriting.json
```

## Run the verifier service

```bash
ACCEPT_READINGS=1 pnpm start          # demo mode on :8787, in-memory escrow with demo/1 (Lendoor) and sasha/1 (Piggy)
curl -s localhost:8787/health
```

| Env | Meaning | Default |
|---|---|---|
| `VERIFIER_SECRET` | Stellar secret (S...) of the release signer; its public key is what the escrow lists in `approvers` and `releaseSigners`. Fixed in any real deployment | ephemeral, printed at start |
| `UNDERWRITER_SECRET` | Lendoor's underwriter key, so its verdicts carry their own address | the verifier key |
| `API_TOKEN` | Bearer token the product backend must send on every write; reads stay public. Required with `AUTO_RELEASE` | unset = open, local only |
| `PUBLIC_URL` | Base URL written into anchors. Required with `ESCROW=tw` | `http://localhost:8787` |
| `ANTHROPIC_API_KEY` | Credentials for the semantic verifier | unset → only readings in demo mode |
| `AUTO_RELEASE` | `1` executes releases on ALLOW; otherwise the service reports the next step | report only |
| `ACCEPT_READINGS` | `1` accepts precomputed readings instead of photos. Demo only; refused with `AUTO_RELEASE`; such envelopes carry `verifier: semantic:client_reading` and the response says `demo: true` | off |
| `ESCROW` | `memory` or `tw` (Trustless Work V2; needs `TW_API_KEY`, optional `TW_BASE_URL`) | `memory` |
| `DATA_DIR`, `PORT` | Envelope and case store; listen port | `./data`, `8787` |

Why a separate process: if the service that funds the escrow also signed releases, the payer would be
releasing to itself. Separate keys make the role split checkable on-chain.

## For the frontend and the product backend

JSON shapes in [`docs/contracts.md`](docs/contracts.md). Per flow:

**Lendoor · Ana** — `POST /conditions` (text, store address, Lendoor payer, `settlementRole: "escrow_funded"`) →
`POST /agreements/:id/underwrite` (facts from the risk engine + policy → `fundable`) → backend deploys and funds
the escrow with `conditionHash` in the milestone description → store uploads the invoice → `POST
/agreements/:id/milestones/:m/verify` (condition, evidence item with the photo's sha256, photo) → on `RELEASE`
the backend releases (or the service with `AUTO_RELEASE=1`); on `DENY` show `verdict.reasons`; on `ESCALATE`
show the dispute case → funder view from `GET /envelopes` and `GET /envelopes/:sha256`.

**Piggy · Sasha** — `POST /conditions` (`settlementRole: "payee_prepaid"`) → backend funds the 2 USDC milestone →
Sasha's photo → `verify` → `ALLOW` pays Sasha, `DENY` shows why, `REVIEW` goes to the parent as resolver.

Rules for the backend: the milestone status comes from the escrow, never from the UI; never execute a
release from a service whose `/health` says `acceptReadings: true`.

## License

Apache-2.0. Every commit is signed off (DCO).
