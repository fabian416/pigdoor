import { describe, expect, it } from "vitest";
import { decide } from "../src/criteria.ts";
import { checkUnderwriting, underwriterVerifier, type UnderwritingFacts, type UnderwritingPolicy } from "../src/underwriter.ts";
import { condition } from "./fixtures.ts";

const facts: UnderwritingFacts = {
  score: 712,
  kycOk: true,
  kycValidUntil: "2027-04-01T00:00:00Z",
  approvedLimit: "350",
  outstanding: "0",
  evaluatedAt: "2026-10-25T20:00:00Z",
};
const policy: UnderwritingPolicy = { minScore: 600, maxDisbursement: "500", version: "lendoor-1" };
const byId = (rs: ReturnType<typeof checkUnderwriting>) => Object.fromEntries(rs.map((r) => [r.id, r]));

describe("Lendoor underwriter: score plus policy, same envelope", () => {
  it("approves Ana's 290 with a 712 score and a 350 line", async () => {
    const criteria = await underwriterVerifier(policy).verify({ condition, facts });
    expect(criteria).toHaveLength(4);
    expect(criteria.every((c) => c.result === "PASS" && c.verifier === "lendoor_underwriter")).toBe(true);
    expect(decide(criteria, undefined, { semanticThreshold: 70, semanticReviewFloor: 40, policyVersion: policy.version })).toMatchObject({
      decision: "ALLOW",
      policyVersion: "lendoor-1",
    });
  });

  it("denies below the score threshold", () => {
    expect(byId(checkUnderwriting(condition, { ...facts, score: 599 }, policy)).score_above_threshold.code).toBe("SCORE_BELOW_THRESHOLD");
  });

  it("denies without valid KYC, including an attestation that expired", () => {
    expect(byId(checkUnderwriting(condition, { ...facts, kycOk: false }, policy)).kyc_valid.code).toBe("KYC_INVALID");
    expect(byId(checkUnderwriting(condition, { ...facts, kycValidUntil: "2026-10-01T00:00:00Z" }, policy)).kyc_valid.result).toBe("FAIL");
  });

  it("denies when the amount exceeds what is left on the line, or the policy cap", () => {
    expect(byId(checkUnderwriting(condition, { ...facts, outstanding: "100" }, policy)).amount_within_credit_line.code).toBe("AMOUNT_OVER_LIMIT");
    expect(byId(checkUnderwriting(condition, facts, { ...policy, maxDisbursement: "250" })).amount_within_policy.code).toBe("AMOUNT_OVER_POLICY");
    expect(byId(checkUnderwriting(condition, { ...facts, outstanding: "60" }, policy)).amount_within_credit_line.result).toBe("PASS");
  });
});
