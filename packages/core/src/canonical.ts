import { createHash } from "node:crypto";

/**
 * JSON Canonicalization Scheme (RFC 8785).
 *
 * Object keys are sorted by UTF-16 code units (the default `Array.prototype.sort`
 * order for strings), `undefined` members are dropped, and primitives use the
 * ES JSON.stringify serialization that the RFC mandates. Two parties that hold
 * the same data always produce the same bytes, so the hash of a condition or an
 * envelope is stable across backends.
 */
export function canonicalize(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("cannot canonicalize a non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return "[" + value.map((v) => canonicalize(v === undefined ? null : v)).join(",") + "]";
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record)
      .filter((k) => record[k] !== undefined)
      .sort();
    return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalize(record[k])).join(",") + "}";
  }
  throw new TypeError(`cannot canonicalize a value of type ${typeof value}`);
}

export function sha256Hex(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

/** sha256 over the canonical form. This is the only hash the protocol uses. */
export function hashCanonical(value: unknown): string {
  return sha256Hex(canonicalize(value));
}
