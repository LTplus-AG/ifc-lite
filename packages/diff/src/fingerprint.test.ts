/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import {
  buildDataFingerprint,
  normalizeValue,
  stableHash,
  type DataFingerprintInput,
} from './fingerprint.js';

describe('stableHash', () => {
  it('is deterministic and distinguishes inputs', () => {
    expect(stableHash('hello')).toBe(stableHash('hello'));
    expect(stableHash('hello')).not.toBe(stableHash('world'));
  });
});

describe('normalizeValue', () => {
  it('passes scalars through and serializes objects', () => {
    expect(normalizeValue(null)).toBeNull();
    expect(normalizeValue(undefined)).toBeNull();
    expect(normalizeValue('x')).toBe('x');
    expect(normalizeValue(3)).toBe(3);
    expect(normalizeValue(true)).toBe(true);
    expect(normalizeValue({ a: 1 })).toBe('{"a":1}');
  });
});

describe('buildDataFingerprint', () => {
  it('is independent of property-set / member / type-assignment ordering', () => {
    const a: DataFingerprintInput = {
      ifcType: 'IfcWall',
      name: 'W1',
      propertySets: [
        { name: 'Pset_A', properties: [{ name: 'x', value: 1 }, { name: 'y', value: 2 }] },
        { name: 'Pset_B', properties: [{ name: 'z', value: 3 }] },
      ],
      quantitySets: [{ name: 'Qto', quantities: [{ name: 'Vol', value: 10 }] }],
      typeAssignments: [
        { globalId: 'g1', name: 'T1', type: 'IfcWallType' },
        { globalId: 'g2', name: 'T2', type: 'IfcWallType' },
      ],
    };
    const shuffled: DataFingerprintInput = {
      ifcType: 'IfcWall',
      name: 'W1',
      propertySets: [
        { name: 'Pset_B', properties: [{ name: 'z', value: 3 }] },
        { name: 'Pset_A', properties: [{ name: 'y', value: 2 }, { name: 'x', value: 1 }] },
      ],
      quantitySets: [{ name: 'Qto', quantities: [{ name: 'Vol', value: 10 }] }],
      typeAssignments: [
        { globalId: 'g2', name: 'T2', type: 'IfcWallType' },
        { globalId: 'g1', name: 'T1', type: 'IfcWallType' },
      ],
    };
    expect(buildDataFingerprint(a)).toBe(buildDataFingerprint(shuffled));
  });

  it('changes when a property value changes', () => {
    const base: DataFingerprintInput = {
      ifcType: 'IfcWall',
      propertySets: [{ name: 'Pset', properties: [{ name: 'Fire', value: 'A' }] }],
    };
    const edited: DataFingerprintInput = {
      ifcType: 'IfcWall',
      propertySets: [{ name: 'Pset', properties: [{ name: 'Fire', value: 'B' }] }],
    };
    expect(buildDataFingerprint(base)).not.toBe(buildDataFingerprint(edited));
  });

  it('changes when the IFC type or core attributes change', () => {
    const base: DataFingerprintInput = { ifcType: 'IfcWall', name: 'W' };
    expect(buildDataFingerprint(base)).not.toBe(
      buildDataFingerprint({ ...base, ifcType: 'IfcWallStandardCase' }),
    );
    expect(buildDataFingerprint(base)).not.toBe(buildDataFingerprint({ ...base, name: 'W2' }));
  });

  it('includes PredefinedType — value vs unset differ (issue #1361)', () => {
    // A re-export that drops `.POST.` → `$` is a real change a coordinator may
    // want to see; the fingerprint must reflect it. (Bonsai's default diff is
    // attribute-blind and would not, which is the reported discrepancy.)
    const withType: DataFingerprintInput = { ifcType: 'IfcMember', name: 'member', predefinedType: 'POST' };
    const unset: DataFingerprintInput = { ifcType: 'IfcMember', name: 'member' };
    expect(buildDataFingerprint(withType)).not.toBe(buildDataFingerprint(unset));
    // An unset PredefinedType hashes identically to an explicit-empty one.
    expect(buildDataFingerprint(unset)).toBe(
      buildDataFingerprint({ ...unset, predefinedType: '' }),
    );
  });

  it('treats absent optional collections as empty (stable)', () => {
    expect(buildDataFingerprint({ ifcType: 'IfcWall' })).toBe(
      buildDataFingerprint({
        ifcType: 'IfcWall',
        propertySets: [],
        quantitySets: [],
        typeAssignments: [],
      }),
    );
  });
});
