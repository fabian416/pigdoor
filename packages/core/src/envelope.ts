import { Keypair } from "@stellar/stellar-base";
import { z } from "zod";
import { hashCanonical } from "./canonical.ts";
import { EvidenceType, StellarAddress } from "./condition.ts";
import { CriterionResultSchema, VerdictSchema, VerifierType } from "./criteria.ts";

const Hex64 = z.string().regex(/^[0-9a-f]{64}$/, "not a sha256 hex digest");

export const EvidenceItemSchema = z.object({
  type: EvidenceType,
  /** Where the blob lives (private storage URL, IPFS CID...). Never the blob itself. */
  uri: z.string().min(1),
  sha256: Hex64,
  mimeType: z.string().min(1),
  /** Address of whoever uploaded it. */
  uploader: z.string().min(1),
  createdAt: z.iso.datetime(),
});
export type EvidenceItem = z.infer<typeof EvidenceItemSchema>;

/**
 * Field names follow the Trustless Work `VerificationEnvelope` research sketch
 * (agentic-escrow-research, research-notes/verification-and-evidence-envelope-2026-09-21.md)
 * so their tooling can read ours. `conditionHash` is our one addition: it binds
 * the verdict to the frozen condition.
 */
export const VerificationEnvelopeSchema = z.object({
  agreementId: z.string().min(1),
  milestoneId: z.string().min(1),
  verifier: StellarAddress,
  verifierType: VerifierType,
  criteria: z.array(CriterionResultSchema),
  evidence: z.array(EvidenceItemSchema),
  proofHash: Hex64,
  signature: z.string().min(1),
  verdict: VerdictSchema,
  timestamp: z.iso.datetime(),
  conditionHash: Hex64,
});
export type VerificationEnvelope = z.infer<typeof VerificationEnvelopeSchema>;

export type UnsignedEnvelope = Omit<VerificationEnvelope, "signature" | "proofHash">;

/** Domain separator so a verdict signature can never be replayed as a Stellar transaction. */
export const SIGNING_DOMAIN = "conditional-release-verdict-v1:";

/** What was evaluated: the condition and the evidence, nothing else. */
export function computeProofHash(conditionHash: string, evidence: EvidenceItem[]): string {
  return hashCanonical({ conditionHash, evidence: evidence.map((e) => e.sha256).sort() });
}

/** The bytes the verifier signs: domain + hash of the whole envelope minus the signature. */
export function signingPayload(envelope: Omit<VerificationEnvelope, "signature">): Buffer {
  const { signature: _ignored, ...rest } = envelope as VerificationEnvelope;
  return Buffer.from(SIGNING_DOMAIN + hashCanonical(rest), "utf8");
}

/** Builds and signs an envelope. The verifier key is a Stellar keypair, so `verifier` is its G address. */
export function signEnvelope(unsigned: UnsignedEnvelope, verifierKey: Keypair): VerificationEnvelope {
  if (unsigned.verifier !== verifierKey.publicKey()) {
    throw new Error("envelope.verifier must be the signing key's public address");
  }
  const proofHash = computeProofHash(unsigned.conditionHash, unsigned.evidence);
  const body = { ...unsigned, proofHash };
  const signature = verifierKey.sign(signingPayload(body)).toString("base64");
  return VerificationEnvelopeSchema.parse({ ...body, signature });
}

export type EnvelopeCheck = { ok: true } | { ok: false; reason: string };

/** Anyone can check an envelope: schema, proofHash and the verifier's ed25519 signature. */
export function verifyEnvelope(candidate: unknown): EnvelopeCheck {
  const parsed = VerificationEnvelopeSchema.safeParse(candidate);
  if (!parsed.success) return { ok: false, reason: `schema: ${parsed.error.issues[0]?.message ?? "invalid"}` };
  const env = parsed.data;

  if (computeProofHash(env.conditionHash, env.evidence) !== env.proofHash) {
    return { ok: false, reason: "proofHash does not match condition and evidence" };
  }
  if (!env.verifier.startsWith("G")) return { ok: false, reason: "verifier must be an account (G) address" };

  const { signature, ...body } = env;
  let valid = false;
  try {
    valid = Keypair.fromPublicKey(env.verifier).verify(signingPayload(body), Buffer.from(signature, "base64"));
  } catch {
    valid = false;
  }
  return valid ? { ok: true } : { ok: false, reason: "signature does not verify against verifier" };
}
