import { z } from "zod";
import type { Condition } from "./condition.ts";
import type { Verdict } from "./criteria.ts";

/**
 * Milestone lifecycle, as the backend should drive it. The escrow provider
 * owns the real state; this module says what to do next and why, as a pure
 * function, so the rule "a refund after the deadline cannot be blocked by any
 * verdict" is testable and not buried in a service.
 */

export const MilestoneStatus = z.enum(["CREATED", "FUNDED", "RELEASED", "REFUNDED", "DISPUTED"]);
export type MilestoneStatus = z.infer<typeof MilestoneStatus>;

export interface MilestoneState {
  status: MilestoneStatus;
  /** Latest verdict for this milestone, if any. */
  verdict?: Verdict;
}

export const Action = z.enum(["RELEASE", "REFUND", "ESCALATE", "WAIT", "NONE"]);
export type Action = z.infer<typeof Action>;

export const ActionReason = z.enum([
  "ALREADY_FINAL",
  "NOT_FUNDED",
  "DEADLINE_PASSED",
  "VERDICT_ALLOW",
  "VERDICT_REVIEW",
  "VERDICT_DENY_RETRY_ALLOWED",
  "AWAITING_RESOLUTION",
  "NO_VERDICT_YET",
]);
export type ActionReason = z.infer<typeof ActionReason>;

export interface NextStep {
  action: Action;
  reason: ActionReason;
  /** Who may perform it. "anyone" is the permissionless refund. */
  actor: "verifier" | "dispute_resolver" | "anyone" | "nobody";
}

export interface LifecycleOptions {
  /** Seconds after `notAfter` before a refund becomes available. Default 0. */
  refundGraceSeconds?: number;
}

export function deadlinePassed(condition: Condition, nowIso: string, graceSeconds = 0): boolean {
  return Date.parse(nowIso) > Date.parse(condition.window.notAfter) + graceSeconds * 1000;
}

/** What should happen to this milestone right now. */
export function nextStep(condition: Condition, state: MilestoneState, nowIso: string, options: LifecycleOptions = {}): NextStep {
  if (state.status === "RELEASED" || state.status === "REFUNDED") {
    return { action: "NONE", reason: "ALREADY_FINAL", actor: "nobody" };
  }
  if (state.status === "CREATED") {
    return { action: "WAIT", reason: "NOT_FUNDED", actor: "nobody" };
  }

  // The deadline outranks every verdict, including a pending review and an
  // ALLOW nobody executed in time. The payer always gets the money back.
  if (deadlinePassed(condition, nowIso, options.refundGraceSeconds ?? 0)) {
    return { action: "REFUND", reason: "DEADLINE_PASSED", actor: "anyone" };
  }

  if (state.status === "DISPUTED") {
    return { action: "WAIT", reason: "AWAITING_RESOLUTION", actor: "dispute_resolver" };
  }

  const verdict = state.verdict;
  if (!verdict) return { action: "WAIT", reason: "NO_VERDICT_YET", actor: "nobody" };
  switch (verdict.decision) {
    case "ALLOW":
      return { action: "RELEASE", reason: "VERDICT_ALLOW", actor: "verifier" };
    case "REVIEW":
      return { action: "ESCALATE", reason: "VERDICT_REVIEW", actor: "verifier" };
    case "DENY":
      return { action: "WAIT", reason: "VERDICT_DENY_RETRY_ALLOWED", actor: "nobody" };
  }
}

/** Apply an executed action to the state. Throws on an impossible transition. */
export function applyAction(state: MilestoneState, action: Action): MilestoneState {
  const allowed: Record<Action, MilestoneStatus[]> = {
    RELEASE: ["FUNDED"],
    REFUND: ["FUNDED", "DISPUTED"],
    ESCALATE: ["FUNDED"],
    WAIT: ["CREATED", "FUNDED", "DISPUTED"],
    NONE: ["RELEASED", "REFUNDED"],
  };
  if (!allowed[action].includes(state.status)) {
    throw new Error(`cannot ${action} a milestone in status ${state.status}`);
  }
  switch (action) {
    case "RELEASE":
      return { ...state, status: "RELEASED" };
    case "REFUND":
      return { ...state, status: "REFUNDED" };
    case "ESCALATE":
      return { ...state, status: "DISPUTED" };
    default:
      return state;
  }
}
