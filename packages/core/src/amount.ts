/** Stellar assets carry 7 decimals; the smallest unit is a stroop. */
export const ASSET_DECIMALS = 7;

const AMOUNT_RE = /^\d+(\.\d+)?$/;

/** "100.5" -> 1005000000n. Rejects negatives, exponents and extra precision. */
export function toStroops(amount: string, decimals = ASSET_DECIMALS): bigint {
  if (!AMOUNT_RE.test(amount)) throw new RangeError(`invalid amount: ${amount}`);
  const [whole, frac = ""] = amount.split(".");
  if (frac.length > decimals) throw new RangeError(`too many decimals in amount: ${amount}`);
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, "0") || "0");
}

/** 1005000000n -> "100.5000000" */
export function fromStroops(stroops: bigint, decimals = ASSET_DECIMALS): string {
  if (stroops < 0n) throw new RangeError("negative amount");
  const s = stroops.toString().padStart(decimals + 1, "0");
  return s.slice(0, -decimals) + "." + s.slice(-decimals);
}
