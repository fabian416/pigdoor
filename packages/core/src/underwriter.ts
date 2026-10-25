import { toStroops } from "./amount.ts";
import type { Condition } from "./condition.ts";
import type { CriterionResult, Verifier } from "./criteria.ts";

/**
 * Lendoor's verifier: score plus policy, signed for the partner who funds the
 * book. It runs before funding and produces the same envelope the release
 * verifiers produce, so a funder audits approval and release the same way.
 * Nothing here calls a model; the score comes from Lendoor's risk engine.
 */
export interface UnderwritingFacts {
  /** Lendoor score, 0-1000. */
  score: number;
  kycOk: boolean;
  /** When the KYC attestation expires. */
  kycValidUntil: string;
  /** Credit line the risk engine granted, decimal string. */
  approvedLimit: string;
  /** Principal currently outstanding, decimal string. */
  outstanding: string;
  /** When the underwriting ran. */
  evaluatedAt: string;
}

export interface UnderwritingPolicy {
  minScore: number;
  /** Hard cap per disbursement, decimal string. */
  maxDisbursement: string;
  version: string;
}

const NAME = "lendoor_underwriter";

function criterion(id: string, pass: boolean, code: CriterionResult["code"], reason: string): CriterionResult {
  return { id, verifier: NAME, result: pass ? "PASS" : "FAIL", code: pass ? "OK" : code, reason, mandatory: true };
}

export function checkUnderwriting(condition: Condition, facts: UnderwritingFacts, policy: UnderwritingPolicy): CriterionResult[] {
  const amount = toStroops(condition.maxAmount);
  const out: CriterionResult[] = [];

  const scoreOk = facts.score >= policy.minScore;
  out.push(criterion("score_above_threshold", scoreOk, "SCORE_BELOW_THRESHOLD", `score ${facts.score}, policy requires ${policy.minScore}`));

  const kycOk = facts.kycOk && Date.parse(facts.kycValidUntil) > Date.parse(facts.evaluatedAt);
  out.push(criterion("kyc_valid", kycOk, "KYC_INVALID", kycOk ? `KYC valid until ${facts.kycValidUntil}` : "KYC missing or expired"));

  const available = toStroops(facts.approvedLimit) - toStroops(facts.outstanding);
  const withinLimit = amount <= available;
  out.push(
    criterion(
      "amount_within_credit_line",
      withinLimit,
      "AMOUNT_OVER_LIMIT",
      `requested ${condition.maxAmount}, available ${facts.approvedLimit} - ${facts.outstanding}`,
    ),
  );

  const withinPolicy = amount <= toStroops(policy.maxDisbursement);
  out.push(
    criterion("amount_within_policy", withinPolicy, "AMOUNT_OVER_POLICY", `requested ${condition.maxAmount}, policy cap ${policy.maxDisbursement}`),
  );

  return out;
}

export function underwriterVerifier(policy: UnderwritingPolicy): Verifier<{ condition: Condition; facts: UnderwritingFacts }> {
  return {
    name: NAME,
    type: "platform",
    async verify({ condition, facts }) {
      return checkUnderwriting(condition, facts, policy);
    },
  };
}
