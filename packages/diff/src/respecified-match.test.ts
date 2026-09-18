/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The geometry-only stage of content matching (issue #4955): an element
 * deleted and redrawn in the same place with the same shape, whose data
 * changed because the authoring tool auto-renamed it. Tier 1 cannot see it
 * (different data, different bucket); this stage buckets by world geometry.
 */

import { describe, expect, it } from 'vitest';
import { diffModels } from './diff.js';
import { buildComponentFingerprints, buildDataFingerprint } from './fingerprint.js';
import { identityMapFromContentMatches } from './identity-map.js';
import type { EntityAabb, EntityFingerprint } from './types.js';

function box(
  [x, y, z]: [number, number, number],
  size: [number, number, number] = [3, 0.2, 2.8],
): EntityAabb {
  return {
    min: [x - size[0] / 2, y - size[1] / 2, z - size[2] / 2],
    max: [x + size[0] / 2, y + size[1] / 2, z + size[2] / 2],
  };
}

/** A wall with an authored name, hashed the way an adapter would hash it. */
function wall(
  key: string,
  name: string,
  opts: { geometryHash?: string; aabb?: EntityAabb; ifcType?: string; width?: number } = {},
): EntityFingerprint<string> {
  const input = {
    ifcType: opts.ifcType ?? 'IfcWall',
    name,
    propertySets: [{ name: 'Pset_WallCommon', properties: [{ name: 'IsExternal', value: true }] }],
    quantitySets: [
      { name: 'Qto_WallBaseQuantities', quantities: [{ name: 'Width', value: opts.width ?? 0.2 }] },
    ],
  };
  const fingerprint: EntityFingerprint<string> = {
    key,
    ifcType: input.ifcType,
    dataHash: buildDataFingerprint(input),
    components: buildComponentFingerprints(input),
    ref: key,
  };
  if (opts.geometryHash !== undefined) fingerprint.geometryHash = opts.geometryHash;
  if (opts.aabb) fingerprint.aabb = opts.aabb;
  return fingerprint;
}

const AT_ORIGIN = box([0, 0, 1.4]);

describe('respecified: same world geometry, different data (issue #4955)', () => {
  it('pairs a redrawn, auto-renamed wall in the same place and retires the add/delete', () => {
    const base = [wall('OLD', 'Wall-023', { geometryHash: 'g-wall', aabb: AT_ORIGIN })];
    const head = [wall('NEW', 'Wall-041', { geometryHash: 'g-wall', aabb: AT_ORIGIN })];

    const diff = diffModels(base, head, { matchUnpairedByContent: true });

    expect(diff.counts).toEqual({ added: 0, modified: 0, deleted: 0, unchanged: 0 });
    expect(diff.entries).toEqual([]);
    expect(diff.contentMatches).toHaveLength(1);
    const match = diff.contentMatches![0];
    expect(match.kind).toBe('respecified');
    expect(match.tier).toBe('geometry-only');
    expect(match.geometryHash).toBe('g-wall');
    expect(match.dataHash).toBe(head[0].dataHash);
    expect(match.base.map((e) => e.key)).toEqual(['OLD']);
    expect(match.head.map((e) => e.key)).toEqual(['NEW']);
    // Only the Name moved, which lives in the core attributes slice.
    expect(match.changedComponents).toEqual(['attr:core']);
  });

  it('reports every data slice that changed, not only the name', () => {
    const base = [wall('OLD', 'Wall-023', { geometryHash: 'g', aabb: AT_ORIGIN, width: 0.2 })];
    const head = [wall('NEW', 'Wall-041', { geometryHash: 'g', aabb: AT_ORIGIN, width: 0.25 })];
    const diff = diffModels(base, head, { matchUnpairedByContent: true });
    expect(diff.contentMatches![0].changedComponents).toEqual([
      'attr:core',
      'qset:Qto_WallBaseQuantities',
    ]);
  });

  it('mints an identity-map entry with its own reason', () => {
    const base = [wall('OLD', 'Wall-023', { geometryHash: 'g', aabb: AT_ORIGIN })];
    const head = [wall('NEW', 'Wall-041', { geometryHash: 'g', aabb: AT_ORIGIN })];
    const diff = diffModels(base, head, { matchUnpairedByContent: true });
    expect(identityMapFromContentMatches(diff.contentMatches)).toEqual([
      { base: 'OLD', here: 'NEW', reason: 'content-match:respecified' },
    ]);
  });

  it('runs before the positional tier, so a moved same-data neighbour cannot steal the pair', () => {
    // Base: D1 (data A at P), D2 (data A, 3 m away). Head: D1' (data B at P,
    // the respecified one), D2' (data A, moved 0.5 m toward P). Bucketed by
    // data alone, D2' is D1's unique nearest and tier 3 would retire D1↔D2'
    // as `moved`, stranding D1'. The geometry-only stage runs first.
    const door = (key: string, name: string, x: number, geometryHash: string) =>
      wall(key, name, { ifcType: 'IfcDoor', geometryHash, aabb: box([x, 0, 1], [1, 0.1, 2]) });
    const base = [door('D1', 'Door', 0, 'g@0'), door('D2', 'Door', 3, 'g@3')];
    const head = [door('D1p', 'Door (renamed)', 0, 'g@0'), door('D2p', 'Door', 2.5, 'g@2.5')];

    const diff = diffModels(base, head, { matchUnpairedByContent: true });

    const byKind = new Map(diff.contentMatches!.map((m) => [m.kind, m]));
    expect(byKind.get('respecified')!.base[0].key).toBe('D1');
    expect(byKind.get('respecified')!.head[0].key).toBe('D1p');
    expect(byKind.get('moved')!.base[0].key).toBe('D2');
    expect(byKind.get('moved')!.head[0].key).toBe('D2p');
    expect(diff.counts).toEqual({ added: 0, modified: 0, deleted: 0, unchanged: 0 });
  });

  it('reports stacked duplicates (N:N with different data) as an ambiguous group and retires nothing', () => {
    const base = [
      wall('OLD-1', 'Wall-1', { geometryHash: 'g', aabb: AT_ORIGIN }),
      wall('OLD-2', 'Wall-2', { geometryHash: 'g', aabb: AT_ORIGIN }),
    ];
    const head = [
      wall('NEW-1', 'Wall-3', { geometryHash: 'g', aabb: AT_ORIGIN }),
      wall('NEW-2', 'Wall-4', { geometryHash: 'g', aabb: AT_ORIGIN }),
    ];
    const diff = diffModels(base, head, { matchUnpairedByContent: true });
    expect(diff.counts).toEqual({ added: 2, modified: 0, deleted: 2, unchanged: 0 });
    const groups = diff.contentMatches!.filter((m) => m.tier === 'unresolved');
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ kind: 'ambiguous', dataHash: '', geometryHash: 'g' });
    expect(groups[0].base.map((e) => e.key).sort()).toEqual(['OLD-1', 'OLD-2']);
  });

  it('abstains on a pair tier 1 already refused as a data-hash collision', () => {
    // Same ifcType, same geometry, same box, same dataHash — but the component
    // sub-hashes disagree, which proves the data hash collided. Tier 1 refuses
    // that pair; the geometry-only step must not retire it as respecified on
    // the strength of the geometry alone (PR review on #4963).
    const base = wall('OLD', 'Wall-023', { geometryHash: 'g', aabb: AT_ORIGIN });
    const head = wall('NEW', 'Wall-041', { geometryHash: 'g', aabb: AT_ORIGIN });
    head.dataHash = base.dataHash; // forced collision
    const diff = diffModels([base], [head], { matchUnpairedByContent: true });
    expect(diff.counts).toEqual({ added: 1, modified: 0, deleted: 1, unchanged: 0 });
    expect(diff.contentMatches).toEqual([]);
  });

  it('does not list a geometry-group member as unresolved once a later tier retired it', () => {
    // Two stacked walls per side share one geometry bucket 2:2 with distinct
    // data, so phase 2 reports them as a group. But OLD-2's data also matches
    // NEW-X, a same-data wall that moved elsewhere, and tier 2 retires that
    // pair as `moved`. The reported group must then hold OLD-1 against
    // NEW-1/NEW-2 only (PR review on #4963): an entity is never both resolved
    // and unresolved.
    const base = [
      wall('OLD-1', 'Wall-A', { geometryHash: 'g', aabb: AT_ORIGIN }),
      wall('OLD-2', 'Wall-B', { geometryHash: 'g', aabb: AT_ORIGIN }),
    ];
    const head = [
      wall('NEW-1', 'Wall-C', { geometryHash: 'g', aabb: AT_ORIGIN }),
      wall('NEW-2', 'Wall-D', { geometryHash: 'g', aabb: AT_ORIGIN }),
      wall('NEW-X', 'Wall-B', { geometryHash: 'g@far', aabb: box([20, 0, 1.4]) }),
    ];
    const diff = diffModels(base, head, { matchUnpairedByContent: true });
    const moved = diff.contentMatches!.filter((m) => m.kind === 'moved');
    expect(moved.map((m) => [m.base[0].key, m.head[0].key])).toEqual([['OLD-2', 'NEW-X']]);
    const groups = diff.contentMatches!.filter((m) => m.tier === 'unresolved');
    expect(groups).toHaveLength(1);
    expect(groups[0].base.map((e) => e.key)).toEqual(['OLD-1']);
    expect(groups[0].head.map((e) => e.key).sort()).toEqual(['NEW-1', 'NEW-2']);
    expect(groups[0].kind).toBe('duplicated');
    expect(diff.counts).toEqual({ added: 2, modified: 0, deleted: 1, unchanged: 0 });
  });

  it('never pairs across IFC classes, even on an identical body', () => {
    // A wall republished as a building-element part with the wall's exact
    // geometry is not the same element.
    const base = [wall('WALL', 'Wall-023', { geometryHash: 'g', aabb: AT_ORIGIN })];
    const head = [
      wall('PART', 'Layer 1', { ifcType: 'IfcBuildingElementPart', geometryHash: 'g', aabb: AT_ORIGIN }),
    ];
    const diff = diffModels(base, head, { matchUnpairedByContent: true });
    expect(diff.counts).toEqual({ added: 1, modified: 0, deleted: 1, unchanged: 0 });
    expect(diff.contentMatches).toEqual([]);
  });

  it('requires a usable bounding box on both sides (placement-only fingerprints never pair)', () => {
    // The viewer writes a placement string into `geometryHash` for a
    // geometry-less product, with no box. Two placeholder proxies at the
    // origin share it and always differ in data.
    const base = [wall('P1', 'Proxy A', { ifcType: 'IfcBuildingElementProxy', geometryHash: 'placement@0,0,0' })];
    const head = [wall('P2', 'Proxy B', { ifcType: 'IfcBuildingElementProxy', geometryHash: 'placement@0,0,0' })];
    const diff = diffModels(base, head, { matchUnpairedByContent: true });
    expect(diff.counts).toEqual({ added: 1, modified: 0, deleted: 1, unchanged: 0 });
    expect(diff.contentMatches).toEqual([]);
  });

  it('refuses a hash collision whose boxes disagree', () => {
    const base = [wall('OLD', 'Wall-023', { geometryHash: 'g', aabb: AT_ORIGIN })];
    const head = [wall('NEW', 'Wall-041', { geometryHash: 'g', aabb: box([5, 0, 1.4]) })];
    const diff = diffModels(base, head, { matchUnpairedByContent: true });
    expect(diff.counts).toEqual({ added: 1, modified: 0, deleted: 1, unchanged: 0 });
    expect(diff.contentMatches).toEqual([]);
  });

  it('tolerates sub-millimetre box jitter between two meshings of the same surface', () => {
    const jittered: EntityAabb = {
      min: [AT_ORIGIN.min[0] + 1e-5, AT_ORIGIN.min[1], AT_ORIGIN.min[2] - 1e-5],
      max: [AT_ORIGIN.max[0], AT_ORIGIN.max[1] + 1e-5, AT_ORIGIN.max[2]],
    };
    const base = [wall('OLD', 'Wall-023', { geometryHash: 'g', aabb: AT_ORIGIN })];
    const head = [wall('NEW', 'Wall-041', { geometryHash: 'g', aabb: jittered })];
    const diff = diffModels(base, head, { matchUnpairedByContent: true });
    expect(diff.contentMatches![0].kind).toBe('respecified');
  });

  it('leaves the respecified pair out of the split/merge input', () => {
    // A redrawn wall plus a genuinely new same-class piece inside its box: the
    // wall must be retired here so the detector does not see a "split".
    const base = [wall('OLD', 'Wall-023', { geometryHash: 'g', aabb: AT_ORIGIN })];
    const head = [
      wall('NEW', 'Wall-041', { geometryHash: 'g', aabb: AT_ORIGIN }),
      wall('PIECE', 'Wall-042', { geometryHash: 'g2', aabb: box([0, 0, 1.4], [1, 0.2, 2.8]) }),
    ];
    const diff = diffModels(base, head, { matchUnpairedByContent: true, detectSplitMerge: true });
    expect(diff.contentMatches![0].kind).toBe('respecified');
    expect(diff.counts).toEqual({ added: 1, modified: 0, deleted: 0, unchanged: 0 });
    expect(diff.splitMerges).toEqual([]);
  });

  describe('abstentions', () => {
    const base = [wall('OLD', 'Wall-023', { geometryHash: 'g', aabb: AT_ORIGIN })];
    const head = [wall('NEW', 'Wall-041', { geometryHash: 'g', aabb: AT_ORIGIN })];

    it("does not run under scope 'data'", () => {
      const diff = diffModels(base, head, { matchUnpairedByContent: true, scope: 'data' });
      expect(diff.counts).toEqual({ added: 1, modified: 0, deleted: 1, unchanged: 0 });
      expect(diff.contentMatches).toEqual([]);
    });

    it('does not run when one revision carries no geometry hashes at all', () => {
      const bare = [wall('NEW', 'Wall-041', { aabb: AT_ORIGIN })];
      const diff = diffModels(base, bare, { matchUnpairedByContent: true });
      expect(diff.counts).toEqual({ added: 1, modified: 0, deleted: 1, unchanged: 0 });
      expect(diff.contentMatches).toEqual([]);
    });

    it('does not run at all without matchUnpairedByContent', () => {
      const diff = diffModels(base, head);
      expect(diff.counts).toEqual({ added: 1, modified: 0, deleted: 1, unchanged: 0 });
      expect(diff.contentMatches).toBeUndefined();
    });
  });
});
