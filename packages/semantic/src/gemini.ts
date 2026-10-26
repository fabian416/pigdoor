import * as z from "zod";
import type { ModelRequest, ModelResult, StructuredModel } from "./model.ts";

/**
 * Gemini detras del mismo `StructuredModel`.
 *
 * El verificador nunca sabe que modelo mira la foto: todo aguas abajo depende
 * de la interfaz, no del proveedor. Por eso agregar Gemini es un archivo nuevo
 * y no un cambio en el camino de Anthropic, que sigue intacto.
 *
 * La regla no se mueve: el modelo solo extrae campos. No recibe el tope, ni la
 * politica, ni la nocion de veredicto. Quien decide es el codigo deterministico.
 */

export const DEFAULT_GEMINI_MODEL = "gemini-2.5-flash";

const BASE = "https://generativelanguage.googleapis.com/v1beta/models";

type GeminiPart = { text: string } | { inline_data: { mime_type: string; data: string } };

/**
 * Gemini acepta JSON Schema completo en `responseJsonSchema`, asi que el
 * esquema sale del mismo zod que usa el resto. `io: "output"` es importante:
 * queremos la forma que el modelo tiene que DEVOLVER, no la de entrada.
 */
function jsonSchemaFor(schema: z.ZodType): unknown {
  const out = z.toJSONSchema(schema, { io: "output" }) as Record<string, unknown>;
  delete out.$schema; // Gemini rechaza la anotacion de dialecto
  return out;
}

/**
 * Colapsa corridas de espacios en las cadenas. Con salida estructurada el
 * modelo a veces entra en bucle y devuelve "Lavarropas autom" seguido de
 * cientos de saltos de linea: eso termina impreso en el motivo del criterio y
 * dentro del sobre firmado. Juntar blancos no cambia lo que dijo, solo evita
 * que un artefacto del decodificador quede como evidencia.
 */
function squash(value: unknown): unknown {
  if (typeof value === "string") return value.replace(/\s+/g, " ").trim();
  if (Array.isArray(value)) return value.map(squash);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, squash(v)]));
  }
  return value;
}

export function geminiModel(
  options: { apiKey?: string; model?: string; fetchImpl?: typeof fetch } = {},
): StructuredModel {
  const apiKey = options.apiKey ?? process.env.GEMINI_API_KEY;
  const model = options.model ?? DEFAULT_GEMINI_MODEL;
  const doFetch = options.fetchImpl ?? fetch;
  if (!apiKey) throw new Error("geminiModel: missing GEMINI_API_KEY");

  return async <S extends z.ZodType>(req: ModelRequest<S>): Promise<ModelResult<z.infer<S>>> => {
    const parts: GeminiPart[] = [];
    if (req.image) {
      parts.push({ inline_data: { mime_type: req.image.mediaType, data: req.image.base64 } });
    }
    parts.push({ text: req.text });

    let res: Response;
    try {
      res = await doFetch(`${BASE}/${model}:generateContent?key=${apiKey}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: req.system }] },
          contents: [{ role: "user", parts }],
          generationConfig: {
            responseMimeType: "application/json",
            responseJsonSchema: jsonSchemaFor(req.schema),
            temperature: 0.2,
          },
        }),
      });
    } catch (error) {
      return { ok: false, code: "MODEL_ERROR", message: `network: ${String(error)}` };
    }

    const body = (await res.json().catch(() => null)) as Record<string, any> | null;
    if (!res.ok) {
      const detail = body?.error?.message ?? res.statusText;
      return { ok: false, code: "MODEL_ERROR", message: `API ${res.status}: ${detail}` };
    }

    const candidate = body?.candidates?.[0];
    // SAFETY, RECITATION y PROHIBITED_CONTENT son la negativa del modelo; no se
    // confunden con una lectura invalida, porque la accion del backend difiere.
    const finish = candidate?.finishReason;
    if (finish && finish !== "STOP") {
      if (finish === "SAFETY" || finish === "PROHIBITED_CONTENT" || finish === "RECITATION") {
        return { ok: false, code: "MODEL_REFUSED", message: `finishReason=${finish}` };
      }
      return { ok: false, code: "MODEL_OUTPUT_INVALID", message: `finishReason=${finish}` };
    }

    const text = candidate?.content?.parts?.map((p: GeminiPart) => ("text" in p ? p.text : "")).join("") ?? "";
    if (!text.trim()) {
      return { ok: false, code: "MODEL_OUTPUT_INVALID", message: "empty response" };
    }

    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      return { ok: false, code: "MODEL_OUTPUT_INVALID", message: "response was not JSON" };
    }

    // El esquema se vuelve a aplicar de este lado: que el proveedor prometa
    // structured output no alcanza para dar por buena su salida.
    const parsed = req.schema.safeParse(squash(raw));
    if (!parsed.success) {
      return { ok: false, code: "MODEL_OUTPUT_INVALID", message: parsed.error.message.slice(0, 300) };
    }
    return { ok: true, value: parsed.data };
  };
}
