import { z } from "zod";
import { hashCanonical } from "./canonical.ts";

/** G (account) or C (contract) Stellar address. */
export const StellarAddress = z.string().regex(/^[GC][A-Z2-7]{55}$/, "not a Stellar address");

/** Decimal string with at most 7 decimals, e.g. "100" or "100.5". */
export const Amount = z.string().regex(/^\d+(\.\d{1,7})?$/, "not a valid amount");

export const EvidenceType = z.enum(["invoice_photo", "receipt_photo", "delivery_note_photo", "document"]);
export type EvidenceType = z.infer<typeof EvidenceType>;

/**
 * The condition the payer commits to before funds are locked. It is frozen by
 * its hash: once the escrow references `conditionHash`, nobody can move the
 * goalposts. Natural-language input lives in `sourceText` so an auditor can
 * compare what was said with what was encoded.
 */
export const ConditionSchema = z
  .object({
    version: z.literal("1"),
    payer: StellarAddress,
    receiver: StellarAddress,
    receiverName: z.string().min(1),
    asset: z.object({ code: z.string().min(1), issuer: StellarAddress }),
    maxAmount: Amount,
    category: z.string().min(1),
    items: z.array(z.string().min(1)).min(1),
    window: z.object({ notBefore: z.iso.datetime(), notAfter: z.iso.datetime() }),
    evidence: z.object({ type: EvidenceType, mustShow: z.array(z.string().min(1)).min(1) }),
    sourceText: z.string(),
  })
  .refine((c) => Date.parse(c.window.notBefore) < Date.parse(c.window.notAfter), {
    message: "window.notBefore must precede window.notAfter",
    path: ["window"],
  });

export type Condition = z.infer<typeof ConditionSchema>;

/** sha256 of the canonical condition. This is what the escrow and the envelope reference. */
export function conditionHash(condition: Condition): string {
  return hashCanonical(ConditionSchema.parse(condition));
}
