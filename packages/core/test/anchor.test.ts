import { describe, expect, it } from "vitest";
import { anchorReference, envelopeBytes, formatAnchorReference, parseAnchorReference, resolveEnvelope, toGatewayUrl } from "../src/anchor.ts";
import { conditionHash } from "../src/condition.ts";
import { decide } from "../src/criteria.ts";
import { checkDeterministic } from "../src/deterministic.ts";
import { signEnvelope } from "../src/envelope.ts";
import { condition, goodFacts, receiptEvidence, stranger, verifierKey } from "./fixtures.ts";

function signed() {
  const criteria = checkDeterministic(condition, goodFacts);
  return signEnvelope(
    {
      agreementId: "CADMJSOMBSHUW2LMETBUOVH2CSVY3EDISY4V7UMH7TDU2LE5XRCEULAG",
      milestoneId: "1",
      verifier: verifierKey.publicKey(),
      verifierType: "automated_agent",
      criteria,
      evidence: [receiptEvidence],
      verdict: decide(criteria, 88),
      timestamp: "2026-10-30T15:01:00Z",
      conditionHash: conditionHash(condition),
    },
    verifierKey,
  );
}

/** A fake "IPFS": maps uri -> stored text. */
const store = (entries: Record<string, string>) => async (url: string) => {
  if (!(url in entries)) throw new Error(`404 ${url}`);
  return entries[url];
};

describe("anchoring", () => {
  it("formats and parses the reference written into the escrow", () => {
    const ref = anchorReference(signed(), "ipfs://QmSpgUkiJnCfdALUtHXocKQ8GtGaG4LsxUWEoUDFDruWXN");
    const text = formatAnchorReference(ref);
    expect(text).toMatch(/^verdict-v1 sha256=[0-9a-f]{64} uri=ipfs:\/\/Qm/);
    expect(parseAnchorReference(text)).toEqual(ref);
    expect(parseAnchorReference("garbage")).toBeNull();
  });

  it("hashes the canonical bytes, so pretty-printing at rest changes nothing", async () => {
    const env = signed();
    const ref = anchorReference(env, "https://evidence.example/e1.json");
    const pretty = JSON.stringify(env, null, 2);
    expect(pretty).not.toBe(envelopeBytes(env));
    const out = await resolveEnvelope(ref, { fetch: store({ [ref.uri]: pretty }) });
    expect(out).toMatchObject({ ok: true, envelope: { verdict: { decision: "ALLOW" } } });
  });

  it("maps ipfs:// to a gateway and fetches from there", async () => {
    const env = signed();
    const ref = anchorReference(env, "ipfs://QmTest");
    expect(toGatewayUrl(ref.uri)).toBe("https://ipfs.io/ipfs/QmTest");
    const out = await resolveEnvelope(ref, { fetch: store({ "https://gw.example/QmTest": envelopeBytes(env) }), ipfsGateway: "https://gw.example/" });
    expect(out.ok).toBe(true);
  });

  it("rejects content that does not match the reference hash", async () => {
    const env = signed();
    const other = signEnvelope({ ...env, milestoneId: "2" }, verifierKey);
    const ref = anchorReference(env, "https://x/e.json");
    const out = await resolveEnvelope(ref, { fetch: store({ [ref.uri]: envelopeBytes(other) }) });
    expect(out).toMatchObject({ ok: false, reason: expect.stringContaining("reference hash") });
  });

  it("rejects a tampered envelope even when the hash was recomputed by the attacker", async () => {
    const env = signed();
    const tampered = { ...env, verdict: { ...env.verdict, decision: "ALLOW" as const } , milestoneId: "9" };
    const ref = { sha256: anchorReference(tampered as never, "https://x/t.json").sha256, uri: "https://x/t.json" };
    const out = await resolveEnvelope(ref, { fetch: store({ [ref.uri]: JSON.stringify(tampered) }) });
    expect(out).toMatchObject({ ok: false, reason: expect.stringContaining("signature") });
  });

  it("cross-checks agreement, milestone, condition and verifier against what the escrow says", async () => {
    const env = signed();
    const ref = anchorReference(env, "https://x/e.json");
    const fetcher = store({ [ref.uri]: envelopeBytes(env) });
    expect((await resolveEnvelope(ref, { fetch: fetcher, expect: { milestoneId: "2" } })).ok).toBe(false);
    expect((await resolveEnvelope(ref, { fetch: fetcher, expect: { conditionHash: "0".repeat(64) } })).ok).toBe(false);
    expect((await resolveEnvelope(ref, { fetch: fetcher, expect: { verifier: stranger.publicKey() } })).ok).toBe(false);
    expect(
      (await resolveEnvelope(ref, { fetch: fetcher, expect: { agreementId: env.agreementId, milestoneId: "1", conditionHash: env.conditionHash, verifier: verifierKey.publicKey() } })).ok,
    ).toBe(true);
  });

  it("reports fetch failures and non-JSON content plainly", async () => {
    const ref = { sha256: "a".repeat(64), uri: "https://x/missing.json" };
    expect(await resolveEnvelope(ref, { fetch: store({}) })).toMatchObject({ ok: false, reason: expect.stringContaining("fetch") });
    expect(await resolveEnvelope(ref, { fetch: store({ [ref.uri]: "<html>" }) })).toMatchObject({ ok: false, reason: "anchored content is not JSON" });
  });
});
