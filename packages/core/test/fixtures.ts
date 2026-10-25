import { Keypair } from "@stellar/stellar-base";
import { conditionHash, type Condition, type EscrowFacts, type EvidenceItem } from "../src/index.ts";

export const marta = Keypair.random();
export const corralon = Keypair.random();
export const verifierKey = Keypair.random();
export const stranger = Keypair.random();

/** Circle USDC issuer on testnet. */
export const USDC_ISSUER = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";

export const condition: Condition = {
  version: "1",
  payer: marta.publicKey(),
  receiver: corralon.publicKey(),
  receiverName: "Corralón San Miguel",
  asset: { code: "USDC", issuer: USDC_ISSUER },
  maxAmount: "100",
  category: "materiales de construcción",
  items: ["cemento", "hierro"],
  window: { notBefore: "2026-10-25T00:00:00Z", notAfter: "2026-11-15T23:59:59Z" },
  evidence: { type: "receipt_photo", mustShow: ["nombre del comercio", "fecha", "ítems", "total"] },
  sourceText: "200 libres, y 100 para cemento y hierro en el Corralón San Miguel, antes del 15 de noviembre.",
};

export const goodFacts: EscrowFacts = {
  milestoneReceiver: corralon.publicKey(),
  milestoneAmount: "100",
  fundedAt: "2026-10-25T18:00:00Z",
  fundingTxHash: "8769aba1b652b01ee2aafc9083fd1a775722690757e560fb43bd49f98e4856cf",
  evidenceSubmittedAt: "2026-10-30T15:00:00Z",
  committedConditionHash: conditionHash(condition),
};

export const receiptEvidence: EvidenceItem = {
  type: "receipt_photo",
  uri: "s3://evidence/ag-1/remito.jpg",
  sha256: "a".repeat(64),
  mimeType: "image/jpeg",
  uploader: marta.publicKey(),
  createdAt: "2026-10-30T15:00:00Z",
};
