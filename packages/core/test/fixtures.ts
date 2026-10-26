import { Keypair } from "@stellar/stellar-base";
import { conditionHash, type EscrowFacts, type EvidenceItem, type PurchaseCondition, type TaskCondition } from "../src/index.ts";

export const lendoor = Keypair.random();
export const store = Keypair.random();
export const parent = Keypair.random();
export const sasha = Keypair.random();
export const verifierKey = Keypair.random();
export const stranger = Keypair.random();

/** Circle USDC issuer on testnet. */
export const USDC_ISSUER = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";

/** Lendoor flow: credit for Ana's washing machine, paid to the store against an invoice. */
export const condition: PurchaseCondition = {
  version: "1",
  kind: "purchase",
  payer: lendoor.publicKey(),
  receiver: store.publicKey(),
  receiverName: "Casa Hogar Electro",
  asset: { code: "USDC", issuer: USDC_ISSUER },
  maxAmount: "290",
  category: "electrodomésticos",
  items: ["lavarropas"],
  window: { notBefore: "2026-10-25T00:00:00Z", notAfter: "2026-11-15T23:59:59Z" },
  settlement: { role: "escrow_funded" },
  evidence: { type: "invoice_photo", mustShow: ["merchant name", "date", "items", "total"] },
  sourceText: "Crédito de 290 USDC para que Ana compre un lavarropas en Casa Hogar Electro; se paga a la tienda contra factura.",
};

/** Piggy flow: Sasha's allowance when the bed is made. The release is the payment. */
export const taskCondition: TaskCondition = {
  version: "1",
  kind: "task",
  payer: parent.publicKey(),
  receiver: sasha.publicKey(),
  receiverName: "Sasha",
  asset: { code: "USDC", issuer: USDC_ISSUER },
  maxAmount: "2",
  task: { title: "Hacer la cama", doneWhen: ["la cama está tendida", "la almohada está en su lugar", "no hay ropa sobre la cama"] },
  window: { notBefore: "2026-10-25T00:00:00Z", notAfter: "2026-11-01T23:59:59Z" },
  settlement: { role: "payee_prepaid" },
  evidence: { type: "task_photo", mustShow: ["the task done"] },
  sourceText: "2 USDC para Sasha cuando haga la cama, antes del domingo.",
};

export const goodFacts: EscrowFacts = {
  milestoneReceiver: store.publicKey(),
  milestoneAmount: "290",
  fundedAt: "2026-10-25T18:00:00Z",
  fundingTxHash: "1111111111111111111111111111111111111111111111111111111111111111",
  evidenceSubmittedAt: "2026-10-30T15:00:00Z",
  committedConditionHash: conditionHash(condition),
};

export const taskFacts: EscrowFacts = {
  milestoneReceiver: sasha.publicKey(),
  milestoneAmount: "2",
  fundedAt: "2026-10-25T21:00:00Z",
  fundingTxHash: "2222222222222222222222222222222222222222222222222222222222222222",
  evidenceSubmittedAt: "2026-10-26T18:30:00Z",
  committedConditionHash: conditionHash(taskCondition),
};

export const receiptEvidence: EvidenceItem = {
  type: "invoice_photo",
  uri: "s3://evidence/ana-1/factura.jpg",
  sha256: "a".repeat(64),
  mimeType: "image/jpeg",
  uploader: store.publicKey(),
  createdAt: "2026-10-30T15:00:00Z",
};
