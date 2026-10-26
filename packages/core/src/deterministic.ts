import { z } from "zod";
import { toStroops } from "./amount.ts";
import { Amount, conditionHash, type Condition } from "./condition.ts";
import type { CriterionResult, Verifier } from "./criteria.ts";

/**
 * What the escrow says, read from chain or from the escrow provider's API.
 * The deterministic verifier compares these facts with the frozen condition.
 */
export const EscrowFactsSchema = z.object({
  /** Who the milestone pays. */
  milestoneReceiver: z.string().min(1),
  /** How much the milestone pays, decimal string in the condition's asset. */
  milestoneAmount: Amount,
  /** When funding was confirmed on-chain; null if not yet. */
  fundedAt: z.iso.datetime().nullable(),
  fundingTxHash: z.string().min(1).optional(),
  /** When the beneficiary submitted the evidence. */
  evidenceSubmittedAt: z.iso.datetime(),
  /**
   * The condition hash recorded on the escrow when it was created (e.g. in the
   * milestone description). Binds the verification to what the payer actually
   * committed to, so nobody can swap in a laxer condition afterwards.
   */
  committedConditionHash: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  /** Milestone status as the escrow reports it. Never taken from the caller. */
  status: z.enum(["FUNDED", "RELEASED", "REFUNDED", "DISPUTED"]).optional(),
});
export type EscrowFacts = z.infer<typeof EscrowFactsSchema>;

const NAME = "deterministic";

function criterion(
  id: string,
  pass: boolean | null,
  code: CriterionResult["code"],
  reason: string,
): CriterionResult {
  return {
    id,
    verifier: NAME,
    result: pass === null ? "UNKNOWN" : pass ? "PASS" : "FAIL",
    code: pass ? "OK" : code,
    reason,
    mandatory: true,
  };
}

/**
 * Binary checks, no model, no cost. They prove the money goes where it was
 * committed to go: committed condition, funding, destination, amount, window.
 * They run for both settlement roles. For `payee_prepaid` there is no external
 * settlement to verify (the release is the payment), so these are the escrow's
 * own integrity checks rather than a second verifier.
 */
export function checkDeterministic(condition: Condition, facts: EscrowFacts): CriterionResult[] {
  const out: CriterionResult[] = [];

  const expectedHash = conditionHash(condition);
  if (!facts.committedConditionHash) {
    out.push(criterion("condition_matches_escrow", null, "CONDITION_NOT_COMMITTED", "escrow carries no condition hash"));
  } else {
    const same = facts.committedConditionHash === expectedHash;
    out.push(
      criterion(
        "condition_matches_escrow",
        same,
        "CONDITION_MISMATCH",
        same ? "escrow commits to this exact condition" : `escrow commits to ${facts.committedConditionHash}, got ${expectedHash}`,
      ),
    );
  }

  const funded = facts.fundedAt !== null && Boolean(facts.fundingTxHash);
  out.push(
    criterion(
      "escrow_funded",
      funded,
      "ESCROW_NOT_FUNDED",
      funded ? `funding confirmed in ${facts.fundingTxHash}` : "escrow funding not confirmed on-chain",
    ),
  );
  const sameReceiver = facts.milestoneReceiver === condition.receiver;
  out.push(
    criterion(
      "destination_matches",
      sameReceiver,
      "DESTINATION_MISMATCH",
      sameReceiver
        ? "milestone pays the committed receiver"
        : `milestone pays ${facts.milestoneReceiver}, condition commits to ${condition.receiver}`,
    ),
  );

  let withinMax: boolean;
  try {
    const amount = toStroops(facts.milestoneAmount);
    withinMax = amount > 0n && amount <= toStroops(condition.maxAmount);
  } catch {
    withinMax = false;
  }
  out.push(
    criterion(
      "amount_within_max",
      withinMax,
      "AMOUNT_OVER_MAX",
      withinMax
        ? `${facts.milestoneAmount} <= ${condition.maxAmount}`
        : `${facts.milestoneAmount} exceeds the committed maximum ${condition.maxAmount}`,
    ),
  );

  const submitted = Date.parse(facts.evidenceSubmittedAt);
  const inWindow =
    Number.isFinite(submitted) &&
    submitted >= Date.parse(condition.window.notBefore) &&
    submitted <= Date.parse(condition.window.notAfter);
  out.push(
    criterion(
      "evidence_within_window",
      inWindow,
      "EVIDENCE_OUT_OF_WINDOW",
      inWindow
        ? "evidence submitted inside the committed window"
        : `evidence submitted at ${facts.evidenceSubmittedAt}, outside ${condition.window.notBefore} .. ${condition.window.notAfter}`,
    ),
  );

  return out;
}

export const deterministicVerifier: Verifier<{ condition: Condition; facts: EscrowFacts }> = {
  name: NAME,
  type: "automated_agent",
  async verify({ condition, facts }) {
    return checkDeterministic(condition, facts);
  },
};
