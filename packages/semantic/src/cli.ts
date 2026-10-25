#!/usr/bin/env node
/**
 * Runs the verifiers on one agreement and prints the signed VerificationEnvelope.
 *
 * Release verdict (deterministic + semantic, or semantic only for payee_prepaid):
 *   node packages/semantic/src/cli.ts --condition cond.json --facts facts.json --evidence evidence.json \
 *     --photo foto.jpg            # live model (needs Anthropic credentials)
 *     --reading reading.json      # or: a precomputed reading, no model call
 *     [--agreement C... --milestone 1 --verifier-secret S... --fx ARS=1450]
 *
 * Underwriting verdict (Lendoor, before funding):
 *   node packages/semantic/src/cli.ts --condition cond.json --underwriting underwriting.json [--agreement ...]
 *
 * The envelope goes to stdout as JSON; a human summary goes to stderr.
 */
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import {
  ConditionSchema,
  DEFAULT_POLICY,
  EvidenceItemSchema,
  Keypair,
  checkDeterministic,
  checkUnderwriting,
  conditionHash,
  decide,
  signEnvelope,
  type CriterionResult,
  type EscrowFacts,
  type EvidenceItem,
  type Verdict,
  type VerifierType,
} from "@witness/core";
import { anthropicModel, type ImageMediaType } from "./model.ts";
import { assessReading, evaluateDocument, readingSchemaFor, scoreReading } from "./semantic.ts";

const { values: args } = parseArgs({
  options: {
    condition: { type: "string" },
    facts: { type: "string" },
    evidence: { type: "string" },
    photo: { type: "string" },
    reading: { type: "string" },
    underwriting: { type: "string" },
    agreement: { type: "string", default: "pending" },
    milestone: { type: "string", default: "1" },
    "verifier-secret": { type: "string" },
    fx: { type: "string" },
    model: { type: "string" },
  },
});

const readJson = (path: string) => JSON.parse(readFileSync(path, "utf8"));
function fail(message: string): never {
  console.error(message);
  process.exit(2);
}

if (!args.condition) fail("missing --condition");
const condition = ConditionSchema.parse(readJson(args.condition));

let criteria: CriterionResult[];
let verdict: Verdict;
let evidence: EvidenceItem[] = [];
let milestoneId = args.milestone!;
let verifierType: VerifierType = "automated_agent";
let score: number | undefined;

if (args.underwriting) {
  const { facts, policy } = readJson(args.underwriting);
  criteria = checkUnderwriting(condition, facts, policy);
  verdict = decide(criteria, undefined, { ...DEFAULT_POLICY, policyVersion: policy.version });
  milestoneId = "underwriting";
  verifierType = "platform";
} else {
  if (!args.facts || !args.evidence) fail("missing --facts or --evidence");
  const facts = readJson(args.facts) as EscrowFacts;
  evidence = EvidenceItemSchema.array().parse(readJson(args.evidence));
  const fx = args.fx ? { currency: args.fx.split("=")[0], unitsPerAsset: Number(args.fx.split("=")[1]) } : undefined;

  let semantic: CriterionResult[];
  if (args.reading) {
    const reading = readingSchemaFor(condition).parse(readJson(args.reading));
    semantic = assessReading(condition, reading, fx);
    score = scoreReading(reading, semantic);
  } else if (args.photo) {
    const ext = args.photo.split(".").pop()?.toLowerCase();
    const mediaType: ImageMediaType = ext === "png" ? "image/png" : ext === "webp" ? "image/webp" : "image/jpeg";
    const image = { base64: readFileSync(args.photo).toString("base64"), mediaType };
    const outcome = await evaluateDocument(anthropicModel({ model: args.model }), { condition, image, fx });
    semantic = outcome.criteria;
    score = outcome.score;
    if (outcome.reading) console.error("reading:", JSON.stringify(outcome.reading, null, 2));
  } else {
    fail("need --photo, --reading or --underwriting");
  }
  criteria = [...checkDeterministic(condition, facts), ...semantic];
  verdict = decide(criteria, score);
}

const verifierKey = args["verifier-secret"] ? Keypair.fromSecret(args["verifier-secret"]) : Keypair.random();
if (!args["verifier-secret"]) console.error(`ephemeral verifier key ${verifierKey.publicKey()} (pass --verifier-secret to use yours)`);

const envelope = signEnvelope(
  {
    agreementId: args.agreement!,
    milestoneId,
    verifier: verifierKey.publicKey(),
    verifierType,
    criteria,
    evidence,
    verdict,
    timestamp: new Date().toISOString(),
    conditionHash: conditionHash(condition),
  },
  verifierKey,
);

for (const c of criteria) {
  const mark = c.result === "PASS" ? "ok  " : c.result === "FAIL" ? "FAIL" : "??? ";
  console.error(`${mark} ${c.verifier.padEnd(19)} ${c.id.padEnd(26)} ${c.code.padEnd(24)} ${c.reason}`);
}
console.error(`\nverdict: ${verdict.decision}  reasons: ${verdict.reasons.join(", ")}  score: ${score ?? "-"}`);
console.log(JSON.stringify(envelope, null, 2));
