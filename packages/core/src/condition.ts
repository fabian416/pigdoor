import { z } from "zod";
import { hashCanonical } from "./canonical.ts";

/** G (account) or C (contract) Stellar address. */
export const StellarAddress = z.string().regex(/^[GC][A-Z2-7]{55}$/, "not a Stellar address");

/** Decimal string with at most 7 decimals, e.g. "100" or "100.5". */
export const Amount = z.string().regex(/^\d+(\.\d{1,7})?$/, "not a valid amount");

export const EvidenceType = z.enum(["invoice_photo", "receipt_photo", "delivery_note_photo", "task_photo", "document"]);
export type EvidenceType = z.infer<typeof EvidenceType>;

/**
 * How the release relates to the payment.
 * - `escrow_funded`: the escrow pays a third party (a store) on release, so the
 *   settlement itself is checked: destination, amount, window. Two verifiers.
 * - `payee_prepaid`: the release IS the payment to the person who did the
 *   thing (an allowance). There is no settlement to check beyond the escrow's
 *   own integrity. One verifier.
 */
export const SettlementRole = z.enum(["escrow_funded", "payee_prepaid"]);
export type SettlementRole = z.infer<typeof SettlementRole>;

const base = {
  version: z.literal("1"),
  payer: StellarAddress,
  receiver: StellarAddress,
  receiverName: z.string().min(1),
  asset: z.object({ code: z.string().min(1), issuer: StellarAddress }),
  maxAmount: Amount,
  window: z.object({ notBefore: z.iso.datetime(), notAfter: z.iso.datetime() }),
  settlement: z.object({ role: SettlementRole }),
  evidence: z.object({ type: EvidenceType, mustShow: z.array(z.string().min(1)).min(1) }),
  sourceText: z.string(),
};

/** Money for goods: the document must name the merchant, the items, a date and a total. */
export const PurchaseConditionSchema = z.object({
  ...base,
  kind: z.literal("purchase"),
  category: z.string().min(1),
  items: z.array(z.string().min(1)).min(1),
});

/** Money for a task: the photo must show the task done. */
export const TaskConditionSchema = z.object({
  ...base,
  kind: z.literal("task"),
  task: z.object({
    title: z.string().min(1),
    /** What "done" looks like, one observable statement each. */
    doneWhen: z.array(z.string().min(1)).min(1),
  }),
});

/**
 * The condition the payer commits to before funds are locked. It is frozen by
 * its hash: once the escrow references `conditionHash`, nobody can move the
 * goalposts. Natural-language input lives in `sourceText` so an auditor can
 * compare what was said with what was encoded.
 */
export const ConditionSchema = z
  .discriminatedUnion("kind", [PurchaseConditionSchema, TaskConditionSchema])
  .refine((c) => Date.parse(c.window.notBefore) < Date.parse(c.window.notAfter), {
    message: "window.notBefore must precede window.notAfter",
    path: ["window"],
  });

export type Condition = z.infer<typeof ConditionSchema>;
export type PurchaseCondition = z.infer<typeof PurchaseConditionSchema>;
export type TaskCondition = z.infer<typeof TaskConditionSchema>;

/** sha256 of the canonical condition. This is what the escrow and the envelope reference. */
export function conditionHash(condition: Condition): string {
  return hashCanonical(ConditionSchema.parse(condition));
}
