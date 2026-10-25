import { describe, expect, it } from "vitest";
import { conditionHash } from "@witness/core";
import { bindCondition, draftCondition, type ConditionDraft } from "../src/trigger.ts";
import { fakeModel } from "./fake-model.ts";

const draft: ConditionDraft = {
  kind: "purchase",
  receiverName: "Corralón San Miguel",
  category: "materiales de construcción",
  items: ["cemento", "hierro"],
  earmarkedAmount: "100",
  freeAmount: "200",
  deadline: "2026-11-15",
  evidenceType: "receipt_photo",
  taskTitle: null,
  doneWhen: [],
  confidence: 92,
  ambiguities: [],
};

const taskDraft: ConditionDraft = {
  kind: "task",
  receiverName: "Sasha",
  category: null,
  items: [],
  earmarkedAmount: "2",
  freeAmount: null,
  deadline: "2026-11-01",
  evidenceType: "task_photo",
  taskTitle: "Hacer la cama",
  doneWhen: ["la cama está tendida", "la almohada está en su lugar"],
  confidence: 90,
  ambiguities: ["'el domingo' resolved to 2026-11-01"],
};

const binding = {
  payer: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  receiver: "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
  asset: { code: "USDC", issuer: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5" },
  settlementRole: "escrow_funded" as const,
  notBefore: "2026-10-25T18:00:00Z",
  defaultDeadline: "2026-12-25T18:00:00Z",
  sourceText: "200 libres, y 100 para cemento y hierro en el Corralón San Miguel, antes del 15 de noviembre.",
};

describe("trigger agent", () => {
  it("passes the reference date and the payer's words to the model", async () => {
    const { model, calls } = fakeModel({ value: draft });
    const result = await draftCondition(model, binding.sourceText, "2026-10-25");
    expect(result.ok).toBe(true);
    expect(calls[0].text).toContain("Reference date: 2026-10-25");
    expect(calls[0].text).toContain("Corralón San Miguel");
  });

  it("binds a draft into a valid, hashable condition", () => {
    const condition = bindCondition(draft, binding);
    expect(condition.maxAmount).toBe("100");
    expect(condition.window.notAfter).toBe("2026-11-15T23:59:59Z");
    expect(condition.evidence.mustShow).toContain("total");
    expect(conditionHash(condition)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("binds a task draft into a task condition with the payee-prepaid role", () => {
    const c = bindCondition(taskDraft, { ...binding, settlementRole: "payee_prepaid" });
    expect(c.kind).toBe("task");
    if (c.kind === "task") expect(c.task.doneWhen).toHaveLength(2);
    expect(c.settlement.role).toBe("payee_prepaid");
    expect(c.evidence.type).toBe("task_photo");
  });

  it("falls back to the default deadline when none was given", () => {
    expect(bindCondition({ ...draft, deadline: null }, binding).window.notAfter).toBe(binding.defaultDeadline);
  });

  it("refuses to freeze a condition whose window is already closed", () => {
    expect(() => bindCondition({ ...draft, deadline: "2026-10-01" }, binding)).toThrow();
  });

  it("surfaces model failures instead of guessing", async () => {
    const { model } = fakeModel({ code: "MODEL_REFUSED" });
    const result = await draftCondition(model, "whatever", "2026-10-25");
    expect(result).toMatchObject({ ok: false, code: "MODEL_REFUSED" });
  });
});
