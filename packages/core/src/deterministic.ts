import { toStroops } from "./amount.ts";
import { conditionHash, type Condition } from "./condition.ts";
import type { CriterionResult, Verifier } from "./criteria.ts";

/**
 * What the escrow says, read from chain or from the escrow provider's API.
 * The deterministic verifier compares these facts with the frozen condition.
 */
export interface EscrowFacts {
  /** Who the milestone pays. */
  milestoneReceiver: string;
  /** How much the milestone pays, decimal string in the condition's asset. */
  milestoneAmount: string;
  /** When funding was confirmed on-chain; null if not yet. */
  fundedAt: string | null;
  fundingTxHash?: string;
  /** When the beneficiary submitted the evidence. */
  evidenceSubmittedAt: string;
  /**
   * The condition hash recorded on the escrow when it was created (e.g. in the
   * milestone description). Binds the verification to what the payer actually
   * committed to, so nobody can swap in a laxer condition afterwards.
   */
  committedConditionHash?: string;
}

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
 * committed to go. Integrity checks (committed condition, funding) always run;
 * settlement checks (destination, amount, window) only when the escrow pays a
 * third party (`settlement.role = escrow_funded`). When the release is itself
 * the payment to the payee there is no settlement to check.
 */
export function checkDeterministic(condition: Condition, facts: EscrowFacts): CriterionResult[] {
  const out: CriterionResult[] = [];
  const integrityOnly = condition.settlement.role === "payee_prepaid";

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
  if (integrityOnly) return out;

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
