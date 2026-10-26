import { Account, Keypair, Networks, Operation, TransactionBuilder } from "@stellar/stellar-base";
import { describe, expect, it } from "vitest";
import {
  TrustlessWorkError,
  amountString,
  committedConditionHash,
  fundingOf,
  milestoneIndex,
  milestoneStatus,
  trustlessWorkClient,
  type TwDeposit,
  type TwEscrow,
  type TwMilestone,
} from "../src/trustless-work.ts";

const CONTRACT = "CDHAZ2RTE2MDHYQQ7NATF5IVKIFVGLX6FHJ66OPK6MUXBSTRRXFXJ6QB";
const USDC_SAC = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";
const OTHER_SAC = "CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526";
const HASH = "82d31515f13f229bdebba13c00e4253e3e25d88e66559a296fd6a3cfc74672d1";
const verifier = Keypair.random();
const store = Keypair.random().publicKey();
const lendoor = Keypair.random().publicKey();
const NOW = "2026-10-27T16:00:00.000Z";

function escrow(over: Partial<TwMilestone> = {}): TwEscrow {
  return {
    contractId: CONTRACT,
    engagementId: "lendoor-ana-0001",
    balance: 290,
    trustline: { address: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5", contractId: USDC_SAC, symbol: "USDC" },
    roles: {
      approvers: [verifier.publicKey()],
      serviceProviders: [verifier.publicKey()],
      releaseSigners: [verifier.publicKey()],
      disputeResolvers: [Keypair.random().publicKey()],
      platform: lendoor,
      admin: Keypair.random().publicKey(),
      observers: [],
    },
    milestones: [
      {
        description: `condition-v1 sha256=${HASH} Ana, lavarropas en Casa Hogar Electro`,
        status: "pending",
        evidence: "",
        amount: 290,
        receiver: store,
        released: false,
        approvals: { target: 1, approvalCount: 0, approvedBy: [] },
        dispute: { isDisputed: false, reason: "", resolved: false },
        ...over,
      },
    ],
  };
}

function deposit(i: number, amount: string, over: Partial<TwDeposit> = {}): TwDeposit {
  return {
    fromAddress: lendoor,
    amount,
    txHash: String(i + 1).repeat(64).slice(0, 64),
    ledgerSeq: String(1000 + i),
    ledgerClosedAt: `2026-10-26T0${i}:00:00Z`,
    assetInfo: { contractId: USDC_SAC },
    ...over,
  };
}

/** An unsigned transaction with the given source, as the API would return it. */
function unsignedFor(source: string): string {
  return new TransactionBuilder(new Account(source, "7"), { fee: "100", networkPassphrase: Networks.TESTNET })
    .addOperation(Operation.bumpSequence({ bumpTo: "9" }))
    .setTimeout(60)
    .build()
    .toXDR();
}

type Call = { method: string; path: string; body: any; headers: Record<string, string> };
type Handler = (call: Call) => { status?: number; json: unknown };

/** Fake V2 API: handlers keyed by "METHOD /path" (a trailing * matches a prefix); records every call. */
function fakeApi(handlers: Record<string, Handler>) {
  const calls: Call[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const call: Call = {
      method,
      path: url.pathname + url.search,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>)),
    };
    calls.push(call);
    const key = `${method} ${url.pathname}`;
    const match =
      handlers[key] ??
      handlers[
        Object.keys(handlers).find((k) => k.endsWith("*") && k.startsWith(`${method} `) && url.pathname.startsWith(k.slice(method.length + 1, -1))) ?? ""
      ];
    if (!match) {
      return new Response(JSON.stringify({ code: "NOT_FOUND", detail: `no handler for ${key}`, status: 404, title: "Not found", type: "x" }), {
        status: 404,
        headers: { "content-type": "application/json" },
      });
    }
    const r = match(call);
    return new Response(JSON.stringify(r.json), { status: r.status ?? 200, headers: { "content-type": "application/json" } });
  };
  return { fetch: fetchImpl, calls };
}

/** send-transaction that insists the XDR was signed by `signer` and nobody else. */
function sendSignedBy(signer: Keypair, extra: Partial<{ txHash: string; ledger: number }> = {}): Handler {
  return ({ body }) => {
    const tx = TransactionBuilder.fromXDR(body.signedXdr, Networks.TESTNET);
    expect(tx.signatures).toHaveLength(1);
    expect(signer.verify(tx.hash(), tx.signatures[0].signature())).toBe(true);
    return { json: { txHash: extra.txHash ?? "c".repeat(64), ledger: extra.ledger ?? 4242, code: "STELLAR_TX_SUBMITTED" } };
  };
}

function client(api: ReturnType<typeof fakeApi>) {
  return trustlessWorkClient({
    baseUrl: "https://tw.test/",
    apiKey: "id.secret",
    releaseSignerSecret: verifier.secret(),
    fetch: api.fetch,
    now: () => NOW,
  });
}

describe("Trustless Work V2 client: reading facts", () => {
  it("maps a funded milestone to EscrowFacts: receiver, amount, funding deposit, committed hash, status", async () => {
    const api = fakeApi({
      "GET /escrow/multi-release/v2/*": () => ({ json: escrow() }),
      "GET /escrows/*": () => ({ json: { data: [deposit(0, "100"), deposit(1, "190")], hasMore: false, nextCursor: null } }),
    });
    const facts = await client(api).getMilestoneFacts(CONTRACT, "1");
    expect(facts).toEqual({
      milestoneReceiver: store,
      milestoneAmount: "290",
      fundedAt: "2026-10-26T01:00:00Z",
      fundingTxHash: "2".repeat(64),
      evidenceSubmittedAt: NOW,
      committedConditionHash: HASH,
      status: "FUNDED",
    });
    expect(api.calls.map((c) => c.path)).toEqual([`/escrow/multi-release/v2/${CONTRACT}`, `/escrows/${CONTRACT}/deposits?order=asc&limit=200`]);
    for (const c of api.calls) expect(c.headers["x-api-key"]).toBe("id.secret");
  });

  it("is not funded while the trail is short, and ignores foreign-asset rows", async () => {
    const api = fakeApi({
      "GET /escrow/multi-release/v2/*": () => ({ json: escrow() }),
      "GET /escrows/*": () => ({
        json: { data: [deposit(0, "100"), deposit(1, "500", { assetInfo: { contractId: OTHER_SAC } }), deposit(2, "50", { assetInfo: null })], hasMore: false },
      }),
    });
    const facts = await client(api).getMilestoneFacts(CONTRACT, "1");
    expect(facts.fundedAt).toBeNull();
    expect(facts.fundingTxHash).toBeUndefined();
  });

  it("follows the deposit cursor until the last page", async () => {
    const api = fakeApi({
      "GET /escrow/multi-release/v2/*": () => ({ json: escrow() }),
      "GET /escrows/*": ({ path }) =>
        path.includes("cursor=")
          ? { json: { data: [deposit(1, "190")], hasMore: false, nextCursor: null } }
          : { json: { data: [deposit(0, "100")], hasMore: true, nextCursor: "abc=" } },
    });
    const facts = await client(api).getMilestoneFacts(CONTRACT, "1");
    expect(facts.fundedAt).toBe("2026-10-26T01:00:00Z");
    expect(api.calls[2].path).toContain("&cursor=abc%3D");
  });

  it("reports the milestone status the escrow holds", () => {
    const m = escrow().milestones[0];
    expect(milestoneStatus(m)).toBe("FUNDED");
    expect(milestoneStatus({ ...m, released: true })).toBe("RELEASED");
    expect(milestoneStatus({ ...m, dispute: { isDisputed: true, reason: "x", resolved: false } })).toBe("DISPUTED");
    expect(milestoneStatus({ ...m, dispute: { isDisputed: true, reason: "x", resolved: true } })).toBe("REFUNDED");
  });

  it("refuses milestone ids the contract cannot have", async () => {
    const api = fakeApi({ "GET /escrow/multi-release/v2/*": () => ({ json: escrow() }) });
    await expect(client(api).getMilestoneFacts(CONTRACT, "2")).rejects.toThrow(/not found .*1 milestones/);
    expect(() => milestoneIndex("0")).toThrow(/1-based/);
    expect(() => milestoneIndex("x")).toThrow(/1-based/);
    expect(milestoneIndex("1")).toBe(0);
    expect(milestoneIndex("12")).toBe(11);
  });

  it("surfaces the API's problem details as a typed error", async () => {
    const api = fakeApi({
      "GET /escrow/multi-release/v2/*": () => ({
        status: 401,
        json: { type: "x", title: "Unauthorized", status: 401, code: "AUTH_KEY_NOT_FOUND", detail: "API key not found", traceId: "t-1" },
      }),
    });
    const err = await client(api).getMilestoneFacts(CONTRACT, "1").catch((e) => e);
    expect(err).toBeInstanceOf(TrustlessWorkError);
    expect(err).toMatchObject({ status: 401, code: "AUTH_KEY_NOT_FOUND", traceId: "t-1" });
    expect(err.message).toBe("Trustless Work 401 AUTH_KEY_NOT_FOUND: API key not found");
  });

  it("helpers: amounts, committed hash, funding threshold", () => {
    expect(amountString(290)).toBe("290");
    expect(amountString(2)).toBe("2");
    expect(amountString(250.5)).toBe("250.5");
    expect(amountString(0)).toBe("0");
    expect(amountString(0.0000001)).toBe("0.0000001");
    expect(() => amountString(Number.NaN)).toThrow();
    expect(committedConditionHash(`condition-v1 sha256=${HASH.toUpperCase()}`)).toBe(HASH);
    expect(committedConditionHash("Phase 1 — UI design delivery")).toBeUndefined();
    expect(committedConditionHash(`x${HASH}`)).toBeUndefined(); // must be a whole token
    expect(fundingOf(escrow(), [deposit(1, "290"), deposit(0, "0.5")])).toEqual({ at: "2026-10-26T01:00:00Z", txHash: "2".repeat(64) });
    expect(fundingOf(escrow({ amount: 0 }), [deposit(0, "290")])).toBeNull();
  });
});

describe("Trustless Work V2 client: writes are built by the API and signed here", () => {
  it("writeAnchor: change-milestone-status as serviceProvider, 'completed' on ALLOW, signed by the verifier", async () => {
    const api = fakeApi({
      "POST /escrow/multi-release/v2/change-milestone-status": ({ body }) => {
        expect(body).toEqual({
          contractId: CONTRACT,
          serviceProvider: verifier.publicKey(),
          updates: [{ index: 0, newStatus: "completed", newEvidence: "verdict-v1 sha256=ab uri=https://v.test/envelopes/ab" }],
        });
        return { json: { unsignedXdr: unsignedFor(verifier.publicKey()), txHash: "a".repeat(64) } };
      },
      "POST /stellar/send-transaction": sendSignedBy(verifier),
    });
    await client(api).writeAnchor(CONTRACT, "1", "verdict-v1 sha256=ab uri=https://v.test/envelopes/ab", "ALLOW");
    expect(api.calls.map((c) => c.path)).toEqual(["/escrow/multi-release/v2/change-milestone-status", "/stellar/send-transaction"]);
    expect(api.calls[0].headers["content-type"]).toBe("application/json");
  });

  it("writeAnchor: a DENY stays visible in the status and never says completed", async () => {
    const api = fakeApi({
      "POST /escrow/multi-release/v2/change-milestone-status": ({ body }) => {
        expect(body.updates[0].newStatus).toBe("verdict:DENY");
        return { json: { unsignedXdr: unsignedFor(verifier.publicKey()), txHash: "a".repeat(64) } };
      },
      "POST /stellar/send-transaction": sendSignedBy(verifier),
    });
    await client(api).writeAnchor(CONTRACT, "1", "verdict-v1 sha256=cd uri=https://v.test/envelopes/cd", "DENY");
    await expect(client(api).writeAnchor(CONTRACT, "1", "x".repeat(501), "DENY")).rejects.toThrow(/500-char/);
  });

  it("releaseMilestone: approve-and-release with the verifier as signer, returns the network tx hash", async () => {
    const api = fakeApi({
      "POST /escrow/multi-release/v2/approve-and-release-milestones": ({ body }) => {
        expect(body).toEqual({ contractId: CONTRACT, signer: verifier.publicKey(), milestoneIndexes: [0] });
        return { json: { unsignedXdr: unsignedFor(verifier.publicKey()), txHash: "a".repeat(64) } };
      },
      "POST /stellar/send-transaction": sendSignedBy(verifier, { txHash: "f".repeat(64) }),
    });
    await expect(client(api).releaseMilestone(CONTRACT, "1")).resolves.toEqual({ txHash: "f".repeat(64) });
  });

  it("disputeMilestone: dispute-milestones with a reason capped at 500 chars", async () => {
    const api = fakeApi({
      "POST /escrow/multi-release/v2/dispute-milestones": ({ body }) => {
        expect(body).toMatchObject({ contractId: CONTRACT, signer: verifier.publicKey(), milestoneIndexes: [1] });
        expect(body.reason).toHaveLength(500);
        return { json: { unsignedXdr: unsignedFor(verifier.publicKey()), txHash: "a".repeat(64) } };
      },
      "POST /stellar/send-transaction": sendSignedBy(verifier),
    });
    await client(api).disputeMilestone(CONTRACT, "2", "DOCUMENT_ILLEGIBLE,".repeat(40));
  });

  it("a rejected submit propagates as a TrustlessWorkError and the caller sees nothing moved", async () => {
    const api = fakeApi({
      "POST /escrow/multi-release/v2/approve-and-release-milestones": () => ({ json: { unsignedXdr: unsignedFor(verifier.publicKey()), txHash: "a".repeat(64) } }),
      "POST /stellar/send-transaction": () => ({
        status: 422,
        json: { type: "x", title: "Unprocessable", status: 422, code: "ESCROW_SIGNER_MUST_BE_APPROVER_AND_RELEASE_SIGNER", detail: "signer lacks a role" },
      }),
    });
    await expect(client(api).releaseMilestone(CONTRACT, "1")).rejects.toMatchObject({ status: 422, code: "ESCROW_SIGNER_MUST_BE_APPROVER_AND_RELEASE_SIGNER" });
  });
});
