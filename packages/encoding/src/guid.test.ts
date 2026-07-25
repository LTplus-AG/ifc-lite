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

  it('keeps the default path random', () => {
    expect(generateUuid()).not.toBe(generateUuid());
    expect(generateIfcGuid()).not.toBe(generateIfcGuid());
  });
});
