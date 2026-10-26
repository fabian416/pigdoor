import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { z } from "zod";

export type ImageMediaType = "image/jpeg" | "image/png" | "image/webp" | "image/gif";

export interface ModelRequest<S extends z.ZodType> {
  schema: S;
  system: string;
  text: string;
  image?: { base64: string; mediaType: ImageMediaType };
}

export type ModelResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: "MODEL_OUTPUT_INVALID" | "MODEL_REFUSED" | "MODEL_ERROR"; message: string };

/**
 * The one seam between "the model reads" and "the rules decide". Everything
 * downstream takes a `StructuredModel`, so tests inject a fake and production
 * injects Claude. The model never sees the decision policy.
 */
export type StructuredModel = <S extends z.ZodType>(req: ModelRequest<S>) => Promise<ModelResult<z.infer<S>>>;

export const DEFAULT_MODEL = "claude-opus-5-5";

/** Claude through the official SDK with structured outputs. Credentials resolve from the environment. */
export function anthropicModel(options: { client?: Anthropic; model?: string } = {}): StructuredModel {
  const client = options.client ?? new Anthropic();
  const model = options.model ?? DEFAULT_MODEL;

  return async (req) => {
    const content: Anthropic.ContentBlockParam[] = [];
    if (req.image) {
      content.push({ type: "image", source: { type: "base64", media_type: req.image.mediaType, data: req.image.base64 } });
    }
    content.push({ type: "text", text: req.text });

    try {
      const response = await client.messages.parse({
        model,
        // Thinking tokens count against max_tokens on this model; leave room.
        max_tokens: 16000,
        system: req.system,
        messages: [{ role: "user", content }],
        output_config: { effort: "high", format: zodOutputFormat(req.schema) },
      });
      if (response.stop_reason === "refusal") {
        return { ok: false, code: "MODEL_REFUSED", message: response.stop_details?.explanation ?? "model refused" };
      }
      if (response.parsed_output == null) {
        return { ok: false, code: "MODEL_OUTPUT_INVALID", message: `stop_reason=${response.stop_reason}` };
      }
      return { ok: true, value: response.parsed_output };
    } catch (error) {
      if (error instanceof Anthropic.APIError) {
        return { ok: false, code: "MODEL_ERROR", message: `API ${error.status}: ${error.message}` };
      }
      // parse() throws a plain AnthropicError on truncated or invalid JSON.
      if (error instanceof Anthropic.AnthropicError) {
        return { ok: false, code: "MODEL_OUTPUT_INVALID", message: error.message };
      }
      throw error;
    }
  };
}
