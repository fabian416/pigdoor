import { describe, expect, it } from "vitest";
import { conditionHash } from "../src/condition.ts";
import { decide, type CriterionResult } from "../src/criteria.ts";
import { checkDeterministic } from "../src/deterministic.ts";
import { openDispute } from "../src/dispute.ts";
import { signEnvelope } from "../src/envelope.ts";
import { condition, goodFacts, receiptEvidence, verifierKey } from "./fixtures.ts";

function envelopeWith(extra: CriterionResult[], score?: number) {
  const criteria = [...checkDeterministic(condition, goodFacts), ...extra];
  return signEnvelope(
    {
      agreementId: "CADMJSOMBSHUW2LMETBUOVH2CSVY3EDISY4V7UMH7TDU2LE5XRCEULAG",
      milestoneId: "1",
      verifier: verifierKey.publicKey(),
      verifierType: "automated_agent",
      criteria,
      evidence: [receiptEvidence],
      verdict: decide(criteria, score),
      timestamp: "2026-10-30T15:01:00Z",
      conditionHash: conditionHash(condition),
    },
    verifierKey,
  );
}

const unknown = (id: string, code: CriterionResult["code"]): CriterionResult => ({
  id,
  verifier: "semantic",
  result: "UNKNOWN",
  code,
  reason: "",
  mandatory: true,
});

describe("dispute case", () => {
  it("turns a REVIEW verdict into questions for the resolver, without repeats", () => {
    const env = envelopeWith([unknown("doc_legible", "DOCUMENT_ILLEGIBLE"), unknown("doc_date_within_window", "DOC_DATE_UNREADABLE")], 20);
    expect(env.verdict.decision).toBe("REVIEW");
    const c = openDispute({
      condition,
      envelope: env,
      openedAt: "2026-10-30T15:02:00Z",
      openedBy: "verifier",
      trigger: "REVIEW_VERDICT",
      modelReading: { legibility: 20 },
      evidenceLinks: [{ sha256: receiptEvidence.sha256, url: "https://signed.example/remito.jpg?exp=..." }],
    });
    expect(c.questions).toEqual([
      "Ask the receiver for a clearer photo or the original document.",
      "Establish the document's date from the merchant or a bank record.",
    ]);
    expect(c.agreementId).toBe(env.agreementId);
    expect(c.modelReading).toEqual({ legibility: 20 });
  });

  it("a challenge against an ALLOW still produces a case with a generic question", () => {
    const env = envelopeWith([], 90);
    expect(env.verdict.decision).toBe("ALLOW");
    const c = openDispute({ condition, envelope: env, openedAt: "2026-10-30T16:00:00Z", openedBy: "payer", trigger: "CHALLENGE", evidenceLinks: [], challengeNote: "Esa factura no es de la tienda" });
    expect(c.questions).toHaveLength(1);
    expect(c.challengeNote).toContain("tienda");
  });

  it("carries the signed envelope untouched, so the resolver can re-verify it", () => {
    const env = envelopeWith([unknown("doc_evaluation", "MODEL_ERROR")]);
    const c = openDispute({ condition, envelope: env, openedAt: "2026-10-30T15:02:00Z", openedBy: "verifier", trigger: "REVIEW_VERDICT", evidenceLinks: [] });
    expect(c.envelope).toEqual(env);
    expect(c.questions[0]).toMatch(/errored/);
  });
});
