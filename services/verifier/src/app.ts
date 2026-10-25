import { Hono } from "hono";
import { z } from "zod";
import {
  ConditionSchema,
  EvidenceItemSchema,
  Keypair,
  anchorReference,
  applyAction,
  checkDeterministic,
  conditionHash,
  decide,
  formatAnchorReference,
  nextStep,
  openDispute,
  signEnvelope,
  type CriterionResult,
  type MilestoneState,
} from "@workspace/core";
import {
  DocumentReadingSchema,
  assessReading,
  bindCondition,
  draftCondition,
  evaluateDocument,
  scoreReading,
  type StructuredModel,
} from "@workspace/semantic";
import type { EscrowClient } from "./escrow-client.ts";
import type { Store } from "./store.ts";

export interface AppConfig {
  /** Stellar keypair of the verifier; its public key is the releaseSigner on the escrow. */
  verifierKey: Keypair;
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
}

const VerifyBody = z.object({
  condition: ConditionSchema,
  evidence: z.array(EvidenceItemSchema).min(1),
  image: z.object({ base64: z.string().min(1), mediaType: z.enum(["image/jpeg", "image/png", "image/webp", "image/gif"]) }).optional(),
  reading: DocumentReadingSchema.optional(),
  fx: z.object({ currency: z.string(), unitsPerAsset: z.number().positive() }).optional(),
  /** Current escrow status as the backend knows it. */
  status: z.enum(["FUNDED", "DISPUTED"]).default("FUNDED"),
});

const DraftBody = z.object({
  text: z.string().min(1),
  payer: z.string(),
  receiver: z.string(),
  asset: z.object({ code: z.string(), issuer: z.string() }),
  defaultDeadline: z.iso.datetime(),
});

const ChallengeBody = z.object({
  openedBy: z.enum(["payer", "receiver"]),
  note: z.string().min(1),
  evidenceLinks: z.array(z.object({ sha256: z.string(), url: z.string() })).default([]),
  /** The condition the envelope was built for; the resolver needs it next to the verdict. */
  condition: ConditionSchema,
});

export function createApp(config: AppConfig) {
  const now = config.now ?? (() => new Date().toISOString());
  const app = new Hono();

  app.get("/health", (c) =>
    c.json({ ok: true, verifier: config.verifierKey.publicKey(), model: Boolean(config.model), autoRelease: config.autoRelease }),
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
    if (body.data.reading) {
      semantic = assessReading(condition, body.data.reading, fx);
      score = scoreReading(body.data.reading, semantic);
    } else if (body.data.image) {
      if (!config.model) return c.json({ error: "no model credentials configured; send a precomputed reading" }, 503);
      const outcome = await evaluateDocument(config.model, { condition, image: body.data.image, fx });
      semantic = outcome.criteria;
      score = outcome.score;
    } else {
      return c.json({ error: "send image or reading" }, 400);
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
