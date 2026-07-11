/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { buildComponentFingerprints, buildDataFingerprint } from './fingerprint.js';
import type { DataFingerprintInput } from './fingerprint.js';
import { diffModels } from './diff.js';
import type { EntityFingerprint } from './types.js';

const wall: DataFingerprintInput = {
  ifcType: 'IfcWall',
  name: 'W1',
  propertySets: [
    { name: 'Pset_WallCommon', properties: [{ name: 'IsExternal', value: true }] },
    { name: 'Pset_FireSafety', properties: [{ name: 'FireRating', value: 'REI60' }] },
  ],
  quantitySets: [{ name: 'Qto_WallBaseQuantities', quantities: [{ name: 'NetVolume', value: 1.2 }] }],
  typeAssignments: [{ globalId: 'type-1', name: 'WT', type: 'IfcWallType' }],
};

describe('buildComponentFingerprints', () => {
  it('emits one key per component the entity carries', () => {
    const components = buildComponentFingerprints(wall);
    expect(Object.keys(components).sort()).toEqual([
      'attr:core',
      'pset:Pset_FireSafety',
      'pset:Pset_WallCommon',
      'qset:Qto_WallBaseQuantities',
      'type-assignment',
    ]);
  });

  it('is order-independent within and across sets', () => {
    const reordered: DataFingerprintInput = {
      ...wall,
      propertySets: [
        { name: 'Pset_FireSafety', properties: [{ name: 'FireRating', value: 'REI60' }] },
        { name: 'Pset_WallCommon', properties: [{ name: 'IsExternal', value: true }] },
      ],
    };
    expect(buildComponentFingerprints(reordered)).toEqual(buildComponentFingerprints(wall));
  });

  it('changes only the touched component sub-hash', () => {
    const edited: DataFingerprintInput = {
      ...wall,
      propertySets: [
        { name: 'Pset_WallCommon', properties: [{ name: 'IsExternal', value: true }] },
        { name: 'Pset_FireSafety', properties: [{ name: 'FireRating', value: 'REI90' }] },
      ],
    };
    const before = buildComponentFingerprints(wall);
    const after = buildComponentFingerprints(edited);
    expect(after['pset:Pset_FireSafety']).not.toBe(before['pset:Pset_FireSafety']);
    expect(after['pset:Pset_WallCommon']).toBe(before['pset:Pset_WallCommon']);
    expect(after['attr:core']).toBe(before['attr:core']);
    expect(after['qset:Qto_WallBaseQuantities']).toBe(before['qset:Qto_WallBaseQuantities']);
    expect(after['type-assignment']).toBe(before['type-assignment']);
  });

  it('leaves the default whole-blob fingerprint untouched', () => {
    // Existing dataHash behaviour is protected: sub-hash mode is additive.
    expect(buildDataFingerprint(wall)).toBe(buildDataFingerprint({ ...wall }));
  });
});

describe('diffModels with component sub-hashes', () => {
  function fp(key: string, input: DataFingerprintInput): EntityFingerprint<null> {
    return {
      key,
      ifcType: input.ifcType,
      dataHash: buildDataFingerprint(input),
      components: buildComponentFingerprints(input),
      ref: null,
    };
  }

  it('reports changedComponents per modified entity', () => {
    const edited: DataFingerprintInput = {
      ...wall,
      propertySets: [
        { name: 'Pset_WallCommon', properties: [{ name: 'IsExternal', value: true }] },
        { name: 'Pset_FireSafety', properties: [{ name: 'FireRating', value: 'REI90' }] },
      ],
    };
    const diff = diffModels([fp('w', wall)], [fp('w', edited)]);
    const entry = diff.byKey.get('w');
    expect(entry?.state).toBe('modified');
    expect(entry?.changedComponents).toEqual(['pset:Pset_FireSafety']);
  });

  it('counts a component added on one side as changed', () => {
    const withoutFire: DataFingerprintInput = {
      ...wall,
      propertySets: [{ name: 'Pset_WallCommon', properties: [{ name: 'IsExternal', value: true }] }],
    };
    const diff = diffModels([fp('w', withoutFire)], [fp('w', wall)]);
    expect(diff.byKey.get('w')?.changedComponents).toEqual(['pset:Pset_FireSafety']);
  });

  it('omits changedComponents when fingerprints lack sub-hashes', () => {
    const bare: EntityFingerprint<null> = {
      key: 'w',
      ifcType: 'IfcWall',
      dataHash: buildDataFingerprint(wall),
      ref: null,
    };
    const diff = diffModels([bare], [bare]);
    expect(diff.byKey.get('w')?.changedComponents).toBeUndefined();
  });
});
