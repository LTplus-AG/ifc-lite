/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import {
  generateIfcGuid,
  generateUuid,
  ifcGuidToUuid,
  isValidIfcGuid,
  isValidUuid,
  uuidToIfcGuid,
} from './guid.js';

describe('guid', () => {
  it('round-trips UUIDs through IFC GUID encoding', () => {
    const uuid = '550e8400-e29b-41d4-a716-446655440000';
    const ifcGuid = uuidToIfcGuid(uuid);

    expect(ifcGuidToUuid(ifcGuid)).toBe(uuid);
    expect(isValidIfcGuid(ifcGuid)).toBe(true);
  });

  it('encodes a UUID to the exact IFC GUID produced by IfcOpenShell compress/expand (not just self-round-trip)', () => {
    // Round-trip-only assertions cannot detect a wrong-but-internally-
    // consistent IFC_GUID_CHARS alphabet: swapping two characters in it
    // leaves uuidToIfcGuid/ifcGuidToUuid mutually consistent, so this test
    // pins an externally-verified value instead.
    //
    // Expected value derived from IfcOpenShell's `legacy_compress`
    // algorithm (identical to its current `ifcopenshell.guid.compress`),
    // taken verbatim from
    // https://github.com/IfcOpenShell/IfcOpenShell/blob/v0.9.0/src/ifcopenshell-python/test/test_guid.py
    // and hand-executed here (not via this repo's own encoder). This is
    // the same UUID buildingSMART's own documentation uses as its worked
    // example (see packages/bcf/src/guid.test.ts):
    //
    //   uuid_orig = "3d2b2fa43b2f11e0b7a700163e7a5e00"
    //   chars = string.digits + string.ascii_uppercase + string.ascii_lowercase + "_$"
    //   def legacy_compress(g):
    //       bs = [int(g[i:i+2], 16) for i in range(0, len(g), 2)]
    //       def b64(v, l=4):
    //           return "".join([chars[(v // (64 ** i)) % 64] for i in range(l)][::-1])
    //       return "".join([b64(bs[0], 2)] + [b64((bs[i] << 16) + (bs[i+1] << 8) + bs[i+2]) for i in range(1, 16, 3)])
    //   legacy_compress(uuid_orig)  # => "0zAo_aEoyHuBUd01O_Ubu0"
    //
    // Chosen (over other candidate vectors, e.g. the "656d1ed0..." UUID
    // used in that same IfcOpenShell test file) because its expected
    // output contains both 'A' and 'B': a test vector whose output never
    // hits the swapped characters would pass even against a mutated
    // alphabet, silently failing to guard against exactly the bug this
    // test exists to catch.
    const uuid = '3d2b2fa4-3b2f-11e0-b7a7-00163e7a5e00';
    const expectedIfcGuid = '0zAo_aEoyHuBUd01O_Ubu0';

    expect(uuidToIfcGuid(uuid)).toBe(expectedIfcGuid);
    expect(ifcGuidToUuid(expectedIfcGuid)).toBe(uuid);
  });

  it('rejects a UUID string containing non-hex characters instead of silently zeroing them', () => {
    // hex.length === 32 after stripping dashes, so the length guard passes;
    // parseInt('GG', 16) is NaN, and Uint8Array coerces NaN to 0. Nothing
    // throws today - a garbage UUID silently becomes the all-zero UUID's
    // GUID instead of being rejected.
    expect(() => uuidToIfcGuid('gggggggg-gggg-gggg-gggg-gggggggggggg')).toThrow();
  });

  it('generates schema-valid IFC GUIDs', () => {
    for (let i = 0; i < 100; i++) {
      const ifcGuid = generateIfcGuid();
      expect(isValidIfcGuid(ifcGuid)).toBe(true);
      expect(ifcGuid).toHaveLength(22);
      expect(['0', '1', '2', '3']).toContain(ifcGuid[0]);
    }
  });

  it('generates RFC-style UUID strings', () => {
    const uuid = generateUuid();
    expect(isValidUuid(uuid)).toBe(true);
  });

  it('generates deterministic UUIDs and IFC GUIDs from a seeded RandomSource', () => {
    // Simple LCG: same seed => same stream => same GUID.
    const seeded = (seed: number) => {
      let s = seed;
      return () => {
        s = (s * 1103515245 + 12345) % 2147483648;
        return s / 2147483648;
      };
    };

    const a = generateUuid(seeded(42));
    const b = generateUuid(seeded(42));
    expect(a).toBe(b);
    expect(isValidUuid(a)).toBe(true);
    // Version/variant bits are still forced (v4-shaped).
    expect(a[14]).toBe('4');
    expect(['8', '9', 'a', 'b']).toContain(a[19]);
    // A different seed diverges.
    expect(generateUuid(seeded(43))).not.toBe(a);

    const g1 = generateIfcGuid(seeded(7));
    const g2 = generateIfcGuid(seeded(7));
    expect(g1).toBe(g2);
    expect(isValidIfcGuid(g1)).toBe(true);
  });

  it('draws bytes from the provided source, not the CSPRNG', () => {
    // An all-zero source pins every byte except the forced version/variant
    // bits, so the exact output proves crypto.randomUUID was bypassed.
    expect(generateUuid(() => 0)).toBe('00000000-0000-4000-8000-000000000000');
  });

  it('rejects an IFC GUID whose first character encodes a value above 3', () => {
    // An IfcGloballyUniqueId packs a 128-bit UUID into 22 base64-like
    // characters (22 * 6 = 132 bits), so the first character only carries
    // the UUID's top 2 bits and must be restricted to values 0-3 (chars
    // '0'..'3' in IFC_GUID_CHARS). '4' is the char at index 4, one past the
    // valid range, so a well-formed-looking 22-char string starting with
    // '4' must still be rejected.
    const guid = `4${'0'.repeat(21)}`;
    expect(guid).toHaveLength(22);
    expect(isValidIfcGuid(guid)).toBe(false);
  });

  it('accepts every legal first character (0-3) and rejects the next value (4)', () => {
    for (const validFirst of ['0', '1', '2', '3']) {
      expect(isValidIfcGuid(`${validFirst}${'A'.repeat(21)}`)).toBe(true);
    }
    expect(isValidIfcGuid(`4${'A'.repeat(21)}`)).toBe(false);
  });

  it('keeps the default path valid and non-repeating', () => {
    // Assert the CONTRACT (well-formed, distinct across a run) rather than a
    // single inequality: two draws colliding is astronomically unlikely but is
    // a property of the generator, not something a pair-wise compare proves.
    const uuids = new Set<string>();
    const guids = new Set<string>();
    for (let i = 0; i < 100; i++) {
      const u = generateUuid();
      expect(u).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
      uuids.add(u);
      const g = generateIfcGuid();
      expect(isValidIfcGuid(g)).toBe(true);
      guids.add(g);
    }
    expect(uuids.size).toBe(100);
    expect(guids.size).toBe(100);
  });
});
