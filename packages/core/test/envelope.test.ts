import { describe, expect, it } from "vitest";
import { conditionHash } from "../src/condition.ts";
import { decide } from "../src/criteria.ts";
import { checkDeterministic } from "../src/deterministic.ts";
import { computeProofHash, signEnvelope, verifyEnvelope, type UnsignedEnvelope } from "../src/envelope.ts";
import { condition, goodFacts, receiptEvidence, stranger, verifierKey } from "./fixtures.ts";

function unsigned(): UnsignedEnvelope {
  const criteria = checkDeterministic(condition, goodFacts);
  return {
    agreementId: "CADMJSOMBSHUW2LMETBUOVH2CSVY3EDISY4V7UMH7TDU2LE5XRCEULAG",
    milestoneId: "1",
    verifier: verifierKey.publicKey(),
    verifierType: "automated_agent",
    criteria,
    evidence: [receiptEvidence],
    verdict: decide(criteria, 88),
    timestamp: "2026-10-30T15:01:00Z",
    conditionHash: conditionHash(condition),
  };
}

describe("verification envelope", () => {
  it("signs and verifies", () => {
    const env = signEnvelope(unsigned(), verifierKey);
    expect(env.proofHash).toBe(computeProofHash(env.conditionHash, env.evidence));
    expect(verifyEnvelope(env)).toEqual({ ok: true });
    expect(verifyEnvelope(JSON.parse(JSON.stringify(env)))).toEqual({ ok: true });
  });

  it("uses the Trustless Work field names", () => {
    const env = signEnvelope(unsigned(), verifierKey);
    for (const field of ["agreementId", "milestoneId", "verifier", "verifierType", "criteria", "evidence", "proofHash", "signature", "verdict", "timestamp"]) {
      expect(env).toHaveProperty(field);
    }
  });

  it("detects a tampered verdict", () => {
    const env = signEnvelope(unsigned(), verifierKey);
    const tampered = { ...env, verdict: { ...env.verdict, decision: "ALLOW" as const, reasons: ["OK" as const] } };
    const denied = signEnvelope({ ...unsigned(), verdict: decide([{ ...env.criteria[0], result: "FAIL", code: "DESTINATION_MISMATCH" }]) }, verifierKey);
    expect(verifyEnvelope({ ...denied, verdict: tampered.verdict })).toMatchObject({ ok: false, reason: expect.stringContaining("signature") });
  });

  it("detects swapped evidence", () => {
    const env = signEnvelope(unsigned(), verifierKey);
    const swapped = { ...env, evidence: [{ ...receiptEvidence, sha256: "b".repeat(64) }] };
    expect(verifyEnvelope(swapped)).toMatchObject({ ok: false, reason: expect.stringContaining("proofHash") });
  });

  it("rejects a signature from a key that is not the declared verifier", () => {
    const env = signEnvelope(unsigned(), verifierKey);
    expect(verifyEnvelope({ ...env, verifier: stranger.publicKey() })).toMatchObject({ ok: false });
    expect(() => signEnvelope({ ...unsigned(), verifier: stranger.publicKey() }, verifierKey)).toThrow(/signing key/);
  });

  it("rejects garbage", () => {
    expect(verifyEnvelope({ hello: "world" })).toMatchObject({ ok: false, reason: expect.stringContaining("schema") });
  });
});
