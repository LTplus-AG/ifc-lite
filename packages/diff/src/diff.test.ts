/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { diffModels } from './diff.js';
import { buildDataFingerprint } from './fingerprint.js';
import type { EntityFingerprint } from './types.js';

/** Terse fingerprint builder for tests. */
function fp(
  key: string,
  opts: Partial<Omit<EntityFingerprint<number>, 'key'>> = {},
): EntityFingerprint<number> {
  return {
    key,
    ifcType: opts.ifcType ?? 'IfcWall',
    dataHash: opts.dataHash ?? 'd0',
    geometryHash: opts.geometryHash,
    ref: opts.ref ?? 0,
  };
}

describe('diffModels — presence', () => {
  it('classifies added / deleted / unchanged by key', () => {
    const base = [fp('a'), fp('b')];
    const head = [fp('b'), fp('c')];
    const diff = diffModels(base, head);

    expect(diff.byKey.get('a')?.state).toBe('deleted');
    expect(diff.byKey.get('b')?.state).toBe('unchanged');
    expect(diff.byKey.get('c')?.state).toBe('added');
    expect(diff.counts).toEqual({ added: 1, modified: 0, deleted: 1, unchanged: 1 });
  });

  it('carries base/head refs for matched and one-sided entries', () => {
    const diff = diffModels(
      [fp('a', { ref: 10 }), fp('gone', { ref: 11 })],
      [fp('a', { ref: 20 }), fp('new', { ref: 21 })],
    );
    expect(diff.byKey.get('a')?.base?.ref).toBe(10);
    expect(diff.byKey.get('a')?.head?.ref).toBe(20);
    expect(diff.byKey.get('gone')?.base?.ref).toBe(11);
    expect(diff.byKey.get('gone')?.head).toBeUndefined();
    expect(diff.byKey.get('new')?.head?.ref).toBe(21);
    expect(diff.byKey.get('new')?.base).toBeUndefined();
  });

  it('first occurrence of a duplicated key wins', () => {
    const diff = diffModels(
      [fp('dup', { ref: 1 }), fp('dup', { ref: 2 })],
      [fp('dup', { ref: 9 })],
    );
    expect(diff.counts.unchanged).toBe(1);
    expect(diff.byKey.get('dup')?.base?.ref).toBe(1);
  });
});

describe('diffModels — data vs geometry scope', () => {
  const base = [fp('w', { dataHash: 'd1', geometryHash: 100n })];
  const dataChanged = [fp('w', { dataHash: 'd2', geometryHash: 100n })];
  const geomChanged = [fp('w', { dataHash: 'd1', geometryHash: 200n })];
  const bothChanged = [fp('w', { dataHash: 'd2', geometryHash: 200n })];

  it('scope "data" only flags data changes', () => {
    expect(diffModels(base, dataChanged, { scope: 'data' }).byKey.get('w')?.state).toBe('modified');
    expect(diffModels(base, geomChanged, { scope: 'data' }).byKey.get('w')?.state).toBe('unchanged');
  });

  it('scope "geometry" only flags geometry changes', () => {
    expect(diffModels(base, geomChanged, { scope: 'geometry' }).byKey.get('w')?.state).toBe('modified');
    expect(diffModels(base, dataChanged, { scope: 'geometry' }).byKey.get('w')?.state).toBe('unchanged');
  });

  it('scope "both" (default) flags either, and records changeKinds', () => {
    const d = diffModels(base, bothChanged).byKey.get('w');
    expect(d?.state).toBe('modified');
    expect(d?.changeKinds.sort()).toEqual(['data', 'geometry']);

    expect(diffModels(base, dataChanged).byKey.get('w')?.changeKinds).toEqual(['data']);
    expect(diffModels(base, geomChanged).byKey.get('w')?.changeKinds).toEqual(['geometry']);
  });
});

describe('diffModels — type & geometry edge cases', () => {
  it('treats an IFC type change as a data change', () => {
    const d = diffModels(
      [fp('e', { ifcType: 'IfcWall' })],
      [fp('e', { ifcType: 'IfcWallStandardCase' })],
    ).byKey.get('e');
    expect(d?.state).toBe('modified');
    expect(d?.changeKinds).toEqual(['data']);
  });

  it('a bigint hash equals its string form (no false geometry change)', () => {
    const d = diffModels(
      [fp('e', { geometryHash: 42n })],
      [fp('e', { geometryHash: '42' })],
      { scope: 'geometry' },
    ).byKey.get('e');
    expect(d?.state).toBe('unchanged');
  });

  it('geometry appearing or disappearing counts as a change', () => {
    expect(
      diffModels([fp('e')], [fp('e', { geometryHash: 1n })], { scope: 'geometry' }).byKey.get('e')?.state,
    ).toBe('modified');
    expect(
      diffModels([fp('e', { geometryHash: 1n })], [fp('e')], { scope: 'geometry' }).byKey.get('e')?.state,
    ).toBe('modified');
    // Both sides geometry-less → unchanged.
    expect(
      diffModels([fp('e')], [fp('e')], { scope: 'geometry' }).byKey.get('e')?.state,
    ).toBe('unchanged');
  });
});

describe('diffModels — issue #1361 (attribute changes Bonsai ignores)', () => {
  // A user reported ifc-lite's compare flagging changes that buildingSMART's
  // `ifcdiff` (Bonsai) did not. Investigating their two revisions showed the
  // newer export genuinely *dropped* `PredefinedType` from nearly every element
  // (e.g. `.POST.`/`.ELEMENT.`/`.USERDEFINED.` → `$`) and reclassified five
  // `IfcBuildingElementProxy` to `IfcGeographicElement`. Those are real source
  // changes — Bonsai's default diff is attribute-blind, ifc-lite is not. These
  // tests lock in that ifc-lite reports the real deltas (and only the real
  // deltas), so a future "match Bonsai / reduce noise" change can't silently
  // drop genuine change detection.

  // Build the data hash the viewer would, for one entity's relevant fields.
  const hashOf = (input: Parameters<typeof buildDataFingerprint>[0]) =>
    buildDataFingerprint(input);

  it('flags a PredefinedType drop (real value → unset) as a data change', () => {
    const base = [
      fp('e1', {
        ifcType: 'IfcMember',
        dataHash: hashOf({ ifcType: 'IfcMember', name: 'member', predefinedType: 'POST' }),
      }),
    ];
    const head = [
      fp('e1', {
        ifcType: 'IfcMember',
        // Re-exported without a PredefinedType — semantically NOTDEFINED.
        dataHash: hashOf({ ifcType: 'IfcMember', name: 'member' }),
      }),
    ];
    const d = diffModels(base, head, { scope: 'data' }).byKey.get('e1');
    expect(d?.state).toBe('modified');
    expect(d?.changeKinds).toEqual(['data']);
  });

  it('flags a proxy → geographic reclassification (with its type assignment) as a data change', () => {
    const base = [
      fp('e2', {
        ifcType: 'IfcBuildingElementProxy',
        dataHash: hashOf({
          ifcType: 'IfcBuildingElementProxy',
          name: 'feature',
          typeAssignments: [{ name: 'feature', type: 'IfcBuildingElementProxyType' }],
        }),
      }),
    ];
    const head = [
      fp('e2', {
        ifcType: 'IfcGeographicElement',
        dataHash: hashOf({
          ifcType: 'IfcGeographicElement',
          name: 'feature',
          typeAssignments: [{ name: 'feature', type: 'IfcGeographicElementType' }],
        }),
      }),
    ];
    const d = diffModels(base, head, { scope: 'data' }).byKey.get('e2');
    expect(d?.state).toBe('modified');
    expect(d?.changeKinds).toEqual(['data']);
  });

  it('does not flag an element whose attributes are genuinely unchanged', () => {
    const sameInput = { ifcType: 'IfcBuildingElementProxy', name: 'proxy' };
    const d = diffModels(
      [fp('road', { ifcType: 'IfcBuildingElementProxy', dataHash: hashOf(sameInput) })],
      [fp('road', { ifcType: 'IfcBuildingElementProxy', dataHash: hashOf(sameInput) })],
      { scope: 'data' },
    ).byKey.get('road');
    expect(d?.state).toBe('unchanged');
  });
});

describe('diffModels — result shape', () => {
  it('entries and byKey agree and the scope is echoed', () => {
    const diff = diffModels([fp('a')], [fp('a'), fp('b')], { scope: 'data' });
    expect(diff.scope).toBe('data');
    expect(diff.entries).toHaveLength(2);
    expect(new Set(diff.entries.map((e) => e.key))).toEqual(new Set(['a', 'b']));
    for (const entry of diff.entries) {
      expect(diff.byKey.get(entry.key)).toBe(entry);
    }
  });
});
