import { describe, expect, it } from "vitest";
import { decide, type TaskCondition } from "@witness/core";
import { TASK_SYSTEM_PROMPT, assessTaskReading, evaluateDocument, type TaskReading } from "../src/semantic.ts";
import { fakeModel } from "./fake-model.ts";

const condition: TaskCondition = {
  version: "1",
  kind: "task",
  payer: "GCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC",
  receiver: "GDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD",
  receiverName: "Sasha",
  asset: { code: "USDC", issuer: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5" },
  maxAmount: "2",
  task: { title: "Hacer la cama", doneWhen: ["la cama está tendida", "la almohada está en su lugar", "no hay ropa sobre la cama"] },
  window: { notBefore: "2026-10-25T00:00:00Z", notAfter: "2026-11-01T23:59:59Z" },
  settlement: { role: "payee_prepaid" },
  evidence: { type: "task_photo", mustShow: ["the task done"] },
  sourceText: "2 USDC para Sasha cuando haga la cama, antes del domingo.",
};
const image = { base64: "AAAA", mediaType: "image/jpeg" as const };

const done: TaskReading = {
  sceneDescription: "A child's bedroom, bed made, pillow at the head, nothing on top.",
  taskVisible: "PASS",
  taskDone: "PASS",
  doneWhenObserved: ["la cama está tendida", "la almohada está en su lugar", "no hay ropa sobre la cama"],
  stagingSigns: [],
  photoQuality: 88,
  confidence: 91,
  notes: "",
};

const byId = (criteria: { id: string; result: string; code: string }[]) => Object.fromEntries(criteria.map((c) => [c.id, c]));

describe("task verifier (Piggy): the model describes, the rules decide", () => {
  it("releases the allowance when every done-when statement is visibly satisfied", async () => {
    const { model, calls } = fakeModel({ value: done });
    const outcome = await evaluateDocument(model, { condition, image });
    expect(calls[0].system).toBe(TASK_SYSTEM_PROMPT);
    expect(calls[0].text).toContain("Hacer la cama");
    expect(calls[0].text).not.toContain("2 USDC");
    expect(outcome.criteria.map((c) => c.result)).toEqual(["PASS", "PASS", "PASS", "PASS"]);
    expect(outcome.score).toBe(88);
    expect(decide(outcome.criteria, outcome.score).decision).toBe("ALLOW");
  });

  it("denies when the bed is not made", () => {
    const notDone: TaskReading = { ...done, taskDone: "FAIL", doneWhenObserved: [], sceneDescription: "Blanket bunched up, clothes on the mattress." };
    const criteria = assessTaskReading(condition, notDone);
    expect(byId(criteria).task_done).toMatchObject({ result: "FAIL", code: "TASK_NOT_DONE" });
    expect(decide(criteria, 30)).toMatchObject({ decision: "DENY", reasons: ["TASK_NOT_DONE"] });
  });

  it("denies when the photo shows something else entirely", () => {
    const elsewhere: TaskReading = { ...done, taskVisible: "FAIL", taskDone: "UNKNOWN", doneWhenObserved: [], sceneDescription: "A kitchen counter." };
    const c = byId(assessTaskReading(condition, elsewhere));
    expect(c.task_visible.code).toBe("TASK_NOT_VISIBLE");
    expect(c.task_done.result).toBe("FAIL");
  });

  it("a model that says PASS without observing every statement only reaches review", () => {
    const partial: TaskReading = { ...done, doneWhenObserved: ["la cama está tendida"] };
    const criteria = assessTaskReading(condition, partial);
    expect(byId(criteria).task_done.result).toBe("UNKNOWN");
    expect(decide(criteria, 60).decision).toBe("REVIEW");
  });

  it("staging signs send the photo to a human", () => {
    const staged: TaskReading = { ...done, stagingSigns: ["photo of a phone screen", "different room than described"] };
    const criteria = assessTaskReading(condition, staged);
    expect(byId(criteria).photo_not_staged).toMatchObject({ result: "UNKNOWN", code: "PHOTO_STAGED" });
    expect(decide(criteria, 60).decision).toBe("REVIEW");
  });

  it("a purchase reading is rejected for a task condition", async () => {
    const { model } = fakeModel({ value: { merchantNameOnDocument: "x", merchantMatches: "PASS", dateOnDocument: null, itemsOnDocument: [], itemsMatch: "PASS", totalOnDocument: null, currencyOnDocument: null, legibility: 90, confidence: 90, notes: "" } });
    const outcome = await evaluateDocument(model, { condition, image });
    expect(outcome.criteria[0].code).toBe("MODEL_OUTPUT_INVALID");
  });
});
