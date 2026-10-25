import { z } from "zod";
import { ConditionSchema, type Condition } from "./condition.ts";
import { ReasonCode, type ReasonCode as ReasonCodeT } from "./criteria.ts";
import { VerificationEnvelopeSchema, type VerificationEnvelope } from "./envelope.ts";

/**
 * What a human dispute resolver receives when a verdict is REVIEW or a party
 * challenges it. Everything needed to decide by hand, nothing the resolver has
 * to go and find. The model's raw reading is included as-is, labelled as the
 * model's opinion, never as fact.
 */
export const DisputeCaseSchema = z.object({
  agreementId: z.string().min(1),
  milestoneId: z.string().min(1),
  openedAt: z.iso.datetime(),
  openedBy: z.enum(["verifier", "payer", "receiver"]),
  trigger: z.enum(["REVIEW_VERDICT", "CHALLENGE"]),
  condition: ConditionSchema,
  envelope: VerificationEnvelopeSchema,
  /** The semantic verifier's raw reading, if a model ran. Opinion, not fact. */
  modelReading: z.unknown().optional(),
  /** Where the resolver can see the evidence (signed, short-lived URLs). */
  evidenceLinks: z.array(z.object({ sha256: z.string(), url: z.string().min(1) })),
  /** What the resolver should establish, derived from the open codes. */
  questions: z.array(z.string().min(1)),
  /** Human-readable, for the challenge form. */
  challengeNote: z.string().optional(),
});
export type DisputeCase = z.infer<typeof DisputeCaseSchema>;

const QUESTIONS: Partial<Record<ReasonCodeT, string>> = {
  DOCUMENT_ILLEGIBLE: "Ask the receiver for a clearer photo or the original document.",
  MERCHANT_MISMATCH: "Confirm with the receiver which business issued the document and whether it is the committed one.",
  ITEMS_MISMATCH: "Confirm what was actually bought and whether it matches the committed items.",
  DOC_DATE_UNREADABLE: "Establish the document's date from the merchant or a bank record.",
  DOC_DATE_OUT_OF_WINDOW: "Check whether the purchase date on the document is right and inside the window.",
  DOC_TOTAL_UNREADABLE: "Establish the total from the merchant or a bank record.",
  DOC_TOTAL_OVER_MAX: "Check whether the document total exceeds the committed maximum once converted.",
  DOC_CURRENCY_UNKNOWN: "Confirm the document's currency and the applicable rate.",
  MODEL_OUTPUT_INVALID: "The automated reading failed; read the document by hand.",
  MODEL_REFUSED: "The automated reading was refused; read the document by hand.",
  MODEL_ERROR: "The automated reading errored; read the document by hand or retry.",
  LOW_CONFIDENCE: "The automated reading was not confident; read the document by hand.",
  NO_CRITERIA: "No checks ran; verify the evidence from scratch.",
  CONDITION_NOT_COMMITTED: "The escrow carries no condition hash; confirm with the payer which condition applies before anything else.",
  CONDITION_MISMATCH: "The condition presented is not the one the escrow committed to; do not release, investigate the backend.",
  DESTINATION_MISMATCH: "The milestone pays an address other than the committed one; do not release.",
  AMOUNT_OVER_MAX: "The milestone amount exceeds the committed maximum; do not release.",
  EVIDENCE_OUT_OF_WINDOW: "Evidence arrived outside the window; the refund path applies.",
  ESCROW_NOT_FUNDED: "Funding is not confirmed; nothing can be released.",
  SCORE_BELOW_THRESHOLD: "The borrower's score is under policy; the loan should not be funded.",
  KYC_INVALID: "The borrower's KYC is missing or expired; re-verify identity before funding.",
  AMOUNT_OVER_LIMIT: "The requested amount exceeds the available credit line.",
  AMOUNT_OVER_POLICY: "The requested amount exceeds the policy cap per disbursement.",
  TASK_NOT_VISIBLE: "The photo does not show the task at all; ask for a photo of the right place or thing.",
  TASK_NOT_DONE: "The photo shows the task not done; confirm with the person who asked for it.",
  PHOTO_STAGED: "The photo shows signs of staging or reuse; ask for a fresh photo with context.",
};

export interface OpenDisputeInput {
  condition: Condition;
  envelope: VerificationEnvelope;
  openedAt: string;
  openedBy: DisputeCase["openedBy"];
  trigger: DisputeCase["trigger"];
  modelReading?: unknown;
  evidenceLinks: DisputeCase["evidenceLinks"];
  challengeNote?: string;
}

/** Builds the case. Questions come from the envelope's non-passing criteria, in order, without repeats. */
export function openDispute(input: OpenDisputeInput): DisputeCase {
  const codes = [
    ...new Set(
      input.envelope.criteria
        .filter((c) => c.result !== "PASS")
        .map((c) => c.code)
        .concat(input.envelope.verdict.reasons.filter((r) => r !== "OK")),
    ),
  ];
  const questions = codes.map((code) => QUESTIONS[ReasonCode.parse(code)]).filter((q): q is string => Boolean(q));
  if (questions.length === 0) questions.push("The automated verdict was challenged; re-check every criterion by hand.");

  return DisputeCaseSchema.parse({
    agreementId: input.envelope.agreementId,
    milestoneId: input.envelope.milestoneId,
    openedAt: input.openedAt,
    openedBy: input.openedBy,
    trigger: input.trigger,
    condition: input.condition,
    envelope: input.envelope,
    modelReading: input.modelReading,
    evidenceLinks: input.evidenceLinks,
    questions,
    challengeNote: input.challengeNote,
  });
}
