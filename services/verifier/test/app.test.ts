import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { Keypair, parseAnchorReference, resolveEnvelope, verifyEnvelope } from "@workspace/core";
import type { StructuredModel } from "@workspace/semantic";
import { createApp } from "../src/app.ts";
import { inMemoryEscrowClient } from "../src/escrow-client.ts";
import { memoryStore } from "../src/store.ts";

const root = new URL("../../../", import.meta.url);
const example = (name: string) => JSON.parse(readFileSync(new URL(`examples/${name}`, root), "utf8"));
const condition = example("condition.json");
const facts = example("facts.json");
const evidence = example("evidence.json");
const goodReading = example("reading-good.json");
const wrongShop = example("reading-wrong-shop.json");

const AGREEMENT = "CADMJSOMBSHUW2LMETBUOVH2CSVY3EDISY4V7UMH7TDU2LE5XRCEULAG";
const NOW = "2026-10-30T15:05:00Z";

function harness(opts: { autoRelease?: boolean; model?: StructuredModel } = {}) {
  const verifierKey = Keypair.random();
  const escrow = inMemoryEscrowClient({ [`${AGREEMENT}/1`]: facts, [`${AGREEMENT}/2`]: facts });
  const store = memoryStore();
  const app = createApp({
    verifierKey,
    escrow: escrow.client,
    store,
    model: opts.model,
    publicUrl: "http://verifier.test",
    autoRelease: opts.autoRelease ?? true,
    now: () => NOW,
  });
  const post = (path: string, body: unknown) =>
    app.request(path, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });
  return { app, post, verifierKey, escrow, store };
}

describe("verifier service", () => {
  it("health reports the verifier key and whether a model is configured", async () => {
    const { app, verifierKey } = harness();
    const res = await app.request("/health");
    expect(await res.json()).toMatchObject({ ok: true, verifier: verifierKey.publicKey(), model: false, autoRelease: true });
  });

  it("happy path: verifies, signs, anchors into the escrow and releases", async () => {
    const { post, escrow, verifierKey, app } = harness();
    const res = await post(`/agreements/${AGREEMENT}/milestones/1/verify`, { condition, evidence, reading: goodReading });
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.envelope.verdict.decision).toBe("ALLOW");
    expect(body.nextStep).toMatchObject({ action: "RELEASE", actor: "verifier" });
    expect(body.status).toBe("RELEASED");
    expect(body.release.txHash).toMatch(/^fake-/);
    expect(verifyEnvelope(body.envelope)).toEqual({ ok: true });

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
    const { post, escrow } = harness({ autoRelease: false });
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

  it("without model credentials a photo is refused with 503, a reading is accepted", async () => {
    const { post } = harness();
    const res = await post(`/agreements/${AGREEMENT}/milestones/1/verify`, { condition, evidence, image: { base64: "AAAA", mediaType: "image/jpeg" } });
    expect(res.status).toBe(503);
  });

  it("uses the model for photos when configured", async () => {
    const model: StructuredModel = async (req) => ({ ok: true, value: req.schema.parse(goodReading) });
    const { post } = harness({ model });
    const body = await (await post(`/agreements/${AGREEMENT}/milestones/1/verify`, { condition, evidence, image: { base64: "AAAA", mediaType: "image/jpeg" } })).json();
    expect(body.envelope.verdict.decision).toBe("ALLOW");
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
    const res = await post(`/envelopes/${verified.id}/challenge`, { openedBy: "payer", note: "Ese remito no es del corralón", condition });
    expect(res.status).toBe(200);
    const { caseId, case: c } = await res.json();
    expect(c.trigger).toBe("CHALLENGE");
    expect(c.questions.length).toBeGreaterThan(0);
    expect(escrow.milestones.get(`${AGREEMENT}/1`)!.disputed).toContain("payer");
    expect((await app.request(`/cases/${caseId}`)).status).toBe(200);
  });

  it("rejects malformed input and unknown milestones", async () => {
    const { post } = harness();
    expect((await post(`/agreements/${AGREEMENT}/milestones/1/verify`, { condition: { nope: 1 }, evidence })).status).toBe(400);
    expect((await post(`/agreements/${AGREEMENT}/milestones/1/verify`, { condition, evidence })).status).toBe(400);
    expect((await post(`/agreements/${AGREEMENT}/milestones/99/verify`, { condition, evidence, reading: goodReading })).status).toBe(502);
  });
});
