#!/usr/bin/env node
/**
 * One Trustless Work V1 write: build with the API, sign with the key named by
 * --signer-env, submit, wait for Horizon. Used for the operations the live run
 * does not cover (dispute, resolve, withdraw).
 *
 *   TW_API_KEY=... SIGNER_SECRET=S... node services/verifier/src/tw1-op.ts \
 *     --path /escrow/multi-release/dispute-milestone --signer-env SIGNER_SECRET \
 *     --body '{"contractId":"C...","milestoneIndex":"0","signer":"G..."}'
 */
import { parseArgs } from "node:util";
import { Keypair, Networks, TransactionBuilder } from "@stellar/stellar-base";

const { values } = parseArgs({ options: { path: { type: "string" }, body: { type: "string" }, "signer-env": { type: "string", default: "SIGNER_SECRET" } } });
if (!values.path || !values.body) {
  console.error("usage: tw1-op.ts --path <api path> --body <json> [--signer-env NAME]");
  process.exit(2);
}
const base = (process.env.TW_V1_BASE_URL ?? "https://dev.api.trustlesswork.com").replace(/\/+$/, "");
const apiKey = process.env.TW_API_KEY ?? "";
const secret = process.env[values["signer-env"]!];
if (!apiKey || !secret) {
  console.error(`missing TW_API_KEY or ${values["signer-env"]}`);
  process.exit(2);
}
const signer = Keypair.fromSecret(secret);

async function call(path: string, body: unknown): Promise<any> {
  const res = await fetch(`${base}${path}`, { method: "POST", headers: { "x-api-key": apiKey, "content-type": "application/json", accept: "application/json" }, body: JSON.stringify(body) });
  const text = await res.text();
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  if (!res.ok) {
    console.error(`Trustless Work ${res.status} on ${path}: ${JSON.stringify(json).slice(0, 800)}`);
    process.exit(1);
  }
  return json;
}

const built = await call(values.path, JSON.parse(values.body));
const xdr = built.unsignedTransaction ?? built.unsignedXdr;
if (!xdr) {
  console.error(`no unsigned transaction: ${JSON.stringify(built).slice(0, 400)}`);
  process.exit(1);
}
const tx = TransactionBuilder.fromXDR(xdr, Networks.TESTNET);
tx.sign(signer);
const txHash = tx.hash().toString("hex");
const sent = await call("/helper/send-transaction", { signedXdr: tx.toXDR() });
let successful: boolean | undefined;
for (let i = 0; i < 30 && successful === undefined; i++) {
  const res = await fetch(`https://horizon-testnet.stellar.org/transactions/${txHash}`);
  if (res.ok) successful = ((await res.json()) as { successful: boolean }).successful;
  else await new Promise((r) => setTimeout(r, 2000));
}
console.log(JSON.stringify({ path: values.path, signer: signer.publicKey(), txHash, successful, response: sent, explorer: `https://stellar.expert/explorer/testnet/tx/${txHash}` }, null, 2));
process.exit(successful ? 0 : 1);
