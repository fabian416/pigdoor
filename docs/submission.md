# HackMeridian 2026 submission draft (app.hackmeridian.com, Mon 26 Oct 12:00 Lisbon)

Everything below is copy-ready except the fields marked *pending*. Keep the claims as written: they are
what the repository can show.

**Project name:** Witness

**One line:** Proof before payment: a verification layer that reads the evidence, decides by rules, signs
the verdict with the key that releases the escrow, and anchors it on-chain.

**Category:** Scale. **Teams:** Piggy Wallet (SCF #41) × Lendoor (SCF #45).

**Team:** Lucho (CEO Lendoor), Fabián Díaz (CTO Lendoor), Sofía Vásquez (CEO Piggy Wallet).

**Repository:** https://github.com/fabian416/witness (Apache-2.0; DCO sign-off on 21 of 22 commits, see
README › License).

**Demo:** https://hackmeridian.lendoor.xyz (Lendoor's testnet app, prior work, with the Witness verification
screen added during the hack) and the standalone page in `demo/` · **Verifier API:**
https://hackmeridian.api.lendoor.xyz (`/health`). **Video:** *pending*.

## The problem

Escrow already exists on Stellar; proving the condition does not. Trustless Work's own research note on
evidence-gated release lists what their pilot does not establish: that the evidence is true or complete.
Two products hit this for different reasons. Piggy: the allowance when the chore is done; today a parent
checks by hand or pays first. Lendoor: the partner's capital when underwriting says yes, paid to the store
against the invoice; partners fund the book and need to audit each decision without trusting Lendoor.

## What we built (25–26 Oct, all of it in this repo)

- **Condition** (purchase or task) frozen before funds move: canonical JSON (RFC 8785) → sha256 written in
  the escrow milestone. The trigger agent drafts it from the payer's words; addresses, asset and settlement
  role are bound by the app, never by the model.
- **Deterministic verifier**: committed condition, funded, destination, amount cap, window, read from the
  escrow, never from the caller.
- **Semantic verifier**: Claude extracts fields from the photo under a strict JSON schema (merchant, items,
  date, total; or task visible / done / staging signs). Code compares. The model never sees the cap or the
  policy, never computes the score, never decides.
- **Lendoor underwriter**: score, KYC, credit line, policy, signed before funding with its own key.
- **Signed VerificationEnvelope** (Trustless Work's research vocabulary, plus `conditionHash`), ed25519 by
  the verifier key, content-addressed, anchored as one line in the milestone evidence:
  `verdict-v1 sha256=<hex> uri=<GET /envelopes/:sha256>`. Anyone re-verifies with `verify-cli`.
- **Lifecycle and disputes**: ALLOW → approve-and-release; DENY → nothing moves, reasons shown; REVIEW →
  dispute for the human resolver; deadline → the resolver refunds (no time-based refund in the contract).
- **Trustless Work integration**: the live testnet run through the V1 API (`tw1-live.ts`: deploy, fund,
  verify, anchor, approve, release; `tw1-op.ts`: dispute, resolve), and a V2 client (escrow and deposit trail
  → facts; anchor, approve-and-release, dispute; signs the XDR the API returns) tested against a fake of the
  V2 API. Role layout in `docs/contracts.md` §8.
- Verifier service (Hono), 113 tests, CI, Dockerfile, prompt-injection tests, offline demo script.

## Live evidence

- Two real verdicts on invoice photos through the public verifier (ALLOW 93 on the right invoice, DENY on a
  supermarket receipt), anchored and re-verifiable: anchor lines in the README.
- On-chain (Stellar testnet, Trustless Work multi-release escrows, USDC), all links in the README table:
  Lendoor escrow `CDGQRKMQHLROLX6L6FW6VQQI7BQXRCKQ7IDJUN5QZLUTZQR2E3U6WJ7W` deployed with the conditionHash,
  funded 10 USDC, real invoice read by the model, ALLOW anchored in the milestone evidence, approved and
  released by the verifier key, store paid. A first attempt with a mismatched receiver was refused
  (DENY · DESTINATION_MISMATCH) and refunded through dispute + resolver. Piggy escrow
  `CCTXZHRDGY5TSIUONXZK6MVKONPXONKM4GMXOIEJHH4UVL323YJ7UY4H` deployed and funded (2 USDC), release pending a
  photo.

## Stellar usage

Trustless Work multi-release escrows on Stellar testnet (USDC, Circle issuer), deployed, funded, anchored,
approved and released through their V1 API (`services/verifier/src/tw1-live.ts`; the self-service testnet key
is V1). Verifier key as approver + releaseSigner + serviceProvider, dispute resolver a separate key;
`conditionHash` in the milestone description; verdict anchored in the milestone evidence; approve and
release are two transactions signed with the verifier key. The V2 client (plural roles, admin,
`approve-and-release-milestones`) is implemented and tested against a fake of the V2 OpenAPI, not yet run:
V2 credentials are issued by Trustless Work's backoffice. ed25519 signatures with Stellar keypairs, so the
verdict signer and the on-chain release signer are the same address.

## Prior work vs built here

Prior work by the same team, not used here: credit delegation in lendoor-stellar (Soroban loan manager,
SCF #45) and lenclaw (agent credit on Base). Only the "model reads, rules decide" pattern comes from
lenclaw; no code does.

## Next steps

Close the Piggy release on-chain with a photo of the chore (escrow already funded); move the service's live
path to the V2 API once Trustless Work issues the credential (client implemented and tested); harden the
release signer with a 2-of-2 approval (`approvalsTarget`) and, after the hackathon, an OpenZeppelin smart
account with a spending policy as release signer (both APIs sign with G wallets today); SCF continuation for
both products.
