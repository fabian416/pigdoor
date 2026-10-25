import { describe, expect, it } from "vitest";
import { canonicalize, hashCanonical } from "../src/canonical.ts";

describe("canonicalize (RFC 8785)", () => {
  it("matches the RFC 8785 sample vector", () => {
    const input = JSON.parse(
      '{"numbers":[333333333.33333329,1E30,4.50,2e-3,0.000000000000000000000000001],' +
        '"string":"\\u20ac$\\u000F\\u000aA\'\\u0042\\u0022\\u005c\\\\\\"\\/","literals":[null,true,false]}',
    );
    expect(canonicalize(input)).toBe(
      '{"literals":[null,true,false],"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],"string":"€$\\u000f\\nA\'B\\"\\\\\\\\\\"/"}',
    );
  });

  it("sorts keys regardless of insertion order and ignores undefined members", () => {
    const a = canonicalize({ b: 1, a: { d: undefined, c: [1, "x"] } });
    const b = canonicalize({ a: { c: [1, "x"] }, b: 1 });
    expect(a).toBe('{"a":{"c":[1,"x"]},"b":1}');
    expect(a).toBe(b);
  });

  it("hashes identically across key order", () => {
    expect(hashCanonical({ x: 1, y: [true] })).toBe(hashCanonical({ y: [true], x: 1 }));
    expect(hashCanonical({ x: 1 })).not.toBe(hashCanonical({ x: 2 }));
  });

  it("refuses values JSON cannot carry faithfully", () => {
    expect(() => canonicalize({ n: Number.NaN })).toThrow(TypeError);
    expect(() => canonicalize({ n: 1n })).toThrow(TypeError);
  });
});
