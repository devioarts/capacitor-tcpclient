// src/utils/expect.ts

/**
 * Input supported by the RR "expect" option:
 * - hex string: "1b40", "0x1B 40", "1B 40"
 * - number[]:  [27, 64]
 * - Uint8Array
 */
export type ExpectInput = string | number[] | Uint8Array | null | undefined;

/**
 * Parse an "expect" value into raw bytes.
 * Returns a fresh Uint8Array or null on invalid input.
 *
 * Rules:
 * - Whitespace and optional "0x" prefixes are ignored for strings.
 * - Hex strings must have even length and contain only [0-9a-f].
 * - number[] values must be integer bytes in the 0..255 range.
 */
export function parseExpectBytes(expect: ExpectInput): Uint8Array | null {
  if (!expect) return null;

  if (expect instanceof Uint8Array) {
    // Defensive copy so callers can safely mutate their original.
    return expect.length === 0 ? null : new Uint8Array(expect);
  }

  if (Array.isArray(expect)) {
    if (expect.length === 0) return null;
    const out = new Uint8Array(expect.length);
    for (let i = 0; i < expect.length; i++) {
      const value = expect[i];
      if (!Number.isInteger(value) || value < 0 || value > 255) return null;
      out[i] = value;
    }
    return out;
  }

  if (typeof expect === 'string') {
    const clean = expect.replace(/0x/gi, '').replace(/\s+/g, '').toLowerCase();
    if (!clean || clean.length % 2) return null;
    const out = new Uint8Array(clean.length / 2);
    for (let i = 0; i < clean.length; i += 2) {
      const v = parseInt(clean.slice(i, i + 2), 16);
      if (Number.isNaN(v)) return null;
      out[i / 2] = v & 0xff;
    }
    return out;
  }

  return null;
}
