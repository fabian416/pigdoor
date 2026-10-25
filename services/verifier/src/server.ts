#!/usr/bin/env node
/**
 * The verifier runs as its own process with its own key. If the same process
 * that funds an escrow also signed releases, the payer would be releasing to
 * itself and the on-chain role separation would be decorative.
 *
 * Env:
 *   VERIFIER_SECRET   S... of the release signer (default: ephemeral, printed)
 *   PUBLIC_URL        where this service is reachable (anchor uri base)
 *   PORT              default 8787
 *   AUTO_RELEASE=1    execute releases on ALLOW (default: report only)
 *   ACCEPT_READINGS=1 demo only: accept precomputed readings instead of photos (refused with AUTO_RELEASE)
 *   API_TOKEN         bearer token the product backend must send on writes (unset = open, local dev only)
 *   ESCROW=memory|tw  escrow backend (default memory; tw needs TW_* vars)
 *   ANTHROPIC_API_KEY or `ant auth login` for the semantic verifier
 */
import { serve } from "@hono/node-server";
import { readFileSync } from "node:fs";
import { Keypair } from "@workspace/core";
import { anthropicModel } from "@workspace/semantic";
import { createApp } from "./app.ts";
import { inMemoryEscrowClient, trustlessWorkClient } from "./escrow-client.ts";
import { fileStore } from "./store.ts";

const port = Number(process.env.PORT ?? 8787);
const publicUrl = process.env.PUBLIC_URL ?? `http://localhost:${port}`;

const verifierKey = process.env.VERIFIER_SECRET ? Keypair.fromSecret(process.env.VERIFIER_SECRET) : Keypair.random();
if (!process.env.VERIFIER_SECRET) console.warn(`VERIFIER_SECRET not set; ephemeral verifier ${verifierKey.publicKey()}`);

const hasModelCredentials = Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN) || existsAntProfile();
const model = hasModelCredentials ? anthropicModel() : undefined;
if (!model) console.warn("no Anthropic credentials; only precomputed readings will be accepted");

const escrow =
  process.env.ESCROW === "tw"
    ? trustlessWorkClient({
        baseUrl: process.env.TW_BASE_URL ?? "https://beta.api.trustlesswork.com",
        apiKey: required("TW_API_KEY"),
        releaseSignerSecret: required("VERIFIER_SECRET"),
      })
    : seededMemoryEscrow();

const app = createApp({
  verifierKey,
  escrow,
  store: fileStore(process.env.DATA_DIR ?? "./data"),
  model,
  publicUrl,
  autoRelease: process.env.AUTO_RELEASE === "1",
  acceptReadings: process.env.ACCEPT_READINGS === "1",
  apiToken: process.env.API_TOKEN,
});
if (!process.env.API_TOKEN) console.warn("API_TOKEN not set; write endpoints are open (local dev only)");

serve({ fetch: app.fetch, port }, () => console.log(`verifier listening on ${publicUrl} as ${verifierKey.publicKey()}`));

function required(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`missing ${name}`);
    process.exit(2);
  }
  return v;
}

function existsAntProfile(): boolean {
  try {
    readFileSync(`${process.env.HOME}/.config/anthropic/profiles.json`);
    return true;
  } catch {
    return false;
  }
}

/** Demo escrow: milestone 1 of agreement "demo" funded with the example facts. */
function seededMemoryEscrow() {
  const facts = JSON.parse(readFileSync(new URL("../../../examples/facts.json", import.meta.url), "utf8"));
  return inMemoryEscrowClient({ "demo/1": facts }).client;
}
