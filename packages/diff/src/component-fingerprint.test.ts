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

  it('projects type assignments exactly as buildDataFingerprint does — no GlobalId', () => {
    // Not a stylistic duplication: `componentsAgree` in the content pass is a
    // collision guard justified by "a component hashes a slice of what
    // `dataHash` hashes whole". Keeping the type's GlobalId here while
    // `dataHash` drops it would break that justification and make the guard
    // veto genuine re-export matches.
    const reGuided: DataFingerprintInput = {
      ...wall,
      typeAssignments: [{ globalId: 'type-2-after-re-export', name: 'WT', type: 'IfcWallType' }],
    };
    expect(buildComponentFingerprints(reGuided)['type-assignment']).toBe(
      buildComponentFingerprints(wall)['type-assignment'],
    );
    expect(buildDataFingerprint(reGuided)).toBe(buildDataFingerprint(wall));

    // A different type name is still a different sub-hash.
    const retyped: DataFingerprintInput = {
      ...wall,
      typeAssignments: [{ globalId: 'type-1', name: 'WT-OTHER', type: 'IfcWallType' }],
    };
    expect(buildComponentFingerprints(retyped)['type-assignment']).not.toBe(
      buildComponentFingerprints(wall)['type-assignment'],
    );
  });

  it('carries Tag in attr:core, exactly as buildDataFingerprint does (issue #2021)', () => {
    // Same collision-guard argument as the type-assignment case above, in the
    // other direction: `dataHash` now hashes `Tag`, so `attr:core` must too. If
    // it did not, two type objects differing only in Tag would disagree on
    // `dataHash` (no match, fine) but a colliding pair would agree on every
    // sub-hash, and the guard would have lost the only slice that saw the Tag.
    const retagged: DataFingerprintInput = { ...wall, tag: '157607' };
    const before = buildComponentFingerprints({ ...wall, tag: '157200' });
    const after = buildComponentFingerprints(retagged);
    expect(after['attr:core']).not.toBe(before['attr:core']);
    expect(after['pset:Pset_WallCommon']).toBe(before['pset:Pset_WallCommon']);
    expect(after['type-assignment']).toBe(before['type-assignment']);
    expect(buildDataFingerprint(retagged)).not.toBe(
      buildDataFingerprint({ ...wall, tag: '157200' }),
    );
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

  it('does not report a re-GUIDed type as a changed component on a kept key', () => {
    // The key-based pass reads `state` off `dataHash` and `changedComponents`
    // off the sub-hashes. If only one of the two ignored the type's GlobalId,
    // an element that kept its own GlobalId across a re-export would come out
    // `unchanged` while listing `type-assignment` as changed — a
    // self-contradictory entry. One projection, one answer.
    const reGuided: DataFingerprintInput = {
      ...wall,
      typeAssignments: [{ globalId: 'type-2-after-re-export', name: 'WT', type: 'IfcWallType' }],
    };
    const diff = diffModels([fp('w', wall)], [fp('w', reGuided)]);
    const entry = diff.byKey.get('w');
    expect(entry?.state).toBe('unchanged');
    expect(entry?.changedComponents).toEqual([]);
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

  it('omits changedComponents when only ONE side carries sub-hashes, not both', () => {
    // `components` is opt-in per-fingerprint (docs on `DiffEntry.changedComponents`:
    // "Present only when both fingerprints carry `components`"). A caller that
    // supplies sub-hashes for the head revision only — a partial rollout of the
    // sub-hash adapter, or a base fingerprint computed before this field existed —
    // must not have the missing side read as an EMPTY component map: that would
    // report every one of the present side's component keys as "changed" when
    // there is no evidence either way, contradicting the documented contract and
    // the identical abstention `componentsAgree` (content-match pass) already
    // takes for exactly this asymmetry.
    const base: EntityFingerprint<null> = {
      key: 'w',
      ifcType: 'IfcWall',
      dataHash: buildDataFingerprint(wall),
      // no `components` on this side
      ref: null,
    };
    const head = fp('w', wall);
    const diff = diffModels([base], [head]);
    expect(diff.byKey.get('w')?.changedComponents).toBeUndefined();
  });

  it('sorts changedComponents when multiple keys differ, regardless of object insertion order', () => {
    // Object key insertion order here is deliberately the REVERSE of alphabetical
    // ('pset:Z...' before 'pset:A...'), so a build that returns the union in
    // encounter order (base keys first, then head-only keys) rather than
    // `.sort()`-ed order would still pass every OTHER test in this file — every
    // existing changedComponents assertion has exactly one entry, where
    // encounter order and sorted order are indistinguishable. This pins the
    // sorted contract with two entries whose natural order differs from sorted.
    const before: EntityFingerprint<null> = {
      key: 'w',
      ifcType: 'IfcWall',
      dataHash: 'd0',
      components: { 'pset:Zeta': 'z1', 'pset:Alpha': 'a1' },
      ref: null,
    };
    const after: EntityFingerprint<null> = {
      ...before,
      components: { 'pset:Zeta': 'z2', 'pset:Alpha': 'a2' },
    };
    const diff = diffModels([before], [after]);
    expect(diff.byKey.get('w')?.changedComponents).toEqual(['pset:Alpha', 'pset:Zeta']);
  });
});
