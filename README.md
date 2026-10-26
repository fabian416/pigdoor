# Witness

[![ci](https://github.com/fabian416/witness/actions/workflows/ci.yml/badge.svg)](https://github.com/fabian416/witness/actions/workflows/ci.yml)

> **Proof before payment: money that moves only when the condition is proven.**
> Piggy Wallet × Lendoor at [HackMeridian 2026](https://www.hackmeridian.com/build), Lisbon, 25–26 October · Scale category.
> Team: Lucho (CEO, Lendoor), Fabián Díaz (CTO, Lendoor), Sofía Vásquez (CEO, Piggy Wallet).

## In 60 seconds, for reviewers

- **What it is.** A verification layer for Trustless Work escrows on Stellar: a condition is frozen and
  committed by hash before funding; a photo is read by Claude under a strict schema; deterministic code
  decides; the verdict is signed by the same key that releases the escrow and anchored in the milestone.
- **What runs today.** Public verifier `https://hackmeridian.api.lendoor.xyz` (`/health`). Two front ends:
  the standalone page in `demo/` (this repo), and `https://hackmeridian.lendoor.xyz`, Lendoor's existing testnet
  app (lendoor-stellar, prior work) with a Witness verification screen added during the hack, calling this
  verifier against its seeded demo milestone.
- **What is on-chain** (Stellar testnet, USDC): escrow
  [`CDGQRKMQ…U6WJ7W`](https://stellar.expert/explorer/testnet/contract/CDGQRKMQHLROLX6L6FW6VQQI7BQXRCKQ7IDJUN5QZLUTZQR2E3U6WJ7W)
  deployed with the condition hash, funded, verdict ALLOW on a real invoice anchored in the milestone,
  approved and released by the verifier key; a refused attempt (DENY, anchored, refunded through the
  dispute resolver); and the Piggy escrow
  [`CCTXZHRD…J7UY4H`](https://stellar.expert/explorer/testnet/contract/CCTXZHRDGY5TSIUONXZK6MVKONPXONKM4GMXOIEJHH4UVL323YJ7UY4H)
  deployed and funded. Every transaction is linked in [On-chain evidence](#on-chain-evidence-stellar-testnet-trustless-work-multi-release-escrows-usdc).
- **Verify it yourself, one command, no trust in us:**
  ```bash
  pnpm install && node packages/semantic/src/verify-cli.ts "verdict-v1 sha256=839df0a154d7056b76c61a4eade55915237d85d0e4c1e4558672b6407cc3b7f5 uri=https://hackmeridian.api.lendoor.xyz/envelopes/839df0a154d7056b76c61a4eade55915237d85d0e4c1e4558672b6407cc3b7f5"
  ```
  It fetches the anchored envelope, recomputes its hash, checks the ed25519 signature against the
  verifier address and prints the criteria tally (10/10). `pnpm test` runs 113 tests; `./scripts/demo.sh`
  runs both flows offline.
- **Built here.** Every commit in this repository, 25–26 October (Apache-2.0; 21 of 22 commits carry a DCO
  sign-off, see License). Prior work by the same team is listed below; none of its code is in this repository.

## The problem

Escrow already exists on Stellar. Proving the condition does not. Trustless Work's own
[research note on evidence-gated release](https://github.com/Trustless-Work/agentic-escrow-research)
lists what their pilot does not establish:
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
- Public verifier: `https://hackmeridian.api.lendoor.xyz` (`GET /health` reports the key it signs with). Demo
  page: `https://hackmeridian.lendoor.xyz`. The live service runs in demo mode: in-memory escrow seeded with
  the two milestones, the model on, readings accepted, no auto-release.
- Offline, right now: `./scripts/demo.sh` runs the five verdicts of the two flows and re-verifies them.

### Live verdicts on real photos (26 Oct, Claude reading the invoices, rules deciding)

Two test invoices, sent as photos to the public verifier. The exact bytes the envelopes seal are committed
here as `examples/lendoor/factura-ok.jpg` (sha256 `69d9b7f0…`) and `examples/lendoor/factura-mal.jpg`
(`5b15f329…`); the demo site replaced its copies with new renders later that morning, so the `uri` inside
the envelopes no longer serves those bytes, the files in this repo do. These two envelopes come from the
seeded in-memory demo escrow (agreement `demo`): its funding hash is a fixture, not a funding of any escrow;
the escrow-backed verdicts are in the table further down. The anchor lines below resolve to the signed
envelopes; anyone can re-check them with `verify-cli` (hash of the canonical bytes, ed25519 signature,
agreement, condition):

```
verdict-v1 sha256=27eb6eba443793ffd2506a4144101ef4514d3d6a04d39f0931f72d5cd51e35fc uri=https://hackmeridian.api.lendoor.xyz/envelopes/27eb6eba443793ffd2506a4144101ef4514d3d6a04d39f0931f72d5cd51e35fc
verdict-v1 sha256=c2aeeed6b36e176e06815fa8202304b0c469d947ef80de6531d6be705f6af586 uri=https://hackmeridian.api.lendoor.xyz/envelopes/c2aeeed6b36e176e06815fa8202304b0c469d947ef80de6531d6be705f6af586
```

| Photo | Decision | Reasons | Score |
|---|---|---|---|
| `factura-ok.jpg` (Casa Hogar Electro, lavarropas, 412.000 ARS, 27/10) | **ALLOW** | OK (10/10 criteria) | 93 |
| `factura-mal.jpg` (Supermercado El Trébol, alimentos y bebidas) | **DENY** | MERCHANT_MISMATCH, ITEMS_MISMATCH | 30 |

```bash
node packages/semantic/src/verify-cli.ts "verdict-v1 sha256=27eb6eba443793ffd2506a4144101ef4514d3d6a04d39f0931f72d5cd51e35fc uri=https://hackmeridian.api.lendoor.xyz/envelopes/27eb6eba443793ffd2506a4144101ef4514d3d6a04d39f0931f72d5cd51e35fc"
```

### On-chain evidence (Stellar testnet, Trustless Work multi-release escrows, USDC)

Run on 26 Oct 09:40–10:00 UTC with `services/verifier/src/tw1-live.ts` from inside the public verifier
(same key, same envelope store), through the Trustless Work **V1** testnet API: the self-service key from
dapp.trustlesswork.com is a V1 credential, and V2 keys are issued by their backoffice. Milestones are
10 USDC and 2 USDC because the Circle faucet gives 20 USDC per two hours; the conditions committed on-chain
(`examples/*/condition.testnet.json`) name the real testnet accounts.

| Step | Lendoor · Ana's washing machine, 10 USDC to the store | Piggy · Sasha's bed, 2 USDC to Sasha |
|---|---|---|
| Escrow contract | [`CDGQRKMQ…U6WJ7W`](https://stellar.expert/explorer/testnet/contract/CDGQRKMQHLROLX6L6FW6VQQI7BQXRCKQ7IDJUN5QZLUTZQR2E3U6WJ7W) | [`CCTXZHRD…J7UY4H`](https://stellar.expert/explorer/testnet/contract/CCTXZHRDGY5TSIUONXZK6MVKONPXONKM4GMXOIEJHH4UVL323YJ7UY4H) |
| Deploy, with `conditionHash` in the milestone | [`a006801c…`](https://stellar.expert/explorer/testnet/tx/a006801cb980499b8e77f87bfa176fb4af557e2b3f0bf28164b25013b74b79a7) | [`809e2b42…`](https://stellar.expert/explorer/testnet/tx/809e2b42ffb00a96472f427aae8763d4dae4c1d27acacd20f21bd13c89785150) |
| Fund | [`c2a79c8b…`](https://stellar.expert/explorer/testnet/tx/c2a79c8b2a1c537346aca8285b440480faafa501188419a21adc63d3bf081e38) | [`2fd9c340…`](https://stellar.expert/explorer/testnet/tx/2fd9c3404e4385a5c7edf4699721e7445ffe5a2ed43be68ad088ee74fb136064) |
| Verdict (real photo, Claude reading, rules deciding) | **ALLOW**, score 95, 10/10 criteria. Envelope [`839df0a1…`](https://hackmeridian.api.lendoor.xyz/envelopes/839df0a154d7056b76c61a4eade55915237d85d0e4c1e4558672b6407cc3b7f5) | pending a photo of the bed |
| Anchor line written in the milestone evidence | [`3e10e6dd…`](https://stellar.expert/explorer/testnet/tx/3e10e6dd16290bff1ea81eaffe0426891bfe40cd536ed30cf1f52f8e3bf46725) | — |
| Approve + release, signed by the verifier key | [`12b3d6a0…`](https://stellar.expert/explorer/testnet/tx/12b3d6a072977670db663516d988b7a197c4fadf362e2ec6d80eedf05ad6644f) · [`b926a776…`](https://stellar.expert/explorer/testnet/tx/b926a776191a857333f3fa17683a05ce8e49321e99f86de93e2b3892c59c4461) | — |
| Receiver balance after | store `GDJVBJGJ…` 9.97 USDC (0.30 % Trustless Work fee) | — |

**The verifier refusing, on-chain.** The first Lendoor attempt committed the example condition, whose
`receiver` is a placeholder address, so the escrow paid someone the condition did not name. The invoice
read fine (every semantic criterion passed, 9/10 overall) and the verdict was still **DENY · DESTINATION_MISMATCH**, anchored
in escrow [`CCX5JWHY…AV76UFJ`](https://stellar.expert/explorer/testnet/contract/CCX5JWHYM6HELA6WIBNKEBDK4TDHCLW7DZ2KOR7XYUEAJZT2PAV76UFJ)
([anchor tx](https://stellar.expert/explorer/testnet/tx/20f3a5008f5c755b39265089946aed739a7e29f251ef9fb3c7e4de5eee6721d1),
envelope [`0c9aa005…`](https://hackmeridian.api.lendoor.xyz/envelopes/0c9aa005d3f1ac1ff365c623dd6be0acfd4ff4e19406b1979a705702e2681b43)).
Nothing moved. The funds came back the way the lifecycle says they do: the verifier
[disputed](https://stellar.expert/explorer/testnet/tx/1905b06567ec370e3c6b06273fd85ddd73939788b6be8d4c52c7b64ed74c15dd)
the milestone and the dispute resolver
[returned 9.97 USDC to the payer](https://stellar.expert/explorer/testnet/tx/2eff0eeb18934427839ee135d15c36e08421ec48294461d30e24bb98f1dbef66)
(0.03 USDC is Trustless Work's fee; the funding of that escrow is
[`bd8e4ad5…`](https://stellar.expert/explorer/testnet/tx/bd8e4ad5a9b49edd4f2ec323fb434c732dd179009758c8d7768ff585341bdafd)).

Verifier (release signer, in `approvers` + `releaseSigners` + `serviceProviders` of both escrows): the key
the public service signs with, reported by its `/health` and carried by every envelope it signs; on 26 Oct
that is [`GC32JANEEDIR5CZ47Z3GZKAHD36KHZXODHKKKMQLSAJZOPD7ICYVJMHR`](https://stellar.expert/explorer/testnet/account/GC32JANEEDIR5CZ47Z3GZKAHD36KHZXODHKKKMQLSAJZOPD7ICYVJMHR).
The role layout per escrow is in [`docs/contracts.md` §8](docs/contracts.md). Tx links go to
`https://stellar.expert/explorer/testnet/tx/<hash>`.
**The hashes in `examples/*/facts.json`, `examples/*/evidence.json` and in the tests are synthetic fixtures**
for the offline demo (`111…`, `222…`, `ESCROW-DEMO-0001`); the real ones are in the table above and the
conditions committed on-chain are `examples/*/condition.testnet.json`.

## Built at HackMeridian vs prior work

**Built here (25–26 Oct 2026, every commit in this repo):** everything in this repository — condition
schema and hashing, both verifiers, the underwriter, the signed envelope, anchoring, lifecycle,
disputes, the verifier service, tests, CI, docs. First commit 25 Oct 13:56 UTC.

**Prior work by the same team:** [lendoor-stellar](https://github.com/LuchoLeonel/lendoor-stellar)
(Soroban loan manager, SCF #45): none of its code is in this repository; during the hack a Witness
verification screen was added to that app, and that is what `https://hackmeridian.lendoor.xyz` serves.
[lenclaw](https://github.com/fabian416/lenclaw) (agent credit on Base, March 2026): the "model reads, rules
decide" pattern comes from it; no code does.

**Status of the escrow integration:** the testnet run above went through the Trustless Work V1 API with
`services/verifier/src/tw1-live.ts` (deploy, fund, verify, anchor, approve, release; `tw1-op.ts` for dispute
and resolve). The V2 client (`services/verifier/src/trustless-work.ts`, used by the service with `ESCROW=tw`)
is implemented against the V2 OpenAPI and tested against a fake of that API, signatures included, but has
not run against testnet: V2 credentials are issued by Trustless Work's backoffice, not self-service. The
OpenZeppelin smart-account release signer is roadmap: both APIs build every transaction with a `G` wallet as
source, so a contract account cannot release through them today.

## Layout

| Path | What |
|---|---|
| `packages/core` | Condition (purchase / task, `settlement.role`), RFC 8785 canonicalization and sha256, criteria and `decide()`, deterministic escrow checks, Lendoor underwriter, signed `VerificationEnvelope`, anchoring, milestone lifecycle, dispute case. Pure TypeScript. |
| `packages/semantic` | Claude with structured outputs: invoice reader (purchases) and task-photo reader (chores); the trigger agent (payer's words → condition draft); `cli.ts` (one verdict) and `verify-cli.ts` (re-verify an anchored envelope). |
| `services/verifier` | The verifier as its own process with its own key: `underwrite`, `verify`, content-addressed `GET /envelopes/:sha256` (the anchor target), challenges. Escrow behind `EscrowClient`: in-memory for the demo, Trustless Work V2 (`trustless-work.ts`) with `ESCROW=tw`. `tw-deploy.ts` deploys and funds an escrow from `examples/*/escrow.json` with the `conditionHash` in the milestone. |
| `examples/lendoor`, `examples/piggy` | The deck's two flows, synthetic, plus `escrow.json` (the V2 deploy spec) and `condition.testnet.json` (the conditions committed on-chain, real testnet accounts). |
| `demo` | One page that takes the photo and shows the verdict next to what the model read (Vite + React), by Lucho. |
| `docs/contracts.md` | The JSON objects the backend and the verifier exchange, endpoints, lifecycle (Spanish). |
| `scripts/demo.sh` | Five verdicts, five re-verifications, offline. |
| `Dockerfile`, `.github/workflows/ci.yml` | Container for the service; typecheck, tests and the demo on every push. |

## Setup

Prerequisites: Node ≥ 24 and pnpm 10 (`corepack enable`).

```bash
pnpm install
pnpm typecheck && pnpm test          # 113 tests
./scripts/demo.sh                     # offline: five signed envelopes in ./out, all re-verified

# one live verdict on a photo (needs ANTHROPIC_API_KEY)
node packages/semantic/src/cli.ts --condition examples/lendoor/condition.json --facts examples/lendoor/facts.json \
  --evidence examples/lendoor/evidence.json --photo examples/lendoor/factura-ok.jpg --fx ARS=1450
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
| `CORS_ORIGINS` | Comma-separated browser origins allowed to call the service directly. Normally a product backend calls it, not a page; the demo page is the exception and names itself here | none |
| `ESCROW` | `memory` or `tw` (Trustless Work V2; needs `TW_API_KEY`, optional `TW_BASE_URL` and `STELLAR_NETWORK_PASSPHRASE`, testnet by default) | `memory` |
| `DATA_DIR`, `PORT` | Envelope and case store; listen port | `./data`, `8787` |

Why a separate process: if the service that funds the escrow also signed releases, the payer would be
releasing to itself. Separate keys make the role split checkable on-chain.

### Deploy and fund the escrows (Trustless Work V2 path, not yet exercised on testnet)

The 26 Oct run used `services/verifier/src/tw1-live.ts` against the V1 API (the self-service testnet key is
V1); this is the equivalent for V2, once Trustless Work issues a V2 credential.

```bash
# the deployer signs deploy and fund: XLM for fees, a USDC trustline with balance to fund
# VERIFIER = the key the service signs with (GET /health .verifier), GC32JANE…JMHR on 26 Oct
TW_API_KEY=<id>.<secret> DEPLOYER_SECRET=S... VERIFIER=GC32JANEEDIR5CZ47Z3GZKAHD36KHZXODHKKKMQLSAJZOPD7ICYVJMHR \
RESOLVER=G... ADMIN=G... RECEIVER=G... \
node services/verifier/src/tw-deploy.ts examples/lendoor/escrow.json --condition examples/lendoor/condition.json --fund
```

It prints the `contractId` (the `agreementId` of every envelope), the deploy and fund tx hashes and the
explorer links, and refuses to continue if the milestone description on-chain does not carry the
`conditionHash`. Then run the service with `ESCROW=tw`, `AUTO_RELEASE=1`, `API_TOKEN`, `PUBLIC_URL` and the
same `VERIFIER_SECRET`, and `POST /agreements/<contractId>/milestones/1/verify` with the photo.

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

## Where to look, by rubric

| Criterion | Where it is |
|---|---|
| Ecosystem alignment | Trustless Work escrows (their research vocabulary for the envelope), Stellar testnet USDC, two SCF projects adopting it (Piggy Wallet #41, Lendoor #45); roadmap on OpenZeppelin Stellar smart accounts in `docs/contracts.md` §8. |
| User value | Piggy: allowance paid on proof of the chore. Lendoor: partner capital paid to the store on proof of the invoice, with a verdict the funder can audit without trusting Lendoor. Both flows in `examples/`. |
| Technical | `packages/core` (hashing, criteria, lifecycle, signed envelope), `packages/semantic` (model reads, code decides, injection tests), `services/verifier` (service, Trustless Work clients), 113 tests, CI, live run scripts. |
| Innovation | The verdict is signed by the escrow's own release key and anchored in the milestone, so the release and the reason for it are the same verifiable object; the model never sees the cap or the policy. |
| Progress during the hack | [Commit history](https://github.com/fabian416/witness/commits/main), first commit 25 Oct 13:56 UTC; [CI green on every push](https://github.com/fabian416/witness/actions); on-chain evidence produced 26 Oct 09:40–10:00 UTC. |
| Market | Two live products with users and SCF grants on both sides of the same gap. |
| UX | `demo/` and the demo site: photo in, what the model read next to what the code decided, verdict and envelope out. |

## License

Apache-2.0. 21 of 22 commits carry a DCO `Signed-off-by`; the demo-page commit `b71599d` was pushed
without the trailer and its author signs it off retroactively.
