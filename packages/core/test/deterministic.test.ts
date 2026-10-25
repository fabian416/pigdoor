import { describe, expect, it } from "vitest";
import { checkDeterministic, deterministicVerifier } from "../src/deterministic.ts";
import { condition, goodFacts, stranger } from "./fixtures.ts";

const byId = (results: ReturnType<typeof checkDeterministic>) =>
  Object.fromEntries(results.map((r) => [r.id, r]));

describe("deterministic verifier", () => {
  it("passes every check on the happy path", async () => {
    const results = await deterministicVerifier.verify({ condition, facts: goodFacts });
    expect(results).toHaveLength(5);
    expect(results.every((r) => r.result === "PASS" && r.code === "OK" && r.mandatory)).toBe(true);
  });

  it("binds the verification to the condition the escrow committed to", () => {
    const swapped = { ...condition, maxAmount: "1000" };
    const r = byId(checkDeterministic(swapped, goodFacts));
    expect(r.condition_matches_escrow).toMatchObject({ result: "FAIL", code: "CONDITION_MISMATCH" });
    const uncommitted = byId(checkDeterministic(condition, { ...goodFacts, committedConditionHash: undefined }));
    expect(uncommitted.condition_matches_escrow).toMatchObject({ result: "UNKNOWN", code: "CONDITION_NOT_COMMITTED" });
  });

  it("fails when the milestone pays someone else", () => {
    const r = byId(checkDeterministic(condition, { ...goodFacts, milestoneReceiver: stranger.publicKey() }));
    expect(r.destination_matches.result).toBe("FAIL");
    expect(r.destination_matches.code).toBe("DESTINATION_MISMATCH");
  });

  it("fails when the milestone exceeds the committed maximum, even by a stroop", () => {
    expect(byId(checkDeterministic(condition, { ...goodFacts, milestoneAmount: "100.0000001" })).amount_within_max.code).toBe(
      "AMOUNT_OVER_MAX",
    );
    expect(byId(checkDeterministic(condition, { ...goodFacts, milestoneAmount: "0" })).amount_within_max.result).toBe("FAIL");
    expect(byId(checkDeterministic(condition, { ...goodFacts, milestoneAmount: "99.9999999" })).amount_within_max.result).toBe("PASS");
  });

  it("fails when the evidence arrives outside the window", () => {
    const late = byId(checkDeterministic(condition, { ...goodFacts, evidenceSubmittedAt: "2026-11-16T00:00:00Z" }));
    expect(late.evidence_within_window.code).toBe("EVIDENCE_OUT_OF_WINDOW");
    const early = byId(checkDeterministic(condition, { ...goodFacts, evidenceSubmittedAt: "2026-08-01T00:00:00Z" }));
    expect(early.evidence_within_window.result).toBe("FAIL");
  });

  it("fails when funding is not confirmed on-chain", () => {
    const r = byId(checkDeterministic(condition, { ...goodFacts, fundedAt: null, fundingTxHash: undefined }));
    expect(r.escrow_funded.code).toBe("ESCROW_NOT_FUNDED");
  });
});
