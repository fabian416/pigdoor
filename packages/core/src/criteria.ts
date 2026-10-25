import { z } from "zod";

/**
 * Machine-readable reasons. The verdict carries codes, not prose, so a wallet,
 * an indexer or a dispute resolver can act on them without parsing text.
 */
export const REASON_CODES = [
  "OK",
  "NO_CRITERIA",
  // deterministic verifier
  "DESTINATION_MISMATCH",
  "AMOUNT_OVER_MAX",
  "EVIDENCE_OUT_OF_WINDOW",
  "ESCROW_NOT_FUNDED",
  // semantic verifier
  "MERCHANT_MISMATCH",
  "ITEMS_MISMATCH",
  "DOC_DATE_OUT_OF_WINDOW",
  "DOC_DATE_UNREADABLE",
  "DOC_TOTAL_OVER_MAX",
  "DOC_TOTAL_UNREADABLE",
  "DOC_CURRENCY_UNKNOWN",
  "DOCUMENT_ILLEGIBLE",
  "MODEL_OUTPUT_INVALID",
  "MODEL_REFUSED",
  "MODEL_ERROR",
  "LOW_CONFIDENCE",
] as const;
export const ReasonCode = z.enum(REASON_CODES);
export type ReasonCode = z.infer<typeof ReasonCode>;

export const CriterionOutcome = z.enum(["PASS", "FAIL", "UNKNOWN"]);
export type CriterionOutcome = z.infer<typeof CriterionOutcome>;

/** Who produced a verdict. Values follow the Trustless Work research vocabulary. */
export const VerifierType = z.enum(["automated_agent", "model_evaluator", "human", "oracle", "platform"]);
export type VerifierType = z.infer<typeof VerifierType>;

export const CriterionResultSchema = z.object({
  id: z.string().min(1),
  verifier: z.string().min(1),
  result: CriterionOutcome,
  code: ReasonCode,
  reason: z.string(),
  /** Non-mandatory criteria inform the auditor but never block a release. */
  mandatory: z.boolean(),
});
export type CriterionResult = z.infer<typeof CriterionResultSchema>;

/** Anything that turns an input into criterion results: rules, a model, a human. */
export interface Verifier<Input> {
  readonly name: string;
  readonly type: VerifierType;
  verify(input: Input): Promise<CriterionResult[]>;
}

export const Decision = z.enum(["ALLOW", "DENY", "REVIEW"]);
export type Decision = z.infer<typeof Decision>;

export const VerdictSchema = z.object({
  decision: Decision,
  reasons: z.array(ReasonCode).min(1),
  /** 0-100, present when a semantic verifier ran. */
  semanticScore: z.number().int().min(0).max(100).optional(),
  policyVersion: z.string().min(1),
});
export type Verdict = z.infer<typeof VerdictSchema>;

export interface DecisionPolicy {
  /** Semantic score at or above this releases. */
  semanticThreshold: number;
  /** Semantic score below this denies; between floor and threshold goes to review. */
  semanticReviewFloor: number;
  policyVersion: string;
}

export const DEFAULT_POLICY: DecisionPolicy = {
  semanticThreshold: 70,
  semanticReviewFloor: 40,
  policyVersion: "1",
};

/**
 * The only place a decision is made, and it is a pure function.
 *
 * Any mandatory FAIL denies. Any mandatory UNKNOWN goes to a human. A weak
 * semantic score denies or escalates by band. Nothing else can release money.
 */
export function decide(
  criteria: CriterionResult[],
  semanticScore?: number,
  policy: DecisionPolicy = DEFAULT_POLICY,
): Verdict {
  const base = { policyVersion: policy.policyVersion, semanticScore };
  if (criteria.length === 0) return { ...base, decision: "REVIEW", reasons: ["NO_CRITERIA"] };

  const mandatory = criteria.filter((c) => c.mandatory);
  const codes = (outcome: CriterionOutcome): ReasonCode[] =>
    [...new Set(mandatory.filter((c) => c.result === outcome).map((c) => c.code))];

  const failed = codes("FAIL");
  if (failed.length > 0) return { ...base, decision: "DENY", reasons: failed };

  const unknown = codes("UNKNOWN");
  if (unknown.length > 0) return { ...base, decision: "REVIEW", reasons: unknown };

  if (semanticScore !== undefined) {
    if (semanticScore < policy.semanticReviewFloor) return { ...base, decision: "DENY", reasons: ["LOW_CONFIDENCE"] };
    if (semanticScore < policy.semanticThreshold) return { ...base, decision: "REVIEW", reasons: ["LOW_CONFIDENCE"] };
  }

  return { ...base, decision: "ALLOW", reasons: ["OK"] };
}
