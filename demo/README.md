# demo

One page. Point a camera at an invoice, watch the rules decide, see the signed envelope.

No wallet, no login, no testnet funds. The demo exists to show the verification, so
everything that is not the verification was left out.

## What it shows, in order

1. **The condition**, as it was committed. Who gets paid, the cap, the window, what the
   evidence must show. This is hashed before any money moves.
2. **The evidence.** The camera, or a file if there is no camera. The page computes the
   sha256 of the exact bytes and puts it in the evidence item, because the service refuses
   an image whose hash does not match one (`422`). That binding is the point, not a detail.
3. **What the model read.** Typed fields, nothing else. No verdict, no arithmetic. The
   model never receives the cap or the policy.
4. **What the code decided.** Every criterion, pass or fail, with its reason code.
5. **The verdict**, with the signed envelope and the next step.

The refusal is the interesting one. Point it at an invoice from the wrong shop and the
deterministic checks still pass while the semantic ones do not.

## Run

```bash
# the verifier, in another terminal, from the repo root
ANTHROPIC_API_KEY=... pnpm --filter @witness/verifier-service start

# this page
pnpm --filter @witness/demo dev     # http://localhost:3000
```

| Env | Meaning | Default |
|---|---|---|
| `VITE_VERIFIER_URL` | Where the verifier service listens | `http://localhost:8787` |

## Without a model key

Start the service with `ACCEPT_READINGS=1` and use the two sample invoices under
**Sin cámara a mano**: one correct, one from another shop. The service runs the same rules
and signs the same envelope; only the model's eyes are canned. It refuses to combine
`ACCEPT_READINGS` with `AUTO_RELEASE`, because a posted reading must never be able to move
money.

## Build

```bash
pnpm --filter @witness/demo build     # dist/, ~150 kB js
pnpm --filter @witness/demo preview
```

## Where the look comes from

The colour tokens and the type pairing are lifted from
[lendoor-stellar](https://github.com/LuchoLeonel/lendoor-stellar) so the demo reads as part
of the same family. The tokens are copied into `src/styles.css`; no code from that project
is imported here. The app itself is new: React, two dependencies, one page.
