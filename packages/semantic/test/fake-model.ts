import type { StructuredModel } from "../src/model.ts";

/** A model that returns a fixed reading, or a fixed failure. Records what it was asked. */
export function fakeModel(outcome: { value: unknown } | { code: "MODEL_OUTPUT_INVALID" | "MODEL_REFUSED" | "MODEL_ERROR" }) {
  const calls: { system: string; text: string; hasImage: boolean }[] = [];
  const model: StructuredModel = async (req) => {
    calls.push({ system: req.system, text: req.text, hasImage: Boolean(req.image) });
    if ("code" in outcome) return { ok: false, code: outcome.code, message: "fake" };
    const parsed = req.schema.safeParse(outcome.value);
    if (!parsed.success) return { ok: false, code: "MODEL_OUTPUT_INVALID", message: parsed.error.message };
    return { ok: true, value: parsed.data };
  };
  return { model, calls };
}
