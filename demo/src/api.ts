/**
 * The demo talks to services/verifier and to nothing else. No wallet, no login:
 * the point is the verification, not the onboarding.
 *
 * Shapes mirror services/verifier/src/app.ts. If that endpoint changes, this
 * breaks loudly rather than silently, which is what we want.
 */

export const VERIFIER =
  (import.meta.env.VITE_VERIFIER_URL as string | undefined)?.replace(/\/$/, "") ??
  "http://localhost:8787";

export type Decision = "ALLOW" | "DENY" | "REVIEW";

/**
 * The rate the service needs to compare a total on paper against a cap held in
 * another asset. It never guesses one: with no rate the amount check abstains
 * (`DOC_CURRENCY_UNKNOWN`) instead of inventing a conversion.
 */
export type Fx = { currency: string; unitsPerAsset: number };

/** packages/core → CriterionResult */
export type Criterion = {
  id: string;
  verifier: string;
  result: "PASS" | "FAIL" | "UNKNOWN";
  code: string;
  reason: string;
  mandatory: boolean;
};

export type Verdict = {
  decision: Decision;
  reasons: string[];
  semanticScore?: number;
  policyVersion?: string;
};

export type VerifyResponse = {
  id: string;
  envelope: {
    agreementId: string;
    milestoneId: string;
    verifier: string;
    verifierType: string;
    criteria: Criterion[];
    verdict: Verdict;
    conditionHash: string;
    timestamp: string;
    [k: string]: unknown;
  };
  anchor: string;
  nextStep: { action: string; [k: string]: unknown };
  status: string;
  release?: { txHash: string };
  /** What the model read, echoed for display. Nothing downstream reads it. */
  reading?: Record<string, unknown>;
};

/** sha256 of the raw bytes, hex. The envelope must name the bytes the model looked at. */
export async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function toBase64(bytes: ArrayBuffer): string {
  let s = "";
  const view = new Uint8Array(bytes);
  for (let i = 0; i < view.length; i += 0x8000) {
    s += String.fromCharCode(...view.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

export async function health(): Promise<boolean> {
  try {
    const r = await fetch(`${VERIFIER}/health`, { signal: AbortSignal.timeout(4000) });
    return r.ok;
  } catch {
    return false;
  }
}

export async function verify(input: {
  agreementId: string;
  milestoneId: string;
  condition: unknown;
  evidence: unknown[];
  image: { base64: string; mediaType: string };
  fx?: Fx;
}): Promise<VerifyResponse> {
  const { agreementId, milestoneId, ...body } = input;
  const r = await fetch(
    `${VERIFIER}/agreements/${agreementId}/milestones/${milestoneId}/verify`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  const json = await r.json();
  if (!r.ok) {
    throw new Error(json.error ? `${json.error}${json.detail ? `: ${json.detail}` : ""}` : `verifier returned ${r.status}`);
  }
  return json as VerifyResponse;
}

/** The sample evidence item, used by the canned path. Matches examples/lendoor/evidence.json. */
export const evidenceSample = [
  {
    type: "invoice_photo",
    uri: "s3://evidence/ana-1/factura.jpg",
    sha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    mimeType: "image/jpeg",
    uploader: "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
    createdAt: "2026-10-27T16:00:00Z",
  },
];

/**
 * Demo path: send a precomputed reading instead of a photo. The service only
 * accepts this when ACCEPT_READINGS=1, and it refuses to combine it with
 * AUTO_RELEASE, because a posted reading must never be able to move money.
 */
export async function verifyCanned(input: {
  agreementId: string;
  milestoneId: string;
  condition: unknown;
  evidence: unknown[];
  reading: unknown;
  fx?: Fx;
}): Promise<VerifyResponse> {
  const { agreementId, milestoneId, ...body } = input;
  const r = await fetch(
    `${VERIFIER}/agreements/${agreementId}/milestones/${milestoneId}/verify`,
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
  );
  const json = await r.json();
  if (!r.ok) {
    throw new Error(
      json.error
        ? `${json.error}${json.detail ? `: ${json.detail}` : ""}`
        : `verifier returned ${r.status}`,
    );
  }
  return json as VerifyResponse;
}
