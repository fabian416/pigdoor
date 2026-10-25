import { describe, expect, it } from "vitest";
import { decide, type Condition } from "@workspace/core";
import { assessReading, evaluateDocument, scoreReading, type DocumentReading } from "../src/semantic.ts";
import { fakeModel } from "./fake-model.ts";

const condition: Condition = {
  version: "1",
  payer: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  receiver: "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
  receiverName: "Corralón San Miguel",
  asset: { code: "USDC", issuer: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5" },
  maxAmount: "100",
  category: "materiales de construcción",
  items: ["cemento", "hierro"],
  window: { notBefore: "2026-10-25T00:00:00Z", notAfter: "2026-11-15T23:59:59Z" },
  evidence: { type: "receipt_photo", mustShow: ["merchant name", "date", "items", "total"] },
  sourceText: "100 para cemento y hierro en el Corralón San Miguel, antes del 15 de noviembre.",
};

const image = { base64: "AAAA", mediaType: "image/jpeg" as const };

const goodReading: DocumentReading = {
  merchantNameOnDocument: "Corralon San Miguel - Materiales",
  merchantMatches: "PASS",
  dateOnDocument: "2026-10-30",
  itemsOnDocument: ["Cemento x10 bolsas", "Hierro 8mm x 20"],
  itemsMatch: "PASS",
  totalOnDocument: "118500",
  currencyOnDocument: "ARS",
  legibility: 85,
  confidence: 90,
  notes: "Handwritten delivery note, stamped.",
};

const byId = (criteria: { id: string; result: string; code: string; mandatory: boolean }[]) =>
  Object.fromEntries(criteria.map((c) => [c.id, c]));

describe("semantic verifier: the model reads, the rules decide", () => {
  it("happy path: a good receipt in pesos releases when the on-chain amount is bounded", async () => {
    const { model, calls } = fakeModel({ value: goodReading });
    const outcome = await evaluateDocument(model, { condition, image });
    const c = byId(outcome.criteria);

    expect(calls[0].hasImage).toBe(true);
    expect(calls[0].text).toContain("Corralón San Miguel");
    expect(calls[0].text).not.toContain("100"); // the model never learns the maximum
    expect(c.doc_merchant_matches.result).toBe("PASS");
    expect(c.doc_items_match.result).toBe("PASS");
    expect(c.doc_date_within_window.result).toBe("PASS");
    expect(c.doc_total_within_max).toMatchObject({ result: "UNKNOWN", code: "DOC_CURRENCY_UNKNOWN", mandatory: false });
    expect(outcome.score).toBe(85);
    expect(decide(outcome.criteria, outcome.score).decision).toBe("ALLOW");
  });

  it("converts the total when a rate is supplied and blocks when it exceeds the maximum", () => {
    const within = byId(assessReading(condition, goodReading, { currency: "ARS", unitsPerAsset: 1450 }));
    expect(within.doc_total_within_max).toMatchObject({ result: "PASS", mandatory: true });
    const over = byId(assessReading(condition, goodReading, { currency: "ARS", unitsPerAsset: 1000 }));
    expect(over.doc_total_within_max).toMatchObject({ result: "FAIL", code: "DOC_TOTAL_OVER_MAX" });
  });

  it("rejection path: receipt from another shop", async () => {
    const { model } = fakeModel({
      value: { ...goodReading, merchantNameOnDocument: "Almacén Don Pepe", merchantMatches: "FAIL", itemsOnDocument: ["fideos", "yerba"], itemsMatch: "FAIL" },
    });
    const outcome = await evaluateDocument(model, { condition, image });
    expect(outcome.score).toBeLessThanOrEqual(30);
    const verdict = decide(outcome.criteria, outcome.score);
    expect(verdict.decision).toBe("DENY");
    expect(verdict.reasons).toEqual(["MERCHANT_MISMATCH", "ITEMS_MISMATCH"]);
  });

  it("rejection path: receipt dated in August", () => {
    const c = byId(assessReading(condition, { ...goodReading, dateOnDocument: "2026-08-03" }));
    expect(c.doc_date_within_window).toMatchObject({ result: "FAIL", code: "DOC_DATE_OUT_OF_WINDOW" });
    expect(decide(assessReading(condition, { ...goodReading, dateOnDocument: "2026-08-03" })).decision).toBe("DENY");
  });

  it("goes to review when the document cannot be read", async () => {
    const reading: DocumentReading = {
      ...goodReading,
      merchantNameOnDocument: null,
      merchantMatches: "UNKNOWN",
      dateOnDocument: null,
      itemsOnDocument: [],
      itemsMatch: "UNKNOWN",
      totalOnDocument: null,
      legibility: 20,
      confidence: 25,
    };
    const { model } = fakeModel({ value: reading });
    const outcome = await evaluateDocument(model, { condition, image });
    expect(byId(outcome.criteria).doc_legible.code).toBe("DOCUMENT_ILLEGIBLE");
    expect(outcome.score).toBe(20);
    // Unknowns escalate; a low score alone would deny, but unknowns are checked first.
    expect(decide(outcome.criteria, outcome.score).decision).toBe("REVIEW");
  });

  it("goes to review, never to release, when the model output is invalid or refused", async () => {
    for (const code of ["MODEL_OUTPUT_INVALID", "MODEL_REFUSED", "MODEL_ERROR"] as const) {
      const { model } = fakeModel({ code });
      const outcome = await evaluateDocument(model, { condition, image });
      expect(outcome.score).toBeUndefined();
      expect(outcome.criteria).toHaveLength(1);
      expect(outcome.criteria[0]).toMatchObject({ result: "UNKNOWN", code });
      expect(decide(outcome.criteria, outcome.score).decision).toBe("REVIEW");
    }
  });

  it("drops a reading that violates the schema instead of trusting it", async () => {
    const { model } = fakeModel({ value: { ...goodReading, legibility: 250 } });
    const outcome = await evaluateDocument(model, { condition, image });
    expect(outcome.criteria[0].code).toBe("MODEL_OUTPUT_INVALID");
  });

  it("score is capped by legibility and by the worst outcome", () => {
    const passAll = assessReading(condition, { ...goodReading, legibility: 50, confidence: 99 });
    expect(scoreReading({ ...goodReading, legibility: 50, confidence: 99 }, passAll)).toBe(50);
    const oneUnknown = assessReading(condition, { ...goodReading, dateOnDocument: null });
    expect(scoreReading({ ...goodReading, dateOnDocument: null }, oneUnknown)).toBe(60);
  });
});
