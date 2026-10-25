import type { EscrowFacts } from "@witness/core";

/**
 * The escrow provider behind an interface. The verifier service never talks
 * to Trustless Work directly, so the demo runs on `inMemoryEscrowClient` today
 * and switches to the real API by swapping one object.
 */
export interface EscrowClient {
  /** What the escrow says about a milestone right now. */
  getMilestoneFacts(agreementId: string, milestoneId: string): Promise<EscrowFacts>;
  /** Writes the anchor line into the milestone's evidence field. */
  writeAnchor(agreementId: string, milestoneId: string, anchorLine: string): Promise<void>;
  /** Approves and releases the milestone with the verifier's key. */
  releaseMilestone(agreementId: string, milestoneId: string): Promise<{ txHash: string }>;
  /** Flags the milestone for the dispute resolvers. */
  disputeMilestone(agreementId: string, milestoneId: string, reason: string): Promise<void>;
}

export interface InMemoryMilestone {
  facts: EscrowFacts;
  anchor?: string;
  released?: { txHash: string };
  disputed?: string;
}

/** Deterministic fake for tests and the offline demo. Keys are `${agreementId}/${milestoneId}`. */
export function inMemoryEscrowClient(seed: Record<string, EscrowFacts> = {}) {
  const milestones = new Map<string, InMemoryMilestone>(Object.entries(seed).map(([k, facts]) => [k, { facts }]));
  const key = (a: string, m: string) => `${a}/${m}`;
  const get = (a: string, m: string) => {
    const row = milestones.get(key(a, m));
    if (!row) throw new Error(`unknown milestone ${key(a, m)}`);
    return row;
  };
  let releases = 0;

  const client: EscrowClient = {
    async getMilestoneFacts(a, m) {
      return get(a, m).facts;
    },
    async writeAnchor(a, m, line) {
      get(a, m).anchor = line;
    },
    async releaseMilestone(a, m) {
      const row = get(a, m);
      if (row.released) throw new Error("milestone already released");
      row.released = { txHash: `fake-${(++releases).toString(16).padStart(64, "0")}` };
      return row.released;
    },
    async disputeMilestone(a, m, reason) {
      get(a, m).disputed = reason;
    },
  };
  return { client, milestones, set: (a: string, m: string, facts: EscrowFacts) => milestones.set(key(a, m), { facts }) };
}

export interface TrustlessWorkConfig {
  /** V2 testnet: https://beta.api.trustlesswork.com (to confirm against the live docs). */
  baseUrl: string;
  apiKey: string;
  /** Secret of the key listed in the escrow's releaseSigners / approver roles. */
  releaseSignerSecret: string;
}

/**
 * Real provider. Left as a precise TODO list on purpose: every call below is
 * one endpoint of the Trustless Work V2 API, and the names come from their
 * docs, but nothing here has been exercised against testnet yet. Fill in after
 * the integration spike, then run the same tests against it.
 */
export function trustlessWorkClient(_config: TrustlessWorkConfig): EscrowClient {
  const notWired = (what: string) => async (): Promise<never> => {
    throw new Error(`trustlessWorkClient.${what}: not wired yet (pending the V2 testnet spike)`);
  };
  return {
    // GET escrow by contract id -> milestones[idx].{receiver, amount, evidence, status}; funding from the funding tx.
    getMilestoneFacts: notWired("getMilestoneFacts"),
    // POST /escrow/multi-release/change-milestone-status { contractId, milestoneIndex, newStatus, newEvidence, serviceProvider }
    //   -> unsignedXdr -> sign with the serviceProvider key -> POST /stellar/send-transaction.
    writeAnchor: notWired("writeAnchor"),
    // POST /escrow/multi-release/approve-milestone then /release-milestone-funds { contractId, milestoneIndex, releaseSigner }
    //   -> unsignedXdr -> sign with releaseSignerSecret -> POST /stellar/send-transaction -> txHash.
    releaseMilestone: notWired("releaseMilestone"),
    // POST /escrow/multi-release/dispute-milestone { contractId, milestoneIndex, signer } -> sign -> send.
    disputeMilestone: notWired("disputeMilestone"),
  };
}
