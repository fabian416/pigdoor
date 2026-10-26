# HackMeridian 2026 submission draft (app.hackmeridian.com, Mon 26 Oct 12:00 Lisbon)

Everything below is copy-ready except the fields marked *pending*. Keep the claims as written: they are
what the repository can show.

**Project name:** Witness

**One line:** Proof before payment: a verification layer that reads the evidence, decides by rules, signs
the verdict with the key that releases the escrow, and anchors it on-chain.

**Category:** Scale. **Teams:** Piggy Wallet (SCF #41) × Lendoor (SCF #45).

**Team:** Lucho (CEO Lendoor), Fabián Díaz (CTO Lendoor), Sofía Vásquez (CEO Piggy Wallet).

**Repository:** https://github.com/fabian416/witness (Apache-2.0, every commit DCO signed-off). *Make it
public before submitting.*

**Demo page:** https://hackmeridian.lendoor.xyz · **Verifier API:** https://hackmeridian.api.lendoor.xyz
(`/health`). **Video:** *pending*.

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
- **Trustless Work V2 client**: escrow and deposit trail → facts; anchor, approve-and-release, dispute;
  signs the XDR the API returns. Deploy script for the two escrows with the role layout in
  `docs/contracts.md` §8.
- Verifier service (Hono), 113 tests, CI, Dockerfile, prompt-injection tests, offline demo script.

## Live evidence

- Two real verdicts on invoice photos through the public verifier (ALLOW 93 on the right invoice, DENY on a
  supermarket receipt), anchored and re-verifiable: anchor lines in the README.
- On-chain (Stellar testnet, Trustless Work multi-release V2): *pending* — contract ids, deploy/fund/release
  tx hashes go in the README table.

## Stellar usage

Trustless Work multi-release escrow V2 on Stellar testnet (USDC, Circle issuer). Verifier key as
`approvers` + `releaseSigners` + `serviceProviders`; dispute resolver and admin separate; `conditionHash` in
the milestone description; verdict anchored in the milestone evidence; releases via
`approve-and-release-milestones`, signed with the verifier key. ed25519 signatures with Stellar keypairs so
the verdict signer and the on-chain release signer are the same address.

## Prior work vs built here

Prior work by the same team, not used here: credit delegation in lendoor-stellar (Soroban loan manager,
SCF #45) and lenclaw (agent credit on Base). Only the "model reads, rules decide" pattern comes from
lenclaw; no code does.

## Next steps

Run the two escrows on testnet end to end with the team's API key (client and script are ready); harden the
release signer with a 2-of-2 approval (`approvalsTarget`) and, after the hackathon, an OpenZeppelin smart
account with a spending policy as release signer (the V2 API signs with G wallets today); SCF continuation
for both products.
