#!/usr/bin/env node
/**
 * Checks an anchored verdict the way a third party would: from the reference
 * string written into the escrow, or from a local file.
 *
 *   node packages/semantic/src/verify-cli.ts "verdict-v1 sha256=<hex> uri=ipfs://<cid>" \
 *     [--agreement C... --milestone 1 --condition-hash <hex> --verifier G... --gateway https://...]
 *   node packages/semantic/src/verify-cli.ts envelope.json
 *
 * Exit code 0 when the envelope verifies, 1 when it does not.
 */
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { anchorReference, parseAnchorReference, resolveEnvelope, verifyEnvelope, VerificationEnvelopeSchema } from "@witness/core";

const { values: args, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    agreement: { type: "string" },
    milestone: { type: "string" },
    "condition-hash": { type: "string" },
    verifier: { type: "string" },
    gateway: { type: "string" },
  },
});

const source = positionals[0];
if (!source) {
  console.error("usage: verify-cli <anchor reference | path to envelope.json>");
  process.exit(2);
}

const expect = {
  agreementId: args.agreement,
  milestoneId: args.milestone,
  conditionHash: args["condition-hash"],
  verifier: args.verifier,
};

const ref = parseAnchorReference(source);
const result = ref
  ? await resolveEnvelope(ref, { ipfsGateway: args.gateway, expect })
  : (() => {
      const parsed = JSON.parse(readFileSync(source, "utf8"));
      const check = verifyEnvelope(parsed);
      if (!check.ok) return check;
      const envelope = VerificationEnvelopeSchema.parse(parsed);
      return { ok: true as const, envelope, bytes: "" };
    })();

if (!result.ok) {
  console.error(`INVALID: ${result.reason}`);
  process.exit(1);
}

const e = result.envelope;
console.log(`VALID  ${e.verdict.decision}  reasons=${e.verdict.reasons.join(",")}  score=${e.verdict.semanticScore ?? "-"}`);
console.log(`agreement ${e.agreementId}  milestone ${e.milestoneId}`);
console.log(`verifier  ${e.verifier} (${e.verifierType})  at ${e.timestamp}`);
console.log(`condition ${e.conditionHash}`);
console.log(`proof     ${e.proofHash}`);
console.log(`criteria  ${e.criteria.filter((c) => c.result === "PASS").length}/${e.criteria.length} pass`);
if (!ref) console.log(`anchor    ${anchorReference(e, "<uri>").sha256}  (sha256 to write into the escrow)`);
