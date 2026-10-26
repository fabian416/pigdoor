import type { EscrowFacts } from "@witness/core";

/**
 * The escrow provider behind an interface. The verifier service never talks
 * to Trustless Work directly, so the demo runs on `inMemoryEscrowClient` today
 * and switches to the real API by swapping one object.
 */
export interface EscrowClient {
  /** What the escrow says about a milestone right now, including its status. */
  getMilestoneFacts(agreementId: string, milestoneId: string): Promise<EscrowFacts>;
  /**
   * Writes the anchor line into the milestone's evidence field. In Trustless
   * Work this is signed by a serviceProvider, so either the verifier key is
   * also listed there or the product backend performs this call.
   */
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
      const row = get(a, m);
      const status = row.released ? "RELEASED" : row.disputed ? "DISPUTED" : "FUNDED";
      return { ...row.facts, status };
    },
    async writeAnchor(a, m, line) {
      get(a, m).anchor = line;
    },
    async releaseMilestone(a, m) {
      const row = get(a, m);
      if (row.released) throw new Error("milestone already released");
      if (row.disputed) throw new Error("milestone is disputed");
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
  /** V2: https://beta.api.trustlesswork.com (V1 at dev.api / api is a different, incompatible API). */
  baseUrl: string;
  /** `<id>.<secret>`, sent as `x-api-key`. Self-service at dapp.trustlesswork.com. */
  apiKey: string;
  /** Secret of the verifier key, listed in the escrow's approvers AND releaseSigners (and serviceProviders if it writes the anchor). */
  releaseSignerSecret: string;
}

/**
 * Real provider against Trustless Work V2 multi-release escrows. Every method
 * is one or two endpoints; the shapes below come from the V2 OpenAPI
 * (`/api/all-json`) and the audit scripts, and NOTHING here has run against
 * testnet yet. Wire it as soon as a key exists, then run the same tests.
 *
 * Milestone ids in this service are 1-based strings ("1"); Trustless Work uses
 * 0-based indices: index = Number(milestoneId) - 1.
 *
 * Writes return `{ unsignedXdr, txHash }`: sign the XDR exactly as given with
 * the role's key and POST it to `/stellar/send-transaction { signedXdr }`.
 */
export function trustlessWorkClient(_config: TrustlessWorkConfig): EscrowClient {
  const notWired = (what: string) => async (): Promise<never> => {
    throw new Error(`trustlessWorkClient.${what}: not wired yet (pending the V2 testnet spike)`);
  };
  return {
    // GET /escrow/multi-release/v2/{contractId} -> milestones[index].{receiver, amount, evidence, status, flags}
    // GET /escrows/{contractId}/deposits -> [{ txHash, ledgerClosedAt, fromAddress, amount }] for fundedAt / fundingTxHash
    // committedConditionHash = the conditionHash the backend wrote in milestones[index].description at deploy.
    getMilestoneFacts: notWired("getMilestoneFacts"),
    // POST /escrow/multi-release/v2/change-milestone-status { contractId, milestoneIndex, newStatus, newEvidence (<= 500 chars), serviceProvider }
    //   signed by a serviceProvider key -> POST /stellar/send-transaction.
    writeAnchor: notWired("writeAnchor"),
    // POST /escrow/multi-release/v2/approve-and-release-milestones { contractId, milestoneIndexes: [index], signer }
    //   signer must be in approvers AND releaseSigners (enforced on-chain) -> sign -> send -> txHash.
    releaseMilestone: notWired("releaseMilestone"),
    // POST /escrow/multi-release/v2/dispute-milestones { contractId, milestoneIndexes: [index], signer } -> sign -> send.
    disputeMilestone: notWired("disputeMilestone"),
  };
}
