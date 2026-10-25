import { Hono } from "hono";
import { z } from "zod";
import {
  ConditionSchema,
  DEFAULT_POLICY,
  EvidenceItemSchema,
  Keypair,
  SettlementRole,
  anchorReference,
  applyAction,
  checkDeterministic,
  checkUnderwriting,
  conditionHash,
  decide,
  formatAnchorReference,
  nextStep,
  openDispute,
  sha256Hex,
  signEnvelope,
  type CriterionResult,
  type MilestoneState,
} from "@witness/core";
import {
  assessReading,
  bindCondition,
  draftCondition,
  evaluateDocument,
  readingSchemaFor,
  scoreReading,
  type StructuredModel,
} from "@witness/semantic";
import type { EscrowClient } from "./escrow-client.ts";
import type { Store } from "./store.ts";

export interface AppConfig {
  /** Stellar keypair of the verifier; its public key is the releaseSigner on the escrow. */
  verifierKey: Keypair;
  /** Lendoor's underwriter key, if separate. "releaseSigner: PIGGY_AI_VERIFIER -> LENDOOR_UNDERWRITER": one address each. */
  underwriterKey?: Keypair;
  escrow: EscrowClient;
  store: Store;
  /** The semantic model. Undefined means "no credentials": only precomputed readings are accepted. */
  model?: StructuredModel;
  /** Public base URL of this service, used as the anchor uri. */
  publicUrl: string;
  /** Execute the release on ALLOW instead of only reporting it. */
  autoRelease: boolean;
  /** Clock, injectable for tests. */
  now?: () => string;
  /**
   * Accept client-supplied document readings instead of a photo. Demo only:
   * with this on and autoRelease on, whoever reaches the service can release
   * money by posting a reading that says PASS. Refused when autoRelease is on.
   */
  acceptReadings?: boolean;
  /** Shared bearer token the product backend must present. Unset means open (local dev only). */
  apiToken?: string;
}

const VerifyBody = z.object({
  condition: ConditionSchema,
  evidence: z.array(EvidenceItemSchema).min(1),
  image: z.object({ base64: z.string().min(1), mediaType: z.enum(["image/jpeg", "image/png", "image/webp", "image/gif"]) }).optional(),
  /** A DocumentReading or a TaskReading, validated against the condition kind. Demo mode only. */
  reading: z.unknown().optional(),
  fx: z.object({ currency: z.string(), unitsPerAsset: z.number().positive() }).optional(),
  /** Current escrow status as the backend knows it. */
  status: z.enum(["FUNDED", "DISPUTED"]).default("FUNDED"),
});

const DraftBody = z.object({
  text: z.string().min(1),
  payer: z.string(),
  receiver: z.string(),
  asset: z.object({ code: z.string(), issuer: z.string() }),
  settlementRole: SettlementRole,
  defaultDeadline: z.iso.datetime(),
});

const UnderwriteBody = z.object({
  condition: ConditionSchema,
  facts: z.object({
    score: z.number().int().min(0).max(1000),
    kycOk: z.boolean(),
    kycValidUntil: z.iso.datetime(),
    approvedLimit: z.string(),
    outstanding: z.string(),
    evaluatedAt: z.iso.datetime(),
  }),
  policy: z.object({ minScore: z.number().int(), maxDisbursement: z.string(), version: z.string().min(1) }),
});

const ChallengeBody = z.object({
  openedBy: z.enum(["payer", "receiver"]),
  note: z.string().min(1),
  evidenceLinks: z.array(z.object({ sha256: z.string(), url: z.string() })).default([]),
  /** The condition the envelope was built for; the resolver needs it next to the verdict. */
  condition: ConditionSchema,
});

export function createApp(config: AppConfig) {
  if (config.acceptReadings && config.autoRelease) {
    throw new Error("acceptReadings cannot be combined with autoRelease: a posted reading could release funds");
  }
  const now = config.now ?? (() => new Date().toISOString());
  const app = new Hono();

  // Every write needs the backend's token; reads (health, anchored envelopes, cases) stay public on purpose.
  app.use("*", async (c, next) => {
    if (c.req.method === "GET" || !config.apiToken) return next();
    if (c.req.header("authorization") !== `Bearer ${config.apiToken}`) return c.json({ error: "unauthorized" }, 401);
    return next();
  });

  app.get("/health", (c) =>
    c.json({
      ok: true,
      verifier: config.verifierKey.publicKey(),
      model: Boolean(config.model),
      autoRelease: config.autoRelease,
      acceptReadings: Boolean(config.acceptReadings),
      authenticated: Boolean(config.apiToken),
    }),
  );

  /** Natural language -> frozen condition. Addresses come from the caller, never from the model. */
  app.post("/conditions", async (c) => {
    if (!config.model) return c.json({ error: "no model credentials configured" }, 503);
    const body = DraftBody.safeParse(await c.req.json());
    if (!body.success) return c.json({ error: body.error.issues }, 400);
    const drafted = await draftCondition(config.model, body.data.text, now().slice(0, 10));
    if (!drafted.ok) return c.json({ error: drafted.code, message: drafted.message }, 502);
    try {
      const condition = bindCondition(drafted.draft, { ...body.data, notBefore: now(), sourceText: body.data.text });
      return c.json({ condition, conditionHash: conditionHash(condition), draft: drafted.draft });
    } catch (error) {
      return c.json({ error: "draft does not form a valid condition", detail: String(error), draft: drafted.draft }, 422);
    }
  });

  /**
   * Lendoor's underwriter: score plus policy, signed for the partner who funds
   * the book. Runs before funding; same envelope, milestoneId "underwriting".
   */
  app.post("/agreements/:agreementId/underwrite", async (c) => {
    const { agreementId } = c.req.param();
    const body = UnderwriteBody.safeParse(await c.req.json());
    if (!body.success) return c.json({ error: body.error.issues }, 400);
    const { condition, facts, policy } = body.data;
    const key = config.underwriterKey ?? config.verifierKey;
    const criteria = checkUnderwriting(condition, facts, policy);
    const envelope = signEnvelope(
      {
        agreementId,
        milestoneId: "underwriting",
        verifier: key.publicKey(),
        verifierType: "platform",
        criteria,
        evidence: [],
        verdict: decide(criteria, undefined, { ...DEFAULT_POLICY, policyVersion: policy.version }),
        timestamp: now(),
        conditionHash: conditionHash(condition),
      },
      key,
    );
    const { id } = config.store.putEnvelope(envelope);
    const anchor = formatAnchorReference(anchorReference(envelope, `${config.publicUrl}/envelopes/${id}`));
    return c.json({ id, envelope, anchor, fundable: envelope.verdict.decision === "ALLOW" });
  });

  /** Both verifiers, one signed envelope, the next step. */
  app.post("/agreements/:agreementId/milestones/:milestoneId/verify", async (c) => {
    const { agreementId, milestoneId } = c.req.param();
    const body = VerifyBody.safeParse(await c.req.json());
    if (!body.success) return c.json({ error: body.error.issues }, 400);
    const { condition, evidence, fx, status } = body.data;

    let facts;
    try {
      facts = await config.escrow.getMilestoneFacts(agreementId, milestoneId);
    } catch (error) {
      return c.json({ error: "escrow lookup failed", detail: String(error) }, 502);
    }

    let semantic: CriterionResult[];
    let score: number | undefined;
    if (body.data.reading && !config.acceptReadings) {
      return c.json({ error: "precomputed readings are not accepted; send the image" }, 403);
    }
    if (body.data.image) {
      if (!config.model) return c.json({ error: "no model credentials configured" }, 503);
      // The envelope must name the bytes the model actually looked at.
      const imageHash = sha256Hex(Buffer.from(body.data.image.base64, "base64"));
      if (!evidence.some((e) => e.sha256 === imageHash)) {
        return c.json({ error: "image hash does not match any evidence item", imageHash }, 422);
      }
      const outcome = await evaluateDocument(config.model, { condition, image: body.data.image, fx });
      semantic = outcome.criteria;
      score = outcome.score;
    } else if (body.data.reading) {
      const parsed = readingSchemaFor(condition).safeParse(body.data.reading);
      if (!parsed.success) return c.json({ error: `reading does not match a ${condition.kind} condition`, issues: parsed.error.issues }, 400);
      semantic = assessReading(condition, parsed.data, fx);
      score = scoreReading(parsed.data, semantic);
    } else {
      return c.json({ error: "send image (or reading, in demo mode)" }, 400);
    }

    const criteria = [...checkDeterministic(condition, facts), ...semantic];
    const verdict = decide(criteria, score);
    const envelope = signEnvelope(
      {
        agreementId,
        milestoneId,
        verifier: config.verifierKey.publicKey(),
        verifierType: "automated_agent",
        criteria,
        evidence,
        verdict,
        timestamp: now(),
        conditionHash: conditionHash(condition),
      },
      config.verifierKey,
    );

    const { id } = config.store.putEnvelope(envelope);
    const anchor = formatAnchorReference(anchorReference(envelope, `${config.publicUrl}/envelopes/${id}`));
    await config.escrow.writeAnchor(agreementId, milestoneId, anchor);

    let state: MilestoneState = { status, verdict };
    const step = nextStep(condition, state, now());
    let release: { txHash: string } | undefined;
    if (step.action === "RELEASE" && config.autoRelease) {
      release = await config.escrow.releaseMilestone(agreementId, milestoneId);
      state = applyAction(state, "RELEASE");
    } else if (step.action === "ESCALATE") {
      await config.escrow.disputeMilestone(agreementId, milestoneId, verdict.reasons.join(","));
      state = applyAction(state, "ESCALATE");
    }

    return c.json({ id, envelope, anchor, nextStep: step, status: state.status, release });
  });

  /** The anchor target: exact canonical bytes, content-addressed. */
  app.get("/envelopes/:id", (c) => {
    const bytes = config.store.getEnvelopeBytes(c.req.param("id"));
    if (!bytes) return c.json({ error: "not found" }, 404);
    return c.body(bytes, 200, { "content-type": "application/json" });
  });

  app.get("/envelopes", (c) => c.json({ ids: config.store.listEnvelopeIds() }));

  /** A party disputes a verdict: the resolver gets a full case. */
  app.post("/envelopes/:id/challenge", async (c) => {
    const bytes = config.store.getEnvelopeBytes(c.req.param("id"));
    if (!bytes) return c.json({ error: "not found" }, 404);
    const body = ChallengeBody.safeParse(await c.req.json());
    if (!body.success) return c.json({ error: body.error.issues }, 400);
    const envelope = JSON.parse(bytes);

    const disputeCase = openDispute({
      condition: body.data.condition,
      envelope,
      openedAt: now(),
      openedBy: body.data.openedBy,
      trigger: "CHALLENGE",
      evidenceLinks: body.data.evidenceLinks,
      challengeNote: body.data.note,
    });
    await config.escrow.disputeMilestone(envelope.agreementId, envelope.milestoneId, `challenge by ${body.data.openedBy}`);
    const caseId = config.store.putCase(disputeCase);
    return c.json({ caseId, case: disputeCase });
  });

  app.get("/cases/:id", (c) => {
    const found = config.store.getCase(c.req.param("id"));
    return found ? c.json(found) : c.json({ error: "not found" }, 404);
  });

  return app;
}
