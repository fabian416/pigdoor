import type { EscrowFacts } from "@witness/core";

export type ReleaseDecision = "ALLOW" | "DENY" | "REVIEW";

/**
 * The escrow provider behind an interface. The demo runs on
 * `inMemoryEscrowClient`; `ESCROW=tw` swaps in `trustlessWorkClient`
 * (./trustless-work.ts) against the real V2 API.
 */
export interface EscrowClient {
  /** What the escrow says about a milestone right now, including its status. */
  getMilestoneFacts(agreementId: string, milestoneId: string): Promise<EscrowFacts>;
  /**
   * Writes the anchor line into the milestone's evidence field. In Trustless
   * Work this is signed by a serviceProvider, so the verifier key is listed
   * there too. `decision` lets the provider reflect the verdict in the status.
   */
  writeAnchor(agreementId: string, milestoneId: string, anchorLine: string, decision?: ReleaseDecision): Promise<void>;
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

export { trustlessWorkClient, type TrustlessWorkConfig } from "./trustless-work.ts";
