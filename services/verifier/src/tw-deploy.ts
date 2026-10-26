#!/usr/bin/env node
/**
 * Deploys (and optionally funds) one Trustless Work V2 multi-release escrow
 * from a spec in examples/, with the conditionHash written in the milestone
 * description. Prints JSON with the contract id and transaction hashes for the
 * README's on-chain evidence table.
 *
 *   TW_API_KEY=<id>.<secret> DEPLOYER_SECRET=S... VERIFIER=G... RESOLVER=G... ADMIN=G... [PLATFORM=G...] [RECEIVER=G...] \
 *   node services/verifier/src/tw-deploy.ts examples/lendoor/escrow.json --condition examples/lendoor/condition.json [--fund]
 *
 * `$NAME` tokens in the spec resolve from the environment; `$CONDITION_HASH`
 * from the condition file; `$RECEIVER` defaults to the condition's receiver and
 * `$PLATFORM` to the deployer. The deployer signs the deploy and the fund, so
 * it needs XLM for fees and, to fund, a USDC trustline with balance.
 */
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { Keypair } from "@stellar/stellar-base";
import { ConditionSchema, conditionHash } from "@witness/core";
import { V2, trustlessWorkHttp, type SentTx, type TwEscrow } from "./trustless-work.ts";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    condition: { type: "string" },
    fund: { type: "boolean", default: false },
    "base-url": { type: "string", default: process.env.TW_BASE_URL ?? "https://beta.api.trustlesswork.com" },
  },
});

const specPath = positionals[0];
if (!specPath || !values.condition) {
  console.error("usage: tw-deploy.ts <escrow-spec.json> --condition <condition.json> [--fund]");
  process.exit(2);
}

const deployer = Keypair.fromSecret(required("DEPLOYER_SECRET"));
const condition = ConditionSchema.parse(JSON.parse(readFileSync(values.condition, "utf8")));
const hash = conditionHash(condition);
const vars: Record<string, string> = {
  CONDITION_HASH: hash,
  RECEIVER: process.env.RECEIVER ?? condition.receiver,
  PLATFORM: process.env.PLATFORM ?? deployer.publicKey(),
  VERIFIER: required("VERIFIER"),
  RESOLVER: required("RESOLVER"),
  ADMIN: required("ADMIN"),
};
const spec = resolve(JSON.parse(readFileSync(specPath, "utf8"))) as {
  engagementId: string;
  title: string;
  description: string;
  platformFee: number;
  roles: Record<string, unknown>;
  trustline: Record<string, string>;
  milestones: { description: string; amount: number; receiver: string; approvalsTarget?: number }[];
};

const http = trustlessWorkHttp({ baseUrl: values["base-url"], apiKey: required("TW_API_KEY"), networkPassphrase: process.env.STELLAR_NETWORK_PASSPHRASE });
const explorer = "https://stellar.expert/explorer/testnet";

const deployed = await http.write(`${V2}/deploy`, { signer: deployer.publicKey(), ...spec }, deployer);
const contractId = deployed.contractId ?? deployed.unsigned.contractId;
if (!contractId) throw new Error(`deploy submitted (${deployed.txHash}) but no contractId came back; check ${explorer}/tx/${deployed.txHash}`);

// Read back what the chain holds: the committed hash must be there before anyone funds.
const onChain = await http.get<TwEscrow>(`${V2}/${contractId}`);
const committed = onChain.milestones.map((m) => m.description.includes(hash));
if (!committed.every(Boolean)) throw new Error(`milestone descriptions on ${contractId} do not all carry ${hash}`);

let funded: SentTx | undefined;
if (values.fund) {
  const amount = spec.milestones.reduce((acc, m) => acc + m.amount, 0);
  funded = await http.write(`${V2}/fund`, { contractId, signer: deployer.publicKey(), amount }, deployer);
}

console.log(
  JSON.stringify(
    {
      contractId,
      engagementId: spec.engagementId,
      conditionHash: hash,
      milestones: onChain.milestones.map((m, i) => ({ index: i, receiver: m.receiver, amount: m.amount, description: m.description })),
      roles: onChain.roles,
      deployTxHash: deployed.txHash,
      fundTxHash: funded?.txHash,
      explorer: {
        contract: `${explorer}/contract/${contractId}`,
        deploy: `${explorer}/tx/${deployed.txHash}`,
        fund: funded ? `${explorer}/tx/${funded.txHash}` : undefined,
      },
    },
    null,
    2,
  ),
);

function required(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`missing ${name}`);
    process.exit(2);
  }
  return v;
}

/** Replace `$NAME` tokens anywhere in the spec. Unknown names are an error, never silently kept. */
function resolve(value: unknown): unknown {
  if (typeof value === "string") {
    return value.replace(/\$([A-Z_]+)/g, (_, name: string) => {
      const v = vars[name] ?? process.env[name];
      if (!v) {
        console.error(`spec references $${name} and it is not set`);
        process.exit(2);
      }
      return v;
    });
  }
  if (Array.isArray(value)) return value.map(resolve);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolve(v)]));
  return value;
}
