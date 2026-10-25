import { describe, expect, it } from "vitest";
import { ConditionSchema, conditionHash } from "../src/condition.ts";
import { fromStroops, toStroops } from "../src/amount.ts";
import { condition, taskCondition } from "./fixtures.ts";

describe("condition", () => {
  it("accepts the demo condition and hashes it stably", () => {
    expect(ConditionSchema.parse(condition)).toEqual(condition);
    const reordered = { ...condition, items: [...condition.items] };
    expect(conditionHash(reordered)).toBe(conditionHash(condition));
    expect(conditionHash({ ...condition, maxAmount: "291" })).not.toBe(conditionHash(condition));
  });

  it("accepts a task condition and keeps the two kinds apart", () => {
    expect(ConditionSchema.parse(taskCondition)).toEqual(taskCondition);
    expect(conditionHash(taskCondition)).not.toBe(conditionHash(condition));
    expect(ConditionSchema.safeParse({ ...taskCondition, kind: "purchase" }).success).toBe(false);
    expect(ConditionSchema.safeParse({ ...condition, settlement: { role: "cash" } }).success).toBe(false);
  });

  it("rejects a window that ends before it starts", () => {
    const bad = { ...condition, window: { notBefore: condition.window.notAfter, notAfter: condition.window.notBefore } };
    expect(ConditionSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects malformed addresses and amounts", () => {
    expect(ConditionSchema.safeParse({ ...condition, receiver: "0xabc" }).success).toBe(false);
    expect(ConditionSchema.safeParse({ ...condition, maxAmount: "-5" }).success).toBe(false);
    expect(ConditionSchema.safeParse({ ...condition, maxAmount: "1.00000001" }).success).toBe(false);
  });
});

describe("amount", () => {
  it("round-trips through stroops", () => {
    expect(toStroops("100")).toBe(1_000_000_000n);
    expect(toStroops("0.0000001")).toBe(1n);
    expect(fromStroops(1_005_000_000n)).toBe("100.5000000");
    expect(fromStroops(1n)).toBe("0.0000001");
  });

  it("rejects what a wallet would never sign", () => {
    expect(() => toStroops("1e3")).toThrow(RangeError);
    expect(() => toStroops("-1")).toThrow(RangeError);
    expect(() => toStroops("1.12345678")).toThrow(RangeError);
  });
});
