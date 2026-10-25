import { describe, expect, it } from "vitest";
import { decide, type CriterionResult } from "../src/criteria.ts";

const pass = (id: string): CriterionResult => ({ id, verifier: "t", result: "PASS", code: "OK", reason: "", mandatory: true });
const fail = (id: string, code: CriterionResult["code"]): CriterionResult => ({ ...pass(id), result: "FAIL", code });
const unknown = (id: string, code: CriterionResult["code"]): CriterionResult => ({ ...pass(id), result: "UNKNOWN", code });

describe("decide", () => {
  it("allows only when everything mandatory passes and the score clears the threshold", () => {
    expect(decide([pass("a"), pass("b")], 85)).toMatchObject({ decision: "ALLOW", reasons: ["OK"], semanticScore: 85 });
    expect(decide([pass("a")])).toMatchObject({ decision: "ALLOW", reasons: ["OK"] });
  });

  it("never allows with no criteria", () => {
    expect(decide([], 100)).toMatchObject({ decision: "REVIEW", reasons: ["NO_CRITERIA"] });
  });

  it("denies on any mandatory failure, listing every distinct code", () => {
    const v = decide([pass("a"), fail("b", "MERCHANT_MISMATCH"), fail("c", "AMOUNT_OVER_MAX"), fail("d", "MERCHANT_MISMATCH")], 95);
    expect(v.decision).toBe("DENY");
    expect(v.reasons).toEqual(["MERCHANT_MISMATCH", "AMOUNT_OVER_MAX"]);
  });

  it("escalates on any mandatory unknown when nothing failed", () => {
    expect(decide([pass("a"), unknown("b", "DOCUMENT_ILLEGIBLE")], 90)).toMatchObject({
      decision: "REVIEW",
      reasons: ["DOCUMENT_ILLEGIBLE"],
    });
  });

  it("a failure outranks an unknown", () => {
    expect(decide([unknown("a", "DOC_DATE_UNREADABLE"), fail("b", "ITEMS_MISMATCH")]).decision).toBe("DENY");
  });

  it("ignores non-mandatory criteria", () => {
    const informational: CriterionResult = { ...unknown("fx", "DOC_CURRENCY_UNKNOWN"), mandatory: false };
    expect(decide([pass("a"), informational], 80).decision).toBe("ALLOW");
  });

  it("bands the semantic score: deny below the floor, review below the threshold", () => {
    expect(decide([pass("a")], 39)).toMatchObject({ decision: "DENY", reasons: ["LOW_CONFIDENCE"] });
    expect(decide([pass("a")], 40)).toMatchObject({ decision: "REVIEW", reasons: ["LOW_CONFIDENCE"] });
    expect(decide([pass("a")], 69).decision).toBe("REVIEW");
    expect(decide([pass("a")], 70).decision).toBe("ALLOW");
  });

  it("honours a custom policy", () => {
    const strict = { semanticThreshold: 90, semanticReviewFloor: 60, policyVersion: "strict-1" };
    expect(decide([pass("a")], 85, strict)).toMatchObject({ decision: "REVIEW", policyVersion: "strict-1" });
  });
});
