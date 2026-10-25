import { describe, expect, it } from "vitest";
import type { Verdict } from "../src/criteria.ts";
import { applyAction, deadlinePassed, nextStep, type MilestoneState } from "../src/lifecycle.ts";
import { condition } from "./fixtures.ts";

const allow: Verdict = { decision: "ALLOW", reasons: ["OK"], semanticScore: 85, policyVersion: "1" };
const deny: Verdict = { decision: "DENY", reasons: ["MERCHANT_MISMATCH"], semanticScore: 30, policyVersion: "1" };
const review: Verdict = { decision: "REVIEW", reasons: ["DOCUMENT_ILLEGIBLE"], semanticScore: 20, policyVersion: "1" };

const inWindow = "2026-10-30T15:00:00Z";
const afterDeadline = "2026-11-16T00:00:01Z";

describe("milestone lifecycle", () => {
  it("releases on ALLOW, escalates on REVIEW, waits on DENY so the receiver can retry", () => {
    expect(nextStep(condition, { status: "FUNDED", verdict: allow }, inWindow)).toEqual({ action: "RELEASE", reason: "VERDICT_ALLOW", actor: "verifier" });
    expect(nextStep(condition, { status: "FUNDED", verdict: review }, inWindow)).toEqual({ action: "ESCALATE", reason: "VERDICT_REVIEW", actor: "verifier" });
    expect(nextStep(condition, { status: "FUNDED", verdict: deny }, inWindow)).toEqual({ action: "WAIT", reason: "VERDICT_DENY_RETRY_ALLOWED", actor: "nobody" });
    expect(nextStep(condition, { status: "FUNDED" }, inWindow).reason).toBe("NO_VERDICT_YET");
  });

  it("refund after the deadline is permissionless and beats every verdict", () => {
    for (const verdict of [allow, deny, review, undefined]) {
      expect(nextStep(condition, { status: "FUNDED", verdict }, afterDeadline)).toEqual({ action: "REFUND", reason: "DEADLINE_PASSED", actor: "anyone" });
    }
    expect(nextStep(condition, { status: "DISPUTED", verdict: review }, afterDeadline).action).toBe("REFUND");
  });

  it("a verifier that never answers cannot lock the money", () => {
    expect(nextStep(condition, { status: "FUNDED" }, afterDeadline).action).toBe("REFUND");
  });

  it("honours a grace period for executing an ALLOW", () => {
    const justAfter = "2026-11-16T00:30:00Z";
    expect(nextStep(condition, { status: "FUNDED", verdict: allow }, justAfter, { refundGraceSeconds: 3600 }).action).toBe("RELEASE");
    expect(nextStep(condition, { status: "FUNDED", verdict: allow }, "2026-11-16T01:00:01Z", { refundGraceSeconds: 3600 }).action).toBe("REFUND");
    expect(deadlinePassed(condition, "2026-11-15T23:59:59Z")).toBe(false);
  });

  it("final states and unfunded milestones do nothing", () => {
    expect(nextStep(condition, { status: "RELEASED", verdict: allow }, afterDeadline)).toMatchObject({ action: "NONE" });
    expect(nextStep(condition, { status: "REFUNDED" }, inWindow)).toMatchObject({ action: "NONE" });
    expect(nextStep(condition, { status: "CREATED" }, inWindow)).toMatchObject({ action: "WAIT", reason: "NOT_FUNDED" });
  });

  it("disputed milestones wait for the resolver until the deadline", () => {
    expect(nextStep(condition, { status: "DISPUTED", verdict: review }, inWindow)).toEqual({ action: "WAIT", reason: "AWAITING_RESOLUTION", actor: "dispute_resolver" });
  });

  it("applies transitions and refuses impossible ones", () => {
    const funded: MilestoneState = { status: "FUNDED", verdict: allow };
    expect(applyAction(funded, "RELEASE").status).toBe("RELEASED");
    expect(applyAction(funded, "ESCALATE").status).toBe("DISPUTED");
    expect(applyAction({ status: "DISPUTED" }, "REFUND").status).toBe("REFUNDED");
    expect(() => applyAction({ status: "RELEASED" }, "REFUND")).toThrow(/cannot REFUND/);
    expect(() => applyAction({ status: "CREATED" }, "RELEASE")).toThrow(/cannot RELEASE/);
  });
});
