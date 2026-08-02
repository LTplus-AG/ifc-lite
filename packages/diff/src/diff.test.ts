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

  it('echoes an empty excludedTypes by default', () => {
    expect(diffModels([fp('a')], [fp('a')]).excludedTypes).toEqual([]);
  });
});

describe('diffModels - excludeTypes blacklist (issue #1470)', () => {
  it('drops a blacklisted class from both revisions (not added/deleted/unchanged)', () => {
    const base = [fp('wall', { ifcType: 'IfcWall' }), fp('void', { ifcType: 'IfcOpeningElement' })];
    const head = [fp('wall', { ifcType: 'IfcWall' })];

    // Without the blacklist: the opening reads as deleted.
    const plain = diffModels(base, head);
    expect(plain.byKey.get('void')?.state).toBe('deleted');
    expect(plain.counts.deleted).toBe(1);

    // With it: the opening is not considered at all.
    const filtered = diffModels(base, head, { excludeTypes: ['IfcOpeningElement'] });
    expect(filtered.byKey.has('void')).toBe(false);
    expect(filtered.entries.some((e) => e.key === 'void')).toBe(false);
    expect(filtered.counts).toEqual({ added: 0, modified: 0, deleted: 0, unchanged: 1 });
    expect(filtered.byKey.get('wall')?.state).toBe('unchanged');
  });

  it('the reported scenario: a removed window is reported, its opening is not', () => {
    // v1 has a window + its hosting opening; v2 removed the window (and its opening).
    const v1 = [
      fp('window', { ifcType: 'IfcWindow' }),
      fp('opening', { ifcType: 'IfcOpeningElement' }),
    ];
    const v2: EntityFingerprint<number>[] = [];

    const diff = diffModels(v1, v2, { excludeTypes: ['IfcOpeningElement'] });
    expect(diff.byKey.get('window')?.state).toBe('deleted');
    expect(diff.byKey.has('opening')).toBe(false);
    expect(diff.counts.deleted).toBe(1);
  });

  it('excludes an unchanged blacklisted element too (never counted)', () => {
    const base = [fp('w', { ifcType: 'IfcWall' }), fp('o', { ifcType: 'IfcOpeningElement' })];
    const head = [fp('w', { ifcType: 'IfcWall' }), fp('o', { ifcType: 'IfcOpeningElement' })];
    const diff = diffModels(base, head, { excludeTypes: ['IfcOpeningElement'] });
    expect(diff.counts.unchanged).toBe(1);
    expect(diff.byKey.has('o')).toBe(false);
  });

  it('matches case-insensitively and ignores surrounding whitespace', () => {
    const base = [fp('o', { ifcType: 'IfcOpeningElement' })];
    const head: EntityFingerprint<number>[] = [];
    for (const spelling of ['ifcopeningelement', '  IFCOPENINGELEMENT  ', 'IfcOpeningElement']) {
      const diff = diffModels(base, head, { excludeTypes: [spelling] });
      expect(diff.byKey.has('o')).toBe(false);
      expect(diff.counts.deleted).toBe(0);
    }
  });

  it('ignores empty / whitespace-only exclude names (does not blank the whole diff)', () => {
    const base = [fp('a', { ifcType: 'IfcWall' })];
    const head = [fp('b', { ifcType: 'IfcWall' })];
    const diff = diffModels(base, head, { excludeTypes: ['', '   ', '\t'] });
    expect(diff.excludedTypes).toEqual([]);
    expect(diff.counts).toEqual({ added: 1, modified: 0, deleted: 1, unchanged: 0 });
  });

  it('echoes the applied excludedTypes: normalized, deduped, sorted', () => {
    const diff = diffModels(
      [fp('a', { ifcType: 'IfcWall' })],
      [fp('a', { ifcType: 'IfcWall' })],
      { excludeTypes: ['IfcSpace', 'ifcopeningelement', 'IFCSPACE', '  '] },
    );
    expect(diff.excludedTypes).toEqual(['IFCOPENINGELEMENT', 'IFCSPACE']);
  });

  it('leaves non-blacklisted classes untouched', () => {
    const base = [fp('wall', { ifcType: 'IfcWall' }), fp('door', { ifcType: 'IfcDoor' })];
    const head = [fp('door', { ifcType: 'IfcDoor' })];
    const diff = diffModels(base, head, { excludeTypes: ['IfcOpeningElement'] });
    expect(diff.byKey.get('wall')?.state).toBe('deleted');
    expect(diff.byKey.get('door')?.state).toBe('unchanged');
  });

  it('excludes via the UNION of both revisions (a re-class cannot leak back)', () => {
    // Same GlobalId re-classed across versions; the old class is blacklisted.
    const base = [fp('g', { ifcType: 'IfcWall' })];
    const head = [fp('g', { ifcType: 'IfcWallStandardCase' })];

    // Without the blacklist it is a real (data) modification...
    expect(diffModels(base, head).byKey.get('g')?.state).toBe('modified');

    // ...with IfcWall excluded, the entity is dropped entirely - NOT a phantom
    // "added" IfcWallStandardCase.
    const excl = diffModels(base, head, { excludeTypes: ['IfcWall'] });
    expect(excl.byKey.has('g')).toBe(false);
    expect(excl.counts).toEqual({ added: 0, modified: 0, deleted: 0, unchanged: 0 });
  });

  it('union exclusion also fires when only the HEAD revision has the excluded class', () => {
    const base = [fp('g', { ifcType: 'IfcWallStandardCase' })];
    const head = [fp('g', { ifcType: 'IfcWall' })];
    const diff = diffModels(base, head, { excludeTypes: ['IfcWall'] });
    expect(diff.byKey.has('g')).toBe(false);
    expect(diff.counts).toEqual({ added: 0, modified: 0, deleted: 0, unchanged: 0 });
  });
});
