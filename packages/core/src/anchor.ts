import { canonicalize, sha256Hex } from "./canonical.ts";
import { VerificationEnvelopeSchema, verifyEnvelope, type EnvelopeCheck, type VerificationEnvelope } from "./envelope.ts";

/**
 * Anchoring: the signed envelope is stored somewhere public (IPFS, object
 * storage) and a short reference to it is written where the escrow can carry
 * text, e.g. the milestone's `evidence` field in Trustless Work. Anyone who
 * reads the escrow can fetch the envelope and check that it is the one the
 * reference names, that its signature holds, and that it talks about this
 * agreement and condition. This answers the research note's open question:
 * the verdict is a signed, anchored artifact.
 */

export const ANCHOR_PREFIX = "verdict-v1";

export interface AnchorReference {
  /** sha256 of the canonical envelope bytes. */
  sha256: string;
  /** Where to fetch it: ipfs://<cid> or https://... */
  uri: string;
}

/** The exact bytes to store. Canonical, so the hash is the same for everyone. */
export function envelopeBytes(envelope: VerificationEnvelope): string {
  return canonicalize(VerificationEnvelopeSchema.parse(envelope));
}

export function anchorReference(envelope: VerificationEnvelope, uri: string): AnchorReference {
  return { sha256: sha256Hex(envelopeBytes(envelope)), uri };
}

/** `verdict-v1 sha256=<hex> uri=<uri>` */
export function formatAnchorReference(ref: AnchorReference): string {
  return `${ANCHOR_PREFIX} sha256=${ref.sha256} uri=${ref.uri}`;
}

export function parseAnchorReference(text: string): AnchorReference | null {
  const m = /^verdict-v1 sha256=([0-9a-f]{64}) uri=(\S+)$/.exec(text.trim());
  return m ? { sha256: m[1], uri: m[2] } : null;
}

export type Fetcher = (url: string) => Promise<string>;

export interface ResolveOptions {
  fetch?: Fetcher;
  /** Gateway used for ipfs:// references. */
  ipfsGateway?: string;
  /** Extra expectations the caller knows from the escrow. */
  expect?: { agreementId?: string; milestoneId?: string; conditionHash?: string; verifier?: string };
}

export type ResolvedEnvelope =
  | { ok: true; envelope: VerificationEnvelope; bytes: string }
  | { ok: false; reason: string };

const defaultFetch: Fetcher = async (url) => {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
  return res.text();
};

export function toGatewayUrl(uri: string, gateway = "https://ipfs.io/ipfs/"): string {
  return uri.startsWith("ipfs://") ? gateway + uri.slice("ipfs://".length) : uri;
}

/** Fetches, re-hashes, re-verifies and cross-checks an anchored envelope. */
export async function resolveEnvelope(ref: AnchorReference, options: ResolveOptions = {}): Promise<ResolvedEnvelope> {
  const fetcher = options.fetch ?? defaultFetch;
  let text: string;
  try {
    text = await fetcher(toGatewayUrl(ref.uri, options.ipfsGateway));
  } catch (error) {
    return { ok: false, reason: `fetch: ${(error as Error).message}` };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, reason: "anchored content is not JSON" };
  }

  const check: EnvelopeCheck = verifyEnvelope(parsed);
  if (!check.ok) return check;
  const envelope = VerificationEnvelopeSchema.parse(parsed);

  // Hash the canonical form, so whitespace or key order at rest never matters.
  const bytes = envelopeBytes(envelope);
  if (sha256Hex(bytes) !== ref.sha256) return { ok: false, reason: "anchored envelope does not match the reference hash" };

  const e = options.expect ?? {};
  if (e.agreementId && envelope.agreementId !== e.agreementId) return { ok: false, reason: "envelope is for another agreement" };
  if (e.milestoneId && envelope.milestoneId !== e.milestoneId) return { ok: false, reason: "envelope is for another milestone" };
  if (e.conditionHash && envelope.conditionHash !== e.conditionHash) return { ok: false, reason: "envelope is for another condition" };
  if (e.verifier && envelope.verifier !== e.verifier) return { ok: false, reason: "envelope signed by an unexpected verifier" };

  return { ok: true, envelope, bytes };
}
