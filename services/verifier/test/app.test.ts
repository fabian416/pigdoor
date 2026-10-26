import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { Keypair, parseAnchorReference, resolveEnvelope, sha256Hex, verifyEnvelope } from "@witness/core";
import type { StructuredModel } from "@witness/semantic";
import { createApp } from "../src/app.ts";
import { inMemoryEscrowClient } from "../src/escrow-client.ts";
import { memoryStore } from "../src/store.ts";

const root = new URL("../../../", import.meta.url);
const example = (name: string) => JSON.parse(readFileSync(new URL(`examples/${name}`, root), "utf8"));
const condition = example("lendoor/condition.json");
const facts = example("lendoor/facts.json");
const evidence = example("lendoor/evidence.json");
const goodReading = example("lendoor/reading-good.json");
const wrongShop = example("lendoor/reading-wrong-shop.json");

const AGREEMENT = "ESCROW-DEMO-0001";

/** A stand-in photo and the evidence item that names its bytes. */
const photo = { base64: Buffer.from("not really a jpeg, but bytes are bytes").toString("base64"), mediaType: "image/jpeg" as const };
const photoEvidence = { ...evidence[0], sha256: sha256Hex(Buffer.from(photo.base64, "base64")) };
const NOW = "2026-10-30T15:05:00Z";

function harness(opts: { autoRelease?: boolean; model?: StructuredModel; acceptReadings?: boolean; apiToken?: string } = {}) {
  const verifierKey = Keypair.random();
  const escrow = inMemoryEscrowClient({ [`${AGREEMENT}/1`]: facts, [`${AGREEMENT}/2`]: facts });
  const store = memoryStore();
  const app = createApp({
    verifierKey,
    escrow: escrow.client,
    store,
    model: opts.model,
    publicUrl: "http://verifier.test",
    // Readings are the offline demo path, so by default tests run in demo mode: readings on, auto-release off.
    autoRelease: opts.autoRelease ?? false,
    acceptReadings: opts.acceptReadings ?? !(opts.autoRelease ?? false),
    apiToken: opts.apiToken,
    now: () => NOW,
  });
  const post = (path: string, body: unknown, token?: string) =>
    app.request(path, {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    });
  return { app, post, verifierKey, escrow, store };
}

describe("verifier service", () => {
  it("health reports the verifier key and whether a model is configured", async () => {
    const { app, verifierKey } = harness();
    const res = await app.request("/health");
    expect(await res.json()).toMatchObject({ ok: true, verifier: verifierKey.publicKey(), model: false, autoRelease: false, acceptReadings: true, authenticated: false });
  });

  it("happy path: verifies, signs, anchors into the escrow and releases", async () => {
    const model: StructuredModel = async (req) => ({ ok: true, value: req.schema.parse(goodReading) });
    const { post, escrow, verifierKey, app } = harness({ autoRelease: true, model, apiToken: "t" });
    const res = await post(`/agreements/${AGREEMENT}/milestones/1/verify`, { condition, evidence: [photoEvidence, evidence[0]], image: photo }, "t");
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.envelope.verdict.decision).toBe("ALLOW");
    expect(body.nextStep).toMatchObject({ action: "RELEASE", actor: "verifier" });
    expect(body.status).toBe("RELEASED");
    expect(body.release.txHash).toMatch(/^fake-/);
    expect(body.demo).toBe(false);
    expect(verifyEnvelope(body.envelope)).toEqual({ ok: true });
    // Only the evidence item the model actually looked at is signed.
    expect(body.envelope.evidence).toHaveLength(1);
    expect(body.envelope.evidence[0].sha256).toBe(photoEvidence.sha256);

    // A second verify on a released milestone is refused before anything is signed.
    const again = await post(`/agreements/${AGREEMENT}/milestones/1/verify`, { condition, evidence: [photoEvidence], image: photo }, "t");
    expect(again.status).toBe(409);

    // The anchor line landed in the escrow and resolves back to the same envelope through the service itself.
    const row = escrow.milestones.get(`${AGREEMENT}/1`)!;
    expect(row.released).toBeDefined();
    const ref = parseAnchorReference(row.anchor!)!;
    expect(ref.uri).toBe(`http://verifier.test/envelopes/${body.id}`);
    const resolved = await resolveEnvelope(ref, {
      fetch: async (url) => (await app.request(url.replace("http://verifier.test", ""))).text(),
      expect: { agreementId: AGREEMENT, milestoneId: "1", verifier: verifierKey.publicKey() },
    });
    expect(resolved.ok).toBe(true);
  });

  it("rejection path: a receipt from another shop denies and touches nothing on the escrow", async () => {
    const { post, escrow } = harness();
    const res = await post(`/agreements/${AGREEMENT}/milestones/2/verify`, { condition, evidence, reading: wrongShop });
    const body = await res.json();
    expect(body.envelope.verdict).toMatchObject({ decision: "DENY", reasons: ["MERCHANT_MISMATCH", "ITEMS_MISMATCH"] });
    expect(body.nextStep).toMatchObject({ action: "WAIT", reason: "VERDICT_DENY_RETRY_ALLOWED" });
    expect(body.status).toBe("FUNDED");
    expect(body.release).toBeUndefined();
    expect(escrow.milestones.get(`${AGREEMENT}/2`)!.released).toBeUndefined();
  });

  it("report-only mode never releases, even on ALLOW", async () => {
    const { post, escrow } = harness();
    const body = await (await post(`/agreements/${AGREEMENT}/milestones/1/verify`, { condition, evidence, reading: goodReading })).json();
    expect(body.nextStep.action).toBe("RELEASE");
    expect(body.status).toBe("FUNDED");
    expect(escrow.milestones.get(`${AGREEMENT}/1`)!.released).toBeUndefined();
  });

  it("an unreadable document escalates and flags the milestone as disputed", async () => {
    const { post, escrow } = harness();
    const reading = { ...goodReading, merchantNameOnDocument: null, merchantMatches: "UNKNOWN", dateOnDocument: null, itemsOnDocument: [], itemsMatch: "UNKNOWN", totalOnDocument: null, legibility: 15, confidence: 20 };
    const body = await (await post(`/agreements/${AGREEMENT}/milestones/1/verify`, { condition, evidence, reading })).json();
    expect(body.envelope.verdict.decision).toBe("REVIEW");
    expect(body.status).toBe("DISPUTED");
    expect(escrow.milestones.get(`${AGREEMENT}/1`)!.disputed).toContain("DOCUMENT_ILLEGIBLE");
  });

  it("without model credentials a photo is refused with 503", async () => {
    const { post } = harness();
    const res = await post(`/agreements/${AGREEMENT}/milestones/1/verify`, { condition, evidence: [photoEvidence], image: photo });
    expect(res.status).toBe(503);
  });

  it("the envelope must name the bytes the model saw: a photo whose hash is not in the evidence is refused", async () => {
    const model: StructuredModel = async (req) => ({ ok: true, value: req.schema.parse(goodReading) });
    const { post } = harness({ model });
    const res = await post(`/agreements/${AGREEMENT}/milestones/1/verify`, { condition, evidence, image: photo });
    expect(res.status).toBe(422);
    expect((await res.json()).imageHash).toBe(photoEvidence.sha256);
  });

  it("posted readings cannot release money: refused when readings are off, and the combination with auto-release is impossible", async () => {
    const { post, escrow } = harness({ acceptReadings: false });
    const res = await post(`/agreements/${AGREEMENT}/milestones/1/verify`, { condition, evidence, reading: goodReading });
    expect(res.status).toBe(403);
    expect(escrow.milestones.get(`${AGREEMENT}/1`)!.released).toBeUndefined();
    expect(() => harness({ autoRelease: true, acceptReadings: true })).toThrow(/acceptReadings/);
  });

  it("writes need the backend token; reads stay public", async () => {
    const { post, app } = harness({ apiToken: "s3cret" });
    expect((await post(`/agreements/${AGREEMENT}/milestones/1/verify`, { condition, evidence, reading: goodReading })).status).toBe(401);
    expect((await post(`/agreements/${AGREEMENT}/milestones/1/verify`, { condition, evidence, reading: goodReading }, "s3cret")).status).toBe(200);
    expect((await app.request("/health")).status).toBe(200);
    expect((await app.request("/envelopes")).status).toBe(200);
  });

  it("serves the anchored bytes content-addressed and 404s otherwise", async () => {
    const { post, app } = harness();
    const body = await (await post(`/agreements/${AGREEMENT}/milestones/1/verify`, { condition, evidence, reading: goodReading })).json();
    const res = await app.request(`/envelopes/${body.id}`);
    expect(res.status).toBe(200);
    expect(verifyEnvelope(JSON.parse(await res.text()))).toEqual({ ok: true });
    expect((await app.request("/envelopes/" + "0".repeat(64))).status).toBe(404);
  });

  it("a challenge opens a case for the resolver and disputes the milestone", async () => {
    const { post, app, escrow } = harness();
    const verified = await (await post(`/agreements/${AGREEMENT}/milestones/1/verify`, { condition, evidence, reading: goodReading })).json();
    const res = await post(`/envelopes/${verified.id}/challenge`, { openedBy: "payer", note: "Esa factura no es de la tienda", condition });
    expect(res.status).toBe(200);
    const { caseId, case: c } = await res.json();
    expect(c.trigger).toBe("CHALLENGE");
    expect(c.questions.length).toBeGreaterThan(0);
    expect(escrow.milestones.get(`${AGREEMENT}/1`)!.disputed).toContain("payer");
    expect((await app.request(`/cases/${caseId}`)).status).toBe(200);
  });

  it("Piggy flow: a task condition runs the semantic verifier plus escrow integrity, and the release is the payment", async () => {
    const piggy = example("piggy/condition.json");
    const piggyFacts = example("piggy/facts.json");
    const { post, escrow } = harness();
    escrow.set(AGREEMENT, "7", piggyFacts);
    const body = await (await post(`/agreements/${AGREEMENT}/milestones/7/verify`, { condition: piggy, evidence: example("piggy/evidence.json"), reading: example("piggy/reading-done.json") })).json();
    expect(body.envelope.verdict.decision).toBe("ALLOW");
    expect(body.envelope.criteria.map((c: { id: string }) => c.id)).toEqual([
      "condition_matches_escrow",
      "escrow_funded",
      "destination_matches",
      "amount_within_max",
      "evidence_within_window",
      "photo_legible",
      "task_visible",
      "task_done",
      "photo_not_staged",
    ]);
    const denied = await (await post(`/agreements/${AGREEMENT}/milestones/7/verify`, { condition: piggy, evidence: example("piggy/evidence.json"), reading: example("piggy/reading-not-done.json") })).json();
    expect(denied.envelope.verdict).toMatchObject({ decision: "DENY", reasons: ["TASK_NOT_DONE"] });
  });

  it("a reading of the wrong shape for the condition kind is a 400, not a verdict", async () => {
    const { post } = harness();
    const res = await post(`/agreements/${AGREEMENT}/milestones/1/verify`, { condition, evidence, reading: example("piggy/reading-done.json") });
    expect(res.status).toBe(400);
  });

  it("Lendoor underwriting: a separate verdict, separate key, same envelope", async () => {
    const underwriterKey = Keypair.random();
    const verifierKey = Keypair.random();
    const store = memoryStore();
    const app = createApp({
      verifierKey,
      underwriterKey,
      escrow: inMemoryEscrowClient().client,
      store,
      publicUrl: "http://verifier.test",
      autoRelease: false,
      acceptReadings: true,
      now: () => NOW,
    });
    const uw = example("lendoor/underwriting.json");
    const res = await app.request(`/agreements/${AGREEMENT}/underwrite`, {
      method: "POST",
      body: JSON.stringify({ condition, ...uw }),
      headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.fundable).toBe(true);
    expect(body.envelope.milestoneId).toBe("underwriting");
    expect(body.envelope.verifier).toBe(underwriterKey.publicKey());
    expect(body.envelope.verdict.policyVersion).toBe("lendoor-1");
    expect(verifyEnvelope(body.envelope)).toEqual({ ok: true });

    const low = await app.request(`/agreements/${AGREEMENT}/underwrite`, {
      method: "POST",
      body: JSON.stringify({ condition, facts: { ...uw.facts, score: 500 }, policy: uw.policy }),
      headers: { "content-type": "application/json" },
    });
    expect((await low.json()).fundable).toBe(false);
  });

  it("envelopes built from client readings say so, and never trigger a release", async () => {
    const { post } = harness();
    const body = await (await post(`/agreements/${AGREEMENT}/milestones/1/verify`, { condition, evidence, reading: goodReading })).json();
    expect(body.demo).toBe(true);
    expect(body.envelope.criteria.some((c: { verifier: string }) => c.verifier === "semantic:client_reading")).toBe(true);
  });

  it("a model outage is a 503 to retry, not a verdict: nothing signed, nothing disputed", async () => {
    const model: StructuredModel = async () => ({ ok: false, code: "MODEL_ERROR", message: "529 overloaded" });
    const { post, escrow, store } = harness({ model });
    const res = await post(`/agreements/${AGREEMENT}/milestones/1/verify`, { condition, evidence: [photoEvidence], image: photo });
    expect(res.status).toBe(503);
    expect(store.listEnvelopeIds()).toHaveLength(0);
    expect(escrow.milestones.get(`${AGREEMENT}/1`)!.disputed).toBeUndefined();
  });

  it("a challenge must carry the condition the envelope was built for", async () => {
    const { post } = harness();
    const verified = await (await post(`/agreements/${AGREEMENT}/milestones/1/verify`, { condition, evidence, reading: goodReading })).json();
    const other = example("piggy/condition.json");
    const res = await post(`/envelopes/${verified.id}/challenge`, { openedBy: "payer", note: "x", condition: other });
    expect(res.status).toBe(409);
  });

  it("refuses to start with auto-release and no token", () => {
    expect(() => harness({ autoRelease: true, acceptReadings: false })).toThrow(/apiToken/);
  });

  it("malformed JSON is a 400", async () => {
    const { app } = harness();
    const res = await app.request(`/agreements/${AGREEMENT}/milestones/1/verify`, { method: "POST", body: "{not json", headers: { "content-type": "application/json" } });
    expect(res.status).toBe(400);
  });

  it("rejects malformed input and unknown milestones", async () => {
    const { post } = harness();
    expect((await post(`/agreements/${AGREEMENT}/milestones/1/verify`, { condition: { nope: 1 }, evidence })).status).toBe(400);
    expect((await post(`/agreements/${AGREEMENT}/milestones/1/verify`, { condition, evidence })).status).toBe(400);
    expect((await post(`/agreements/${AGREEMENT}/milestones/99/verify`, { condition, evidence, reading: goodReading })).status).toBe(502);
  });
});
