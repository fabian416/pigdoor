#!/usr/bin/env node
/**
 * Runs both verifiers on one agreement and prints the signed VerificationEnvelope.
 *
 *   node packages/semantic/src/cli.ts \
 *     --condition cond.json --facts facts.json --evidence evidence.json \
 *     --photo remito.jpg            # live model (needs Anthropic credentials)
 *     --reading reading.json        # or: a precomputed DocumentReading, no model call
 *     [--agreement C... --milestone 1 --verifier-secret S... --fx ARS=1450]
 *
 * The envelope goes to stdout as JSON; a human summary goes to stderr.
 */
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import {
  ConditionSchema,
  Keypair,
  EvidenceItemSchema,
  checkDeterministic,
  conditionHash,
  decide,
  signEnvelope,
  type CriterionResult,
  type EscrowFacts,
} from "@workspace/core";
import { anthropicModel, type ImageMediaType } from "./model.ts";
import { DocumentReadingSchema, assessReading, evaluateDocument, scoreReading } from "./semantic.ts";

const { values: args } = parseArgs({
  options: {
    condition: { type: "string" },
    facts: { type: "string" },
    evidence: { type: "string" },
    photo: { type: "string" },
    reading: { type: "string" },
    agreement: { type: "string", default: "pending" },
    milestone: { type: "string", default: "1" },
    "verifier-secret": { type: "string" },
    fx: { type: "string" },
    model: { type: "string" },
  },
});

function need(name: "condition" | "facts" | "evidence"): string {
  const v = args[name];
  if (!v) {
    console.error(`missing --${name}`);
    process.exit(2);
  }
  return v;
}

const readJson = (path: string) => JSON.parse(readFileSync(path, "utf8"));

const condition = ConditionSchema.parse(readJson(need("condition")));
const facts = readJson(need("facts")) as EscrowFacts;
const evidence = EvidenceItemSchema.array().parse(readJson(need("evidence")));

const fx = args.fx
  ? (() => {
      const [currency, rate] = args.fx!.split("=");
      return { currency, unitsPerAsset: Number(rate) };
    })()
  : undefined;

const deterministic = checkDeterministic(condition, facts);

let semantic: CriterionResult[];
let score: number | undefined;
if (args.reading) {
  const reading = DocumentReadingSchema.parse(readJson(args.reading));
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
  console.error("need --photo or --reading");
  process.exit(2);
}

const criteria = [...deterministic, ...semantic];
const verdict = decide(criteria, score);

const verifierKey = args["verifier-secret"] ? Keypair.fromSecret(args["verifier-secret"]) : Keypair.random();
if (!args["verifier-secret"]) console.error(`ephemeral verifier key ${verifierKey.publicKey()} (pass --verifier-secret to use yours)`);

const envelope = signEnvelope(
  {
    agreementId: args.agreement!,
    milestoneId: args.milestone!,
    verifier: verifierKey.publicKey(),
    verifierType: "automated_agent",
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
  console.error(`${mark} ${c.verifier.padEnd(13)} ${c.id.padEnd(24)} ${c.code.padEnd(24)} ${c.reason}`);
}
console.error(`\nverdict: ${verdict.decision}  reasons: ${verdict.reasons.join(", ")}  score: ${score ?? "-"}`);
console.log(JSON.stringify(envelope, null, 2));
