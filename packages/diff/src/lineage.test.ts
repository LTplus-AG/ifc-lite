/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Lineage (issue #4955): the 1:k artifact an external data owner rekeys on,
 * derived from a diff's committed matches, split/merge claims, and ACCEPTED
 * successor claims — and its digest-pinned sidecar.
 */

import { describe, expect, it } from 'vitest';
import { diffModels } from './diff.js';
import {
  keyAliasesFromLineage,
  lineageConflicts,
  lineageFromDiff,
  lineageOfDiff,
  rekeyByLineage,
  type LineageEntry,
} from './lineage.js';
import {
  createLineageSidecar,
  lineageSidecarMismatches,
  parseLineageSidecar,
  serializeLineageSidecar,
} from './lineage-sidecar.js';
import type { EntityAabb, EntityFingerprint } from './types.js';

type Ref = number;

function box(min: [number, number, number], max: [number, number, number]): EntityAabb {
  return { min, max };
}

function entity(init: {
  key: string;
  aabb: EntityAabb;
  dataHash?: string;
  geometryHash?: string;
  volume?: number;
}): EntityFingerprint<Ref> {
  const fingerprint: EntityFingerprint<Ref> = {
    key: init.key,
    ifcType: 'IfcWall',
    dataHash: init.dataHash ?? init.key,
    geometryHash: init.geometryHash ?? `g@${init.key}`,
    aabb: init.aabb,
    ref: 0,
  };
  if (init.volume !== undefined) fingerprint.volume = init.volume;
  return fingerprint;
}

const WHOLE = box([0, 0, 0], [6, 0.2, 3]);
const pieces = (volumes: (number | undefined)[]) =>
  volumes.map((volume, i) =>
    entity({ key: `P${i}`, aabb: box([i * 2, 0, 0], [(i + 1) * 2, 0.2, 3]), volume }),
  );

/** One diff with every relation in it: a renamed wall, a split, and a
 *  thickened wall the successor stage suggests. */
function everything() {
  const base = [
    entity({ key: 'R-OLD', dataHash: 'same', geometryHash: 'g-same', aabb: box([20, 0, 0], [26, 0.2, 3]) }),
    entity({ key: 'W', aabb: WHOLE, volume: 3.6 }),
    entity({ key: 'T-OLD', aabb: box([40, 0, 0], [46, 0.2, 3]) }),
  ];
  const head = [
    entity({ key: 'R-NEW', dataHash: 'same', geometryHash: 'g-same', aabb: box([20, 0, 0], [26, 0.2, 3]) }),
    ...pieces([1.2, 1.8, 0.6]),
    entity({ key: 'T-NEW', aabb: box([40, 0, 0], [46, 0.25, 3]) }),
  ];
  return diffModels(base, head, {
    matchUnpairedByContent: true,
    detectSplitMerge: true,
    detectSuccessors: true,
  });
}

describe('lineageFromDiff', () => {
  it('derives identity from committed matches, split from claims with shares, and replaced only from accepted successors', () => {
    const diff = everything();
    expect(diff.successors).toHaveLength(1);

    const withoutAcceptance = lineageFromDiff(diff);
    expect(withoutAcceptance.map((e) => e.relation)).toEqual(['identity', 'split']);

    const lineage = lineageFromDiff(diff, { accepted: diff.successors });
    expect(lineage).toEqual([
      { base: ['R-OLD'], head: ['R-NEW'], relation: 'identity', reason: 'content-match:renamed' },
      { base: ['T-OLD'], head: ['T-NEW'], relation: 'replaced', reason: 'successor:footprint' },
      {
        base: ['W'],
        head: ['P0', 'P1', 'P2'],
        relation: 'split',
        reason: 'split:verified',
        shares: [1.2 / 3.6, 1.8 / 3.6, 0.6 / 3.6],
      },
    ]);
  });

  it('lists the keys the diff left deleted with no lineage', () => {
    const diff = diffModels(
      [entity({ key: 'GONE', aabb: box([50, 0, 0], [51, 0.2, 3]) }), entity({ key: 'W', aabb: WHOLE, volume: 3.6 })],
      pieces([1.2, 1.2, 1.2]),
      { matchUnpairedByContent: true, detectSplitMerge: true },
    );
    const { entries, deleted } = lineageOfDiff(diff);
    expect(entries.map((e) => e.relation)).toEqual(['split']);
    expect(deleted).toEqual(['GONE']);
  });

  it('omits shares on an extent split (a volume was missing)', () => {
    const diff = diffModels([entity({ key: 'W', aabb: WHOLE })], pieces([1.2, 1.2, undefined]), {
      matchUnpairedByContent: true,
      detectSplitMerge: true,
    });
    const [split] = lineageFromDiff(diff);
    expect(split.relation).toBe('split');
    expect(split.reason).toBe('split:extent');
    expect(split.shares).toBeUndefined();
  });

  it('records a merge with shares per base key', () => {
    const diff = diffModels(pieces([1.2, 1.2, 1.2]), [entity({ key: 'W', aabb: WHOLE, volume: 3.6 })], {
      matchUnpairedByContent: true,
      detectSplitMerge: true,
    });
    const [merge] = lineageFromDiff(diff);
    expect(merge).toMatchObject({ relation: 'merge', head: ['W'], reason: 'merge:verified' });
    expect(merge.base).toHaveLength(3);
    expect(merge.shares).toHaveLength(3);
    for (const share of merge.shares!) expect(share).toBeCloseTo(1 / 3, 12);
  });

  it('carries applied aliases forward so a replayed lineage does not erode', () => {
    const base = [entity({ key: 'OLD', dataHash: 'same', geometryHash: 'g', aabb: WHOLE })];
    const head = [entity({ key: 'NEW', dataHash: 'same', geometryHash: 'g', aabb: WHOLE })];
    const first = diffModels(base, head, { matchUnpairedByContent: true });
    const lineage = lineageFromDiff(first);
    expect(lineage).toEqual([{ base: ['OLD'], head: ['NEW'], relation: 'identity', reason: 'content-match:renamed' }]);

    const aliases = keyAliasesFromLineage(lineage);
    expect(aliases).toEqual(new Map([['NEW', 'OLD']]));
    const second = diffModels(base, head, { matchUnpairedByContent: true, keyAliases: aliases });
    expect(second.contentMatches).toEqual([]);
    const reasons = new Map(lineage.map((e) => [e.head[0], e.reason]));
    expect(lineageFromDiff(second, { aliasReasons: reasons })).toEqual(lineage);
    expect(lineageFromDiff(second)[0].reason).toBe('alias:replayed');
  });

  it('classifies a replayed alias by reason PREFIX: successor: -> replaced, anything else -> identity', () => {
    const base = [entity({ key: 'OLD', aabb: WHOLE })];
    const head = [entity({ key: 'NEW', aabb: WHOLE })];
    const diff = diffModels(base, head, { keyAliases: new Map([['NEW', 'OLD']]) });
    expect(diff.appliedKeyAliases).toEqual(new Map([['NEW', 'OLD']]));

    const replaced = lineageFromDiff(diff, {
      aliasReasons: new Map([['NEW', 'successor:position']]),
    });
    expect(replaced).toEqual([
      { base: ['OLD'], head: ['NEW'], relation: 'replaced', reason: 'successor:position' },
    ]);

    const stillIdentity = lineageFromDiff(diff, {
      aliasReasons: new Map([['NEW', 'accepted:ambiguous']]),
    });
    expect(stillIdentity).toEqual([
      { base: ['OLD'], head: ['NEW'], relation: 'identity', reason: 'accepted:ambiguous' },
    ]);
  });

  it('preserves an incoming lineage relation even when its free-form reason suggests the opposite (#5005 review)', () => {
    const diff = diffModels(
      [entity({ key: 'OLD', aabb: WHOLE })],
      [entity({ key: 'NEW', aabb: WHOLE })],
      { keyAliases: new Map([['NEW', 'OLD']]) },
    );
    expect(lineageFromDiff(diff, {
      aliasReasons: new Map([['NEW', 'successor:hand-written']]),
      aliasRelations: new Map([['NEW', 'identity']]),
    })[0]).toMatchObject({ relation: 'identity', reason: 'successor:hand-written' });
    expect(lineageFromDiff(diff, {
      aliasReasons: new Map([['NEW', 'reviewed replacement']]),
      aliasRelations: new Map([['NEW', 'replaced']]),
    })[0]).toMatchObject({ relation: 'replaced', reason: 'reviewed replacement' });
  });

  it('round-trips a replaced entry through keyAliasesFromLineage -> diffModels -> lineageOfDiff, byte-identical', () => {
    const base = [entity({ key: 'OLD', aabb: WHOLE })];
    const head = [entity({ key: 'NEW', aabb: WHOLE })];
    const first: LineageEntry[] = [
      { base: ['OLD'], head: ['NEW'], relation: 'replaced', reason: 'successor:position' },
    ];
    const aliases = keyAliasesFromLineage(first);
    expect(aliases).toEqual(new Map([['NEW', 'OLD']]));

    const reasons = new Map(first.map((e) => [e.head[0], e.reason]));
    const replayed = diffModels(base, head, { keyAliases: aliases });
    const { entries: second } = lineageOfDiff(replayed, { aliasReasons: reasons });
    expect(second).toEqual(first);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });
});

describe('keyAliasesFromLineage', () => {
  it('aliases only 1:1 identity and replaced entries, and drops a contested here', () => {
    const entries: LineageEntry[] = [
      { base: ['a'], head: ['A'], relation: 'identity', reason: 'x' },
      { base: ['b'], head: ['B'], relation: 'replaced', reason: 'x' },
      { base: ['s'], head: ['S1', 'S2'], relation: 'split', reason: 'x' },
      { base: ['c'], head: ['C'], relation: 'identity', reason: 'x' },
      { base: ['d'], head: ['C'], relation: 'identity', reason: 'x' },
      { base: ['e'], head: ['e'], relation: 'identity', reason: 'x' },
    ];
    expect(keyAliasesFromLineage(entries)).toEqual(new Map([['A', 'a'], ['B', 'b']]));
  });
});

describe('rekeyByLineage', () => {
  const lineage: LineageEntry[] = [
    { base: ['w'], head: ['p0', 'p1', 'p2'], relation: 'split', reason: 'split:verified', shares: [0.5, 0.3, 0.2] },
    { base: ['u'], head: ['u0', 'u1'], relation: 'split', reason: 'split:extent' },
    { base: ['t'], head: ['t0', 't1'], relation: 'split', reason: 'split:verified', shares: [0.5, 0.5] },
    { base: ['m0', 'm1'], head: ['m'], relation: 'merge', reason: 'merge:verified' },
    { base: ['r'], head: ['R'], relation: 'replaced', reason: 'successor:footprint' },
  ];

  it('copy-to-all copies a split row to every piece', () => {
    expect(rekeyByLineage(['w', 'u'], lineage, 'copy-to-all')).toEqual([
      { key: 'w', successors: ['p0', 'p1', 'p2'], relation: 'split', orphan: false },
      { key: 'u', successors: ['u0', 'u1'], relation: 'split', orphan: false },
    ]);
  });

  it('largest-share follows the biggest piece, orphans without shares, and abstains on a tie', () => {
    expect(rekeyByLineage(['w', 'u', 't'], lineage, 'largest-share')).toEqual([
      { key: 'w', successors: ['p0'], relation: 'split', orphan: false },
      { key: 'u', successors: [], relation: 'split', orphan: true },
      { key: 't', successors: [], relation: 'split', orphan: true },
    ]);
  });

  it('orphan-on-split orphans every split; merges and replacements rekey under any policy', () => {
    expect(rekeyByLineage(['w', 'm0', 'm1', 'r'], lineage, 'orphan-on-split')).toEqual([
      { key: 'w', successors: [], relation: 'split', orphan: true },
      { key: 'm0', successors: ['m'], relation: 'merge', orphan: false },
      { key: 'm1', successors: ['m'], relation: 'merge', orphan: false },
      { key: 'r', successors: ['R'], relation: 'replaced', orphan: false },
    ]);
  });

  it('passes a key with no lineage through unchanged, unless the deleted list names it (review on #4967)', () => {
    // A lineage records CHANGES: a cost table full of unchanged GlobalIds must
    // not be orphaned wholesale. Only the deleted list can single out a row
    // whose element is gone.
    expect(rekeyByLineage(['same', 'gone'], { entries: lineage, deleted: ['gone'] })).toEqual([
      { key: 'same', successors: ['same'], relation: 'unchanged', orphan: false },
      { key: 'gone', successors: [], orphan: true },
    ]);
    // Bare entries (no deleted list): nothing can be told apart, so nothing is lost.
    expect(rekeyByLineage(['same'], lineage)).toEqual([
      { key: 'same', successors: ['same'], relation: 'unchanged', orphan: false },
    ]);
  });
});

describe('lineage sidecar', () => {
  const models = { base: { hash: 'sha256:aaa', path: 'v1.ifc' }, head: { hash: 'sha256:bbb' } };
  const entries: LineageEntry[] = [
    { base: ['w'], head: ['p1', 'p0'], relation: 'split', reason: 'split:verified', shares: [0.6, 0.4] },
    { base: ['a'], head: ['A'], relation: 'identity', reason: 'content-match:renamed' },
  ];

  it('round-trips, sorted and byte-stable, with the key scheme pinned and the deleted list sorted', () => {
    const sidecar = createLineageSidecar({ ...models, entries, keyProperty: 'Pset_Asset.AssetId', deleted: ['z', 'y', 'z'] });
    expect(sidecar.version).toBe(2);
    expect(sidecar.entries.map((e) => e.base[0])).toEqual(['a', 'w']);
    expect(sidecar.deleted).toEqual(['y', 'z']);
    const text = serializeLineageSidecar(sidecar);
    expect(serializeLineageSidecar(createLineageSidecar({ ...models, entries: [...entries].reverse(), keyProperty: 'Pset_Asset.AssetId', deleted: ['y', 'z'] }))).toBe(text);
    expect(parseLineageSidecar(text)).toEqual(sidecar);
    expect(() => parseLineageSidecar(text.replace('"version": 2', '"version": 1'))).toThrow(/requires keyProperty/);
    const plain = createLineageSidecar({ ...models, entries });
    expect(plain.version).toBe(1);
    expect(() => parseLineageSidecar(serializeLineageSidecar(plain).replace('"version": 1', '"version": 2'))).toThrow(/requires keyProperty/);
    expect(text.endsWith('\n')).toBe(true);
  });

  it('refuses a key on two entries of one side, at create and at parse', () => {
    const conflicting: LineageEntry[] = [
      ...entries,
      { base: ['w'], head: ['q'], relation: 'replaced', reason: 'successor:position' },
    ];
    expect(lineageConflicts(conflicting)).toEqual(['base key "w" appears in more than one lineage entry']);
    expect(() => createLineageSidecar({ ...models, entries: conflicting })).toThrow(/appears in more than one/);
    const text = serializeLineageSidecar(createLineageSidecar({ ...models, entries })).replace(
      '"entries": [',
      '"entries": [{"base":["A"],"head":["A"],"relation":"identity","reason":"self"},',
    );
    expect(() => parseLineageSidecar(text)).toThrow(/head key "A" appears in more than one/);
  });

  it('refuses malformed entries, wrong arity, and bad shares', () => {
    const bad = (entry: unknown) =>
      createLineageSidecar({ ...models, entries: [entry as LineageEntry] });
    expect(() => bad({ base: ['a', 'b'], head: ['c'], relation: 'identity', reason: 'x' })).toThrow(/must be 1:1/);
    expect(() => bad({ base: ['a', 'b'], head: ['c', 'd'], relation: 'split', reason: 'x' })).toThrow(/exactly one base/);
    expect(() => bad({ base: ['a'], head: ['c', 'd'], relation: 'split', reason: 'x', shares: [1] })).toThrow(/shares/);
    expect(() => bad({ base: ['a'], head: ['c'], relation: 'teleported', reason: 'x' })).toThrow(/relation/);
    expect(() => bad({ base: [], head: ['c'], relation: 'identity', reason: 'x' })).toThrow(/at least one key/);
    expect(() => createLineageSidecar({ ...models, entries, deleted: ['w'] })).toThrow(/deleted key "w" also appears/);
    expect(() => parseLineageSidecar('{')).toThrow(/not JSON/);
    expect(() => parseLineageSidecar('{"format":"ifc-lite/lineage","version":2}')).toThrow(/version/);
  });

  it('reports digest and key-scheme mismatches', () => {
    const sidecar = createLineageSidecar({ ...models, entries });
    expect(lineageSidecarMismatches(sidecar, models)).toEqual([]);
    expect(lineageSidecarMismatches(sidecar, { ...models, head: { hash: 'sha256:ccc' } })).toEqual([
      'head model does not match the lineage (lineage sha256:bbb, got sha256:ccc)',
    ]);
    expect(lineageSidecarMismatches(sidecar, { ...models, keyProperty: 'Tag' })).toEqual([
      'key scheme does not match the lineage (lineage GlobalId, got Tag)',
    ]);
  });
});
