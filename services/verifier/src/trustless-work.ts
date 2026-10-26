import { Keypair, Networks, TransactionBuilder } from "@stellar/stellar-base";
import { toStroops, type EscrowFacts } from "@witness/core";
import type { EscrowClient, ReleaseDecision } from "./escrow-client.ts";

/**
 * Trustless Work V2 multi-release escrows (`https://beta.api.trustlesswork.com`).
 *
 * Every write is two calls: the API builds the unsigned transaction with the
 * role's wallet as source (`{ unsignedXdr, txHash }`), we sign the XDR exactly
 * as returned with that wallet's key, and `POST /stellar/send-transaction`
 * submits it. Field names and constraints below come from the V2 OpenAPI
 * (`/api/all-json`, fetched 25 Oct 2026); see docs/contracts.md §8 for the role
 * layout the verifier key needs on each escrow.
 *
 * Milestone ids in this service are 1-based strings ("1"); the contract is
 * 0-based: index = Number(milestoneId) - 1.
 */
export interface TrustlessWorkConfig {
  /** V2 base URL. V1 (`dev.api` / `api`) is a different, incompatible API. */
  baseUrl: string;
  /** `<id>.<secret>`, sent as `x-api-key`. V2 keys are issued by Trustless Work's backoffice; the self-service key from dapp.trustlesswork.com is V1 (see tw1-live.ts). */
  apiKey: string;
  /** Secret of the verifier key: listed in approvers, releaseSigners and serviceProviders of the escrow. */
  releaseSignerSecret: string;
  /** Defaults to the testnet passphrase. */
  networkPassphrase?: string;
  /** Injectable for tests. */
  fetch?: typeof globalThis.fetch;
  now?: () => string;
}

/** RFC 7807 problem the API returns on every non-2xx. */
export class TrustlessWorkError extends Error {
  readonly status: number;
  readonly code: string;
  readonly traceId: string | undefined;
  // Node runs these files with type stripping, which has no parameter properties.
  constructor(status: number, code: string, detail: string, traceId?: string) {
    super(`Trustless Work ${status} ${code}: ${detail}`);
    this.name = "TrustlessWorkError";
    this.status = status;
    this.code = code;
    this.traceId = traceId;
  }
}

/** Only the fields this service reads. */
export interface TwMilestone {
  description: string;
  status: string;
  evidence: string;
  /** Human-readable decimals, as the API returns them. */
  amount: number;
  receiver: string;
  released: boolean;
  approvals?: { target: number; approvalCount: number; approvedBy: string[] };
  dispute?: { isDisputed: boolean; reason: string; resolved: boolean };
}

export interface TwEscrow {
  contractId: string;
  engagementId: string;
  balance: number;
  trustline: { address: string; contractId: string; symbol: string };
  roles: {
    approvers: string[];
    serviceProviders: string[];
    releaseSigners: string[];
    disputeResolvers: string[];
    platform: string;
    admin: string;
    observers: string[];
  };
  milestones: TwMilestone[];
}

export interface TwDeposit {
  fromAddress: string;
  /** Token units, decimal string. */
  amount: string;
  txHash?: string;
  ledgerSeq: string;
  ledgerClosedAt: string;
  /** Null when the raw asset id is unusable; `contractId` is the SAC that emitted the transfer. */
  assetInfo?: { contractId?: string } | null;
}

export interface UnsignedTx {
  unsignedXdr: string;
  txHash: string;
  /** Deploys only: the address the escrow will have. */
  contractId?: string;
}

export interface SentTx {
  txHash: string;
  ledger: number;
  contractId?: string;
  code?: string;
  message?: string;
}

/** HTTP and signing against the V2 API; shared by the escrow client and the deploy script. */
export function trustlessWorkHttp(config: Pick<TrustlessWorkConfig, "baseUrl" | "apiKey" | "networkPassphrase" | "fetch">) {
  const doFetch = config.fetch ?? globalThis.fetch;
  const passphrase = config.networkPassphrase ?? Networks.TESTNET;
  const base = config.baseUrl.replace(/\/+$/, "");

  async function call<T>(method: "GET" | "POST" | "PUT", path: string, body?: unknown): Promise<T> {
    const res = await doFetch(`${base}${path}`, {
      method,
      headers: {
        "x-api-key": config.apiKey,
        accept: "application/json",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = undefined;
    }
    if (!res.ok) {
      const p = (json ?? {}) as { code?: string; detail?: string; title?: string; traceId?: string };
      throw new TrustlessWorkError(res.status, p.code ?? "HTTP_ERROR", p.detail ?? p.title ?? text.slice(0, 200), p.traceId);
    }
    return json as T;
  }

  /** Build, sign exactly as returned (re-simulating changes the hash), submit. */
  async function write(path: string, body: unknown, signer: Keypair): Promise<SentTx & { unsigned: UnsignedTx }> {
    const unsigned = await call<UnsignedTx>("POST", path, body);
    const tx = TransactionBuilder.fromXDR(unsigned.unsignedXdr, passphrase);
    tx.sign(signer);
    const sent = await call<SentTx>("POST", "/stellar/send-transaction", { signedXdr: tx.toXDR() });
    return { ...sent, unsigned };
  }

  return {
    get: <T>(path: string) => call<T>("GET", path),
    post: <T>(path: string, body: unknown) => call<T>("POST", path, body),
    write,
  };
}

export const V2 = "/escrow/multi-release/v2";

/** "1" -> 0. Anything that is not a positive integer is a caller bug, not a milestone. */
export function milestoneIndex(milestoneId: string): number {
  if (!/^[1-9]\d*$/.test(milestoneId)) throw new Error(`milestoneId must be a 1-based integer, got "${milestoneId}"`);
  return Number(milestoneId) - 1;
}

/** The 64-hex conditionHash the backend wrote in the milestone description at deploy, if any. */
export function committedConditionHash(description: string): string | undefined {
  const m = /\b([0-9a-fA-F]{64})\b/.exec(description);
  return m ? m[1].toLowerCase() : undefined;
}

/** API number (human-readable decimals) -> the decimal string the core schemas take. */
export function amountString(n: number): string {
  if (!Number.isFinite(n) || n < 0) throw new Error(`invalid amount from escrow: ${n}`);
  const s = n.toFixed(7).replace(/\.?0+$/, "");
  return s === "" ? "0" : s;
}

export function milestoneStatus(m: TwMilestone): NonNullable<EscrowFacts["status"]> {
  if (m.released) return "RELEASED";
  // The resolver distributed the balance; whatever the split, nothing is left to verify.
  if (m.dispute?.resolved) return "REFUNDED";
  if (m.dispute?.isDisputed) return "DISPUTED";
  return "FUNDED";
}

/**
 * The escrow counts as funded at the deposit where the trustline-asset trail
 * reaches the sum of all milestone amounts (the contract releases per
 * milestone, but `fund` is documented as "the sum of milestone amounts").
 * Foreign-asset rows in the trail are ignored, as the indexer's own balance does.
 */
export function fundingOf(escrow: TwEscrow, deposits: TwDeposit[]): { at: string; txHash?: string } | null {
  const total = escrow.milestones.reduce((acc, m) => acc + toStroops(amountString(m.amount)), 0n);
  if (total === 0n) return null;
  const asc = [...deposits].sort((a, b) => (BigInt(a.ledgerSeq) < BigInt(b.ledgerSeq) ? -1 : BigInt(a.ledgerSeq) > BigInt(b.ledgerSeq) ? 1 : 0));
  let acc = 0n;
  for (const d of asc) {
    if (d.assetInfo === null) continue;
    if (d.assetInfo?.contractId && d.assetInfo.contractId !== escrow.trustline.contractId) continue;
    acc += toStroops(d.amount);
    if (acc >= total) return { at: d.ledgerClosedAt, txHash: d.txHash };
  }
  return null;
}

export function trustlessWorkClient(config: TrustlessWorkConfig): EscrowClient {
  const http = trustlessWorkHttp(config);
  const signer = Keypair.fromSecret(config.releaseSignerSecret);
  const me = signer.publicKey();
  const now = config.now ?? (() => new Date().toISOString());

  async function allDeposits(contractId: string): Promise<TwDeposit[]> {
    const out: TwDeposit[] = [];
    let cursor: string | undefined;
    do {
      const page = await http.get<{ data: TwDeposit[]; hasMore: boolean; nextCursor?: string | null }>(
        `/escrows/${contractId}/deposits?order=asc&limit=200${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
      );
      out.push(...page.data);
      cursor = page.hasMore && page.nextCursor ? page.nextCursor : undefined;
    } while (cursor);
    return out;
  }

  return {
    async getMilestoneFacts(contractId, milestoneId) {
      const index = milestoneIndex(milestoneId);
      const escrow = await http.get<TwEscrow>(`${V2}/${contractId}`);
      const m = escrow.milestones[index];
      if (!m) throw new Error(`milestone ${milestoneId} not found on ${contractId} (${escrow.milestones.length} milestones)`);
      const funding = fundingOf(escrow, await allDeposits(contractId));
      return {
        milestoneReceiver: m.receiver,
        milestoneAmount: amountString(m.amount),
        fundedAt: funding?.at ?? null,
        fundingTxHash: funding?.txHash,
        // The escrow does not record when the evidence arrived; the verifier does, now.
        evidenceSubmittedAt: now(),
        committedConditionHash: committedConditionHash(m.description),
        status: milestoneStatus(m),
      };
    },

    /** `change-milestone-status`, signed as a serviceProvider. ALLOW marks the milestone completed; other verdicts stay visible in the status. */
    async writeAnchor(contractId, milestoneId, anchorLine, decision?: ReleaseDecision) {
      if (anchorLine.length > 500) throw new Error("anchor line exceeds the 500-char evidence limit");
      await http.write(
        `${V2}/change-milestone-status`,
        {
          contractId,
          serviceProvider: me,
          updates: [
            {
              index: milestoneIndex(milestoneId),
              newStatus: decision === "ALLOW" ? "completed" : `verdict:${decision ?? "PENDING"}`,
              newEvidence: anchorLine,
            },
          ],
        },
        signer,
      );
    },

    /** `approve-and-release-milestones`: the signer must be in approvers AND releaseSigners (enforced on-chain). */
    async releaseMilestone(contractId, milestoneId) {
      const sent = await http.write(
        `${V2}/approve-and-release-milestones`,
        { contractId, signer: me, milestoneIndexes: [milestoneIndex(milestoneId)] },
        signer,
      );
      return { txHash: sent.txHash };
    },

    async disputeMilestone(contractId, milestoneId, reason) {
      await http.write(
        `${V2}/dispute-milestones`,
        { contractId, signer: me, milestoneIndexes: [milestoneIndex(milestoneId)], reason: reason.slice(0, 500) },
        signer,
      );
    },
  };
}
