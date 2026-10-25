import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { envelopeBytes, sha256Hex, type DisputeCase, type VerificationEnvelope } from "@workspace/core";

/**
 * Content-addressed storage for envelopes: the id is the sha256 of the
 * canonical bytes, which is exactly what the anchor line carries. Serving
 * `GET /envelopes/:id` therefore IS the anchor target when IPFS is not used.
 */
export interface Store {
  putEnvelope(envelope: VerificationEnvelope): { id: string; bytes: string };
  getEnvelopeBytes(id: string): string | undefined;
  listEnvelopeIds(): string[];
  putCase(c: DisputeCase): string;
  getCase(id: string): DisputeCase | undefined;
}

export function memoryStore(): Store {
  const envelopes = new Map<string, string>();
  const cases = new Map<string, DisputeCase>();
  return {
    putEnvelope(envelope) {
      const bytes = envelopeBytes(envelope);
      const id = sha256Hex(bytes);
      envelopes.set(id, bytes);
      return { id, bytes };
    },
    getEnvelopeBytes: (id) => envelopes.get(id),
    listEnvelopeIds: () => [...envelopes.keys()],
    putCase(c) {
      const id = sha256Hex(JSON.stringify([c.agreementId, c.milestoneId, c.openedAt, c.openedBy]));
      cases.set(id, c);
      return id;
    },
    getCase: (id) => cases.get(id),
  };
}

/** Same thing on disk, one file per object, for a demo that survives a restart. */
export function fileStore(dir: string): Store {
  const envDir = join(dir, "envelopes");
  const caseDir = join(dir, "cases");
  mkdirSync(envDir, { recursive: true });
  mkdirSync(caseDir, { recursive: true });
  const safe = (id: string) => /^[0-9a-f]{64}$/.test(id);
  const read = (path: string) => {
    try {
      return readFileSync(path, "utf8");
    } catch {
      return undefined;
    }
  };
  return {
    putEnvelope(envelope) {
      const bytes = envelopeBytes(envelope);
      const id = sha256Hex(bytes);
      writeFileSync(join(envDir, `${id}.json`), bytes);
      return { id, bytes };
    },
    getEnvelopeBytes: (id) => (safe(id) ? read(join(envDir, `${id}.json`)) : undefined),
    listEnvelopeIds: () => readdirSync(envDir).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5)),
    putCase(c) {
      const id = sha256Hex(JSON.stringify([c.agreementId, c.milestoneId, c.openedAt, c.openedBy]));
      writeFileSync(join(caseDir, `${id}.json`), JSON.stringify(c));
      return id;
    },
    getCase(id) {
      const text = safe(id) ? read(join(caseDir, `${id}.json`)) : undefined;
      return text ? (JSON.parse(text) as DisputeCase) : undefined;
    },
  };
}
