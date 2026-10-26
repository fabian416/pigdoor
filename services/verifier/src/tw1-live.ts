#!/usr/bin/env node
/**
 * One conditional release, end to end, on Stellar testnet through the Trustless
 * Work V1 API (`dev.api.trustlesswork.com`, the API the self-service testnet key
 * from dapp.trustlesswork.com unlocks; V2 needs a backoffice-issued credential).
 *
 *   1. deploy a multi-release escrow with the conditionHash in the milestone description
 *   2. fund it
 *   3. read the escrow back, build EscrowFacts, run both verifiers on the photo
 *   4. sign the VerificationEnvelope with the verifier key, store it where the
 *      public service serves it, write the anchor line into the milestone evidence
 *   5. ALLOW -> approve + release with the verifier key; REVIEW -> dispute; DENY -> nothing
 *
 * Runs where the verifier's secrets live (the deployed container), so the
 * envelope carries the same key the public service reports. Env:
 *   VERIFIER_SECRET, ANTHROPIC_API_KEY, PUBLIC_URL, DATA_DIR   (the service's own)
 *   TW_API_KEY            V1 testnet key
 *   TW_V1_BASE_URL        default https://dev.api.trustlesswork.com
 *   DEPLOYER_SECRET       signs deploy and fund; needs XLM and USDC with a trustline
 *   RESOLVER              G... dispute resolver (distinct from the verifier)
 *
 *   node services/verifier/src/tw1-live.ts --condition examples/lendoor/condition.json \
 *     --receiver G... --amount 10 --engagement lendoor-ana-0001 --title "Witness · Lendoor · Ana" \
 *     --photo https://hackmeridian.lendoor.xyz/factura-ok.jpg --fx ARS=1450 [--contract C...] [--deploy-only]
 */
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { Keypair, Networks, TransactionBuilder } from "@stellar/stellar-base";
import {
  ConditionSchema,
  anchorReference,
  checkDeterministic,
  conditionHash,
  decide,
  formatAnchorReference,
  sha256Hex,
  signEnvelope,
  type EscrowFacts,
} from "@witness/core";
import { anthropicModel, evaluateDocument } from "@witness/semantic";
import { fileStore } from "./store.ts";

const { values } = parseArgs({
  options: {
    condition: { type: "string" },
    receiver: { type: "string" },
    amount: { type: "string" },
    engagement: { type: "string" },
    title: { type: "string", default: "Witness conditional release" },
    photo: { type: "string" },
    fx: { type: "string" },
    contract: { type: "string" },
    "deploy-only": { type: "boolean", default: false },
  },
});
const out: Record<string, unknown> = {};
for (const k of ["condition", "receiver", "amount", "engagement"] as const) if (!values[k]) fail(`--${k} is required`);

const base = (process.env.TW_V1_BASE_URL ?? "https://dev.api.trustlesswork.com").replace(/\/+$/, "");
const apiKey = required("TW_API_KEY");
const deployer = Keypair.fromSecret(required("DEPLOYER_SECRET"));
const verifier = Keypair.fromSecret(required("VERIFIER_SECRET"));
const resolver = required("RESOLVER");
const publicUrl = required("PUBLIC_URL");
const dataDir = process.env.DATA_DIR ?? "./data";
const explorer = "https://stellar.expert/explorer/testnet";
const USDC_ISSUER = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";

const condition = ConditionSchema.parse(JSON.parse(readFileSync(values.condition!, "utf8")));
const hash = conditionHash(condition);
const amount = Number(values.amount);
Object.assign(out, { conditionHash: hash, verifier: verifier.publicKey(), deployer: deployer.publicKey(), receiver: values.receiver, amount });

// ---------- 1. deploy ----------
let contractId = values.contract;
if (!contractId) {
  const spec = {
    signer: deployer.publicKey(),
    engagementId: values.engagement,
    title: values.title,
    description: `Conditional release verified by Witness. Milestone 0 commits to condition sha256 ${hash}; the verdict is anchored in its evidence.`,
    platformFee: 0,
    roles: {
      approver: verifier.publicKey(),
      serviceProvider: verifier.publicKey(),
      platformAddress: deployer.publicKey(),
      releaseSigner: verifier.publicKey(),
      disputeResolver: resolver,
    },
    milestones: [{ description: `condition-v1 sha256=${hash}`, amount, receiver: values.receiver }],
    trustline: { symbol: "USDC", address: USDC_ISSUER },
  };
  const deployed = await write("/deployer/multi-release", spec, deployer);
  out.deployTxHash = deployed.txHash;
  out.deployResponse = deployed.response;
  contractId = findContractId(deployed.response) ?? (await contractIdByEngagement(values.engagement!));
  if (!contractId) fail(`deploy submitted (${deployed.txHash}) but no contract id found; response: ${JSON.stringify(deployed.response)}`);
  log(`deployed ${contractId} in ${deployed.txHash}`);

  // ---------- 2. fund ----------
  const funded = await write("/escrow/multi-release/fund-escrow", { contractId, signer: deployer.publicKey(), amount }, deployer);
  out.fundTxHash = funded.txHash;
  log(`funded ${amount} USDC in ${funded.txHash}`);
}
out.contractId = contractId;
out.explorer = { contract: `${explorer}/contract/${contractId}`, deploy: out.deployTxHash ? `${explorer}/tx/${out.deployTxHash}` : undefined, fund: out.fundTxHash ? `${explorer}/tx/${out.fundTxHash}` : undefined };
if (values["deploy-only"]) done();

// ---------- 3. facts from the escrow ----------
const escrow = await getEscrow(contractId!);
out.escrowOnChain = escrow;
const m0 = escrow.milestones?.[0] ?? {};
const milestoneReceiver = String(m0.receiver ?? escrow.roles?.receiver ?? "");
const milestoneAmount = String(m0.amount ?? escrow.amount ?? "");
const description = String(m0.description ?? "");
if (!milestoneReceiver || !milestoneAmount) fail(`cannot read receiver/amount from the escrow object: ${JSON.stringify(escrow).slice(0, 800)}`);
const funding = await fundingFacts(contractId!, out.fundTxHash as string | undefined);
const now = new Date().toISOString();
const facts: EscrowFacts = {
  milestoneReceiver,
  milestoneAmount: normalizeAmount(milestoneAmount),
  fundedAt: funding.at,
  fundingTxHash: funding.txHash,
  evidenceSubmittedAt: now,
  committedConditionHash: /\b([0-9a-fA-F]{64})\b/.exec(description)?.[1]?.toLowerCase(),
  status: m0.released || m0.flags?.released ? "RELEASED" : m0.disputed || m0.flags?.disputed ? "DISPUTED" : "FUNDED",
};
out.facts = facts;

// ---------- 4. verify, sign, store, anchor ----------
if (!values.photo) fail("--photo is required unless --deploy-only");
const bytes = values.photo.startsWith("http") ? Buffer.from(await (await fetch(values.photo)).arrayBuffer()) : readFileSync(values.photo);
const fx = values.fx ? { currency: values.fx.split("=")[0], unitsPerAsset: Number(values.fx.split("=")[1]) } : undefined;
const outcome = await evaluateDocument(anthropicModel(), { condition, image: { base64: bytes.toString("base64"), mediaType: "image/jpeg" }, fx });
const criteria = [...checkDeterministic(condition, facts), ...outcome.criteria];
const verdict = decide(criteria, outcome.score);
const evidence = [{ type: condition.evidence.type, uri: values.photo, sha256: sha256Hex(bytes), mimeType: "image/jpeg" as const, uploader: milestoneReceiver, createdAt: now }];
const envelope = signEnvelope(
  { agreementId: contractId!, milestoneId: "1", verifier: verifier.publicKey(), verifierType: "automated_agent", criteria, evidence, verdict, timestamp: now, conditionHash: hash },
  verifier,
);
const { id } = fileStore(dataDir).putEnvelope(envelope);
const anchor = formatAnchorReference(anchorReference(envelope, `${publicUrl}/envelopes/${id}`));
out.verdict = verdict;
out.criteria = criteria.map((c) => `${c.result} ${c.id} ${c.code}`);
out.reading = outcome.reading;
out.envelopeId = id;
out.anchor = anchor;
log(`verdict ${verdict.decision} [${verdict.reasons.join(",")}] score=${verdict.semanticScore ?? "-"}`);

const anchored = await write(
  "/escrow/multi-release/change-milestone-status",
  { contractId, milestoneIndex: "0", newEvidence: anchor, newStatus: verdict.decision === "ALLOW" ? "completed" : `verdict:${verdict.decision}`, serviceProvider: verifier.publicKey() },
  verifier,
);
out.anchorTxHash = anchored.txHash;
log(`anchored in ${anchored.txHash}`);

// ---------- 5. act ----------
if (verdict.decision === "ALLOW") {
  const approved = await write("/escrow/multi-release/approve-milestone", { contractId, milestoneIndex: "0", approver: verifier.publicKey() }, verifier);
  out.approveTxHash = approved.txHash;
  const released = await write("/escrow/multi-release/release-milestone-funds", { contractId, releaseSigner: verifier.publicKey(), milestoneIndex: "0" }, verifier);
  out.releaseTxHash = released.txHash;
  log(`approved in ${approved.txHash}, released in ${released.txHash}`);
  out.receiverBalanceAfter = await usdcBalance(milestoneReceiver);
} else if (verdict.decision === "REVIEW") {
  const disputed = await write("/escrow/multi-release/dispute-milestone", { contractId, milestoneIndex: "0", signer: verifier.publicKey() }, verifier);
  out.disputeTxHash = disputed.txHash;
}
(out.explorer as Record<string, unknown>).anchor = `${explorer}/tx/${out.anchorTxHash}`;
if (out.approveTxHash) (out.explorer as Record<string, unknown>).approve = `${explorer}/tx/${out.approveTxHash}`;
if (out.releaseTxHash) (out.explorer as Record<string, unknown>).release = `${explorer}/tx/${out.releaseTxHash}`;
done();

// ---------- helpers ----------
async function call<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { "x-api-key": apiKey, accept: "application/json", ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  if (!res.ok) fail(`Trustless Work ${res.status} on ${path}: ${JSON.stringify(json).slice(0, 600)}`);
  return json as T;
}

/** Build with the API, sign exactly as returned, submit. The hash is computed locally from the signed envelope. */
async function write(path: string, body: unknown, signer: Keypair): Promise<{ txHash: string; response: unknown }> {
  const built = await call<{ unsignedTransaction?: string; unsignedXdr?: string }>("POST", path, body);
  const xdr = built.unsignedTransaction ?? built.unsignedXdr;
  if (!xdr) fail(`no unsigned transaction in response of ${path}: ${JSON.stringify(built).slice(0, 400)}`);
  const tx = TransactionBuilder.fromXDR(xdr, Networks.TESTNET);
  tx.sign(signer);
  const txHash = tx.hash().toString("hex");
  const response = await call<unknown>("POST", "/helper/send-transaction", { signedXdr: tx.toXDR() });
  await confirmed(txHash);
  return { txHash, response };
}

/** Wait for Horizon to show the transaction as successful. */
async function confirmed(txHash: string): Promise<void> {
  for (let i = 0; i < 30; i++) {
    const res = await fetch(`https://horizon-testnet.stellar.org/transactions/${txHash}`);
    if (res.ok) {
      const tx = (await res.json()) as { successful: boolean };
      if (!tx.successful) fail(`transaction ${txHash} failed on-chain`);
      return;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  fail(`transaction ${txHash} not seen on Horizon after 60 s`);
}

function findContractId(response: unknown): string | undefined {
  return /\b(C[A-Z2-7]{55})\b/.exec(JSON.stringify(response))?.[1];
}

async function contractIdByEngagement(engagementId: string): Promise<string | undefined> {
  for (let i = 0; i < 10; i++) {
    const list = await call<any>("GET", `/helper/get-escrows-by-signer?signer=${deployer.publicKey()}&engagementId=${encodeURIComponent(engagementId)}`);
    const rows: any[] = Array.isArray(list) ? list : (list?.data ?? list?.escrows ?? []);
    const row = rows.find((r) => r.engagementId === engagementId) ?? rows[0];
    const idFound = row?.contractId ?? row?.contract_id ?? findContractId(row);
    if (idFound) return idFound;
    await new Promise((r) => setTimeout(r, 3000));
  }
  return undefined;
}

async function getEscrow(contractId: string): Promise<any> {
  const res = await call<any>("GET", `/helper/get-escrow-by-contract-ids?contractIds[]=${contractId}&validateOnChain=true`);
  const rows: any[] = Array.isArray(res) ? res : (res?.data ?? res?.escrows ?? [res]);
  const row = rows.find((r) => (r.contractId ?? r.contract_id) === contractId) ?? rows[0];
  if (!row) fail(`escrow ${contractId} not found via the helper: ${JSON.stringify(res).slice(0, 400)}`);
  return row;
}

/** When funding happened, from the fund transaction on Horizon; the hash is this run's or the caller's. */
async function fundingFacts(contractId: string, fundTxHash?: string): Promise<{ at: string | null; txHash?: string }> {
  const h = fundTxHash ?? process.env.FUND_TX_HASH;
  if (!h) return { at: null };
  const res = await fetch(`https://horizon-testnet.stellar.org/transactions/${h}`);
  if (!res.ok) return { at: null };
  const tx = (await res.json()) as { created_at: string; successful: boolean };
  return tx.successful ? { at: new Date(tx.created_at).toISOString(), txHash: h } : { at: null };
}

async function usdcBalance(account: string): Promise<string | undefined> {
  const res = await fetch(`https://horizon-testnet.stellar.org/accounts/${account}`);
  if (!res.ok) return undefined;
  const acc = (await res.json()) as { balances: { asset_code?: string; balance: string }[] };
  return acc.balances.find((b) => b.asset_code === "USDC")?.balance;
}

function normalizeAmount(a: string): string {
  const n = Number(a);
  if (!Number.isFinite(n)) fail(`unreadable amount from escrow: ${a}`);
  // The V1 indexer may return the stroops integer or the human amount; milestones in this run are whole USDC under 1000.
  const human = n >= 10_000_000 ? n / 10_000_000 : n;
  const s = human.toFixed(7).replace(/\.?0+$/, "");
  return s === "" ? "0" : s;
}

function required(name: string): string {
  const v = process.env[name];
  if (!v) fail(`missing ${name}`);
  return v;
}

function log(msg: string): void {
  console.error(`[tw1-live] ${msg}`);
}

function fail(msg: string): never {
  console.error(`[tw1-live] ERROR ${msg}`);
  console.log(JSON.stringify(out, null, 2));
  process.exit(1);
}

function done(): never {
  console.log(JSON.stringify(out, null, 2));
  process.exit(0);
}
