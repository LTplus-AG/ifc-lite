/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The decision matrix of 05 §5.3 as golden fixtures, plus a seeded
 * partition fuzz: random op partitions over a model must never lose ops.
 */

import { describe, expect, it } from 'vitest';
import type { IfcxFile, IfcxNode } from '@ifc-lite/ifcx';
import { IFCLITE_ATTR } from '@ifc-lite/ifcx';
import { planThreeWayMerge } from './three-way.js';
import { applyResolutions, opsToNodes } from './merge-layer.js';
import { extractStackState, componentEntries, snapshotOf } from './component-state.js';
import type { MergeOp } from './types.js';

export function makeLayer(data: IfcxNode[], id = 'layer'): IfcxFile {
  return {
    header: {
      id,
      ifcxVersion: 'ifcx_alpha',
      dataVersion: '1.0.0',
      author: 'test',
      timestamp: '2026-06-09T00:00:00Z',
    },
    imports: [],
    schemas: {},
    data,
  };
}

const FIRE = 'bsi::ifc::v5a::Pset_FireSafety::FireRating';
const EXTERNAL = 'bsi::ifc::v5a::Pset_WallCommon::IsExternal';
const PLACEMENT = 'usd::xformop';

const base = makeLayer(
  [
    {
      path: 'storey-eg',
      children: { Wall: 'wall-1' },
      attributes: { 'bsi::ifc::class': { code: 'IfcBuildingStorey', uri: 'u' } },
    },
    {
      path: 'wall-1',
      attributes: {
        'bsi::ifc::class': { code: 'IfcWall', uri: 'u' },
        [FIRE]: 'REI60',
        [EXTERNAL]: true,
        [PLACEMENT]: { transform: [[1, 0, 0, 0]] },
      },
    },
  ],
  'base'
);

function layer(nodes: IfcxNode[], id = 'delta'): IfcxFile {
  return makeLayer(nodes, id);
}

/** Compose merge result = ours + merge ops, compare component states. */
function stateAfterMerge(ours: IfcxFile[], ops: MergeOp[]) {
  return extractStackState([...ours, layer(opsToNodes(ops), 'merge')]);
}

describe('three-way decision matrix', () => {
  it('unchanged vs changed → take theirs (auto)', () => {
    const theirs = layer([{ path: 'wall-1', attributes: { [FIRE]: 'REI90' } }]);
    const plan = planThreeWayMerge({ ancestor: [base], ours: [base], theirs: [base, theirs] });
    expect(plan.conflicts).toEqual([]);
    expect(plan.autoOps).toEqual([
      {
        op: 'set-component',
        path: 'wall-1',
        componentKey: 'pset:Pset_FireSafety',
        attributes: { [FIRE]: 'REI90' },
      },
    ]);
  });

  it('changed vs unchanged → keep ours (auto, no op)', () => {
    const ours = layer([{ path: 'wall-1', attributes: { [FIRE]: 'REI90' } }]);
    const plan = planThreeWayMerge({ ancestor: [base], ours: [base, ours], theirs: [base] });
    expect(plan.conflicts).toEqual([]);
    expect(plan.autoOps).toEqual([]);
  });

  it('changed vs changed with equal value → fold (auto)', () => {
    const sameEdit: IfcxNode[] = [{ path: 'wall-1', attributes: { [FIRE]: 'REI90' } }];
    const plan = planThreeWayMerge({
      ancestor: [base],
      ours: [base, layer(sameEdit, 'ours')],
      theirs: [base, layer(sameEdit, 'theirs')],
    });
    expect(plan.conflicts).toEqual([]);
    expect(plan.autoOps).toEqual([]);
  });

  it('changed vs changed, different → conflict: concurrent-edit', () => {
    const plan = planThreeWayMerge({
      ancestor: [base],
      ours: [base, layer([{ path: 'wall-1', attributes: { [FIRE]: 'REI90' } }], 'ours')],
      theirs: [base, layer([{ path: 'wall-1', attributes: { [FIRE]: 'REI120' } }], 'theirs')],
    });
    expect(plan.autoOps).toEqual([]);
    expect(plan.conflicts).toHaveLength(1);
    const conflict = plan.conflicts[0];
    expect(conflict.kind).toBe('concurrent-edit');
    expect(conflict.path).toBe('wall-1');
    expect(conflict.componentKey).toBe('pset:Pset_FireSafety');
    expect(conflict.ours?.attributes).toEqual({ [FIRE]: 'REI90' });
    expect(conflict.theirs?.attributes).toEqual({ [FIRE]: 'REI120' });
    expect(conflict.base?.attributes).toEqual({ [FIRE]: 'REI60' });
  });

  it('different components on the same entity are NOT a conflict', () => {
    // Architect edits placement, agent edits Pset_FireSafety: both land.
    const plan = planThreeWayMerge({
      ancestor: [base],
      ours: [base, layer([{ path: 'wall-1', attributes: { [PLACEMENT]: { transform: [[2, 0, 0, 0]] } } }], 'ours')],
      theirs: [base, layer([{ path: 'wall-1', attributes: { [FIRE]: 'REI90' } }], 'theirs')],
    });
    expect(plan.conflicts).toEqual([]);
    expect(plan.autoOps).toHaveLength(1);
    const merged = stateAfterMerge([base, layer([{ path: 'wall-1', attributes: { [PLACEMENT]: { transform: [[2, 0, 0, 0]] } } }], 'ours')], plan.autoOps);
    const wall = merged.get('wall-1');
    expect(wall?.components.get('pset:Pset_FireSafety')).toEqual({ [FIRE]: 'REI90' });
    expect(wall?.components.get('placement')).toEqual({ [PLACEMENT]: { transform: [[2, 0, 0, 0]] } });
  });

  it('tombstoned vs changed → conflict: delete-vs-modify', () => {
    const plan = planThreeWayMerge({
      ancestor: [base],
      ours: [base, layer([{ path: 'wall-1', attributes: { [IFCLITE_ATTR.DELETED]: true } }], 'ours')],
      theirs: [base, layer([{ path: 'wall-1', attributes: { [FIRE]: 'REI90' } }], 'theirs')],
    });
    expect(plan.autoOps).toEqual([]);
    expect(plan.conflicts).toHaveLength(1);
    expect(plan.conflicts[0].kind).toBe('delete-vs-modify');
  });

  it('changed vs tombstoned → conflict: modify-vs-delete', () => {
    const plan = planThreeWayMerge({
      ancestor: [base],
      ours: [base, layer([{ path: 'wall-1', attributes: { [FIRE]: 'REI90' } }], 'ours')],
      theirs: [base, layer([{ path: 'wall-1', attributes: { [IFCLITE_ATTR.DELETED]: true } }], 'theirs')],
    });
    expect(plan.conflicts).toHaveLength(1);
    expect(plan.conflicts[0].kind).toBe('modify-vs-delete');
  });

  it('tombstoned vs tombstoned → fold (auto)', () => {
    const del: IfcxNode[] = [{ path: 'wall-1', attributes: { [IFCLITE_ATTR.DELETED]: true } }];
    const plan = planThreeWayMerge({
      ancestor: [base],
      ours: [base, layer(del, 'ours')],
      theirs: [base, layer(del, 'theirs')],
    });
    expect(plan.conflicts).toEqual([]);
    expect(plan.autoOps).toEqual([]);
  });

  it('untouched delete on theirs → tombstone-entity auto op', () => {
    const plan = planThreeWayMerge({
      ancestor: [base],
      ours: [base],
      theirs: [base, layer([{ path: 'wall-1', attributes: { [IFCLITE_ATTR.DELETED]: true } }], 'theirs')],
    });
    expect(plan.conflicts).toEqual([]);
    expect(plan.autoOps).toEqual([{ op: 'tombstone-entity', path: 'wall-1' }]);
  });

  it('entity added by theirs → set-component ops for every component', () => {
    const plan = planThreeWayMerge({
      ancestor: [base],
      ours: [base],
      theirs: [
        base,
        layer([{ path: 'door-1', attributes: { 'bsi::ifc::class': { code: 'IfcDoor', uri: 'u' } } }], 'theirs'),
      ],
    });
    expect(plan.conflicts).toEqual([]);
    expect(plan.autoOps).toEqual([
      {
        op: 'set-component',
        path: 'door-1',
        componentKey: 'attr:class',
        attributes: { 'bsi::ifc::class': { code: 'IfcDoor', uri: 'u' } },
      },
    ]);
  });

  it('reparenting vs concurrent reparenting → conflict: hierarchy', () => {
    const withStoreys = makeLayer(
      [
        ...base.data,
        { path: 'storey-og', attributes: { 'bsi::ifc::class': { code: 'IfcBuildingStorey', uri: 'u' } } },
        { path: 'storey-ug', attributes: { 'bsi::ifc::class': { code: 'IfcBuildingStorey', uri: 'u' } } },
      ],
      'base'
    );
    const plan = planThreeWayMerge({
      ancestor: [withStoreys],
      ours: [withStoreys, layer([{ path: 'storey-eg', children: { Wall: 'wall-2' } }], 'ours')],
      theirs: [withStoreys, layer([{ path: 'storey-eg', children: { Wall: 'wall-3' } }], 'theirs')],
    });
    expect(plan.conflicts).toHaveLength(1);
    expect(plan.conflicts[0].kind).toBe('hierarchy');
    expect(plan.conflicts[0].componentKey).toBe('child:Wall');
  });

  it('a parent tombstone shadows descendants: editing a child of a deleted parent conflicts', () => {
    // Theirs deletes the storey (whose subtree contains wall-1); ours
    // edits the wall. Composition would remove the wall with its parent,
    // so this must surface as modify-vs-delete — on the tombstoned ROOT,
    // carrying the touched descendant: a per-child decision against a
    // dead ancestor would be unsatisfiable (subtree shadowing beats a
    // child resurrect), so the delete decision lives on the storey.
    const plan = planThreeWayMerge({
      ancestor: [base],
      ours: [base, layer([{ path: 'wall-1', attributes: { [FIRE]: 'REI90' } }], 'ours')],
      theirs: [base, layer([{ path: 'storey-eg', attributes: { [IFCLITE_ATTR.DELETED]: true } }], 'theirs')],
    });
    expect(plan.conflicts).toHaveLength(1);
    expect(plan.conflicts[0]).toMatchObject({
      kind: 'modify-vs-delete',
      path: 'storey-eg',
      subtree: ['wall-1'],
    });
    // The storey's tombstone must not also ride along as an auto op.
    expect(plan.autoOps).not.toContainEqual({ op: 'tombstone-entity', path: 'storey-eg' });
  });

  it('deleting a parent while the other side leaves the subtree alone folds cleanly', () => {
    const plan = planThreeWayMerge({
      ancestor: [base],
      ours: [base],
      theirs: [base, layer([{ path: 'storey-eg', attributes: { [IFCLITE_ATTR.DELETED]: true } }], 'theirs')],
    });
    expect(plan.conflicts).toEqual([]);
    expect(plan.autoOps).toContainEqual({ op: 'tombstone-entity', path: 'storey-eg' });
    // The child's death is shadow-derived: no own op — the parent's
    // tombstone carries the subtree at composition time, so the composed
    // state still sees the child as deleted (and a child the target
    // reparented away would correctly survive).
    expect(plan.autoOps).not.toContainEqual({ op: 'tombstone-entity', path: 'wall-1' });
    const merged = stateAfterMerge([base], plan.autoOps);
    expect(merged.get('wall-1')?.deleted).toBe(true);
  });

  it('inherits changes flow through the plan as set-inherit ops', () => {
    const withType = makeLayer(
      [...base.data, { path: 'wall-type-1', attributes: { 'bsi::ifc::class': { code: 'IfcWallType', uri: 'u' } } }],
      'base'
    );
    const plan = planThreeWayMerge({
      ancestor: [withType],
      ours: [withType],
      theirs: [withType, layer([{ path: 'wall-1', inherits: { Type: 'wall-type-1' } }], 'theirs')],
    });
    expect(plan.conflicts).toEqual([]);
    expect(plan.autoOps).toEqual([
      { op: 'set-inherit', path: 'wall-1', name: 'Type', target: 'wall-type-1' },
    ]);
    // Round trip: serialized as an inherits opinion and re-extracted.
    const merged = stateAfterMerge([withType], plan.autoOps);
    expect(merged.get('wall-1')?.inherits.get('Type')).toBe('wall-type-1');
  });

  it('divergent inherits retargeting is a hierarchy conflict', () => {
    const withTypes = makeLayer(
      [
        ...base.data,
        { path: 'wall-1b', inherits: { Type: 'type-a' }, attributes: { [FIRE]: 'x' } },
        { path: 'type-a', attributes: { 'bsi::ifc::class': { code: 'IfcWallType', uri: 'u' } } },
        { path: 'type-b', attributes: { 'bsi::ifc::class': { code: 'IfcWallType', uri: 'u' } } },
        { path: 'type-c', attributes: { 'bsi::ifc::class': { code: 'IfcWallType', uri: 'u' } } },
      ],
      'base'
    );
    const plan = planThreeWayMerge({
      ancestor: [withTypes],
      ours: [withTypes, layer([{ path: 'wall-1b', inherits: { Type: 'type-b' } }], 'ours')],
      theirs: [withTypes, layer([{ path: 'wall-1b', inherits: { Type: 'type-c' } }], 'theirs')],
    });
    expect(plan.conflicts).toHaveLength(1);
    expect(plan.conflicts[0].kind).toBe('hierarchy');
    expect(plan.conflicts[0].componentKey).toBe('inherit:Type');
  });

  it('fast path: candidate based on the ref state merges without conflicts', () => {
    const candidate = layer([{ path: 'wall-1', attributes: { [FIRE]: 'REI90' } }], 'candidate');
    const plan = planThreeWayMerge({ ancestor: [base], ours: [base], theirs: [base, candidate] });
    expect(plan.conflicts).toEqual([]);
  });
});

describe('partition fuzz: random op partitions never lose ops', () => {
  // Deterministic LCG so failures reproduce.
  function lcg(seed: number) {
    let s = seed;
    return () => {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 0xffffffff;
    };
  }

  it('disjoint random partitions auto-merge to the union of both edits', () => {
    for (const seed of [1, 7, 42]) {
      const rand = lcg(seed);
      const entityCount = 30;
      const nodes: IfcxNode[] = [];
      for (let i = 0; i < entityCount; i++) {
        nodes.push({
          path: `entity-${i}`,
          attributes: { 'bsi::ifc::class': { code: 'IfcWall', uri: 'u' }, [FIRE]: 'REI60' },
        });
      }
      const fuzzBase = makeLayer(nodes, 'fuzz-base');

      // Partition entities between ours/theirs; each side edits its own.
      const oursNodes: IfcxNode[] = [];
      const theirsNodes: IfcxNode[] = [];
      const expectations = new Map<string, 'ours' | 'theirs' | 'none'>();
      for (let i = 0; i < entityCount; i++) {
        const roll = rand();
        if (roll < 0.4) {
          oursNodes.push({ path: `entity-${i}`, attributes: { [FIRE]: `OURS-${i}` } });
          expectations.set(`entity-${i}`, 'ours');
        } else if (roll < 0.8) {
          theirsNodes.push({ path: `entity-${i}`, attributes: { [FIRE]: `THEIRS-${i}` } });
          expectations.set(`entity-${i}`, 'theirs');
        } else {
          expectations.set(`entity-${i}`, 'none');
        }
      }

      const ours = [fuzzBase, layer(oursNodes, 'ours')];
      const plan = planThreeWayMerge({
        ancestor: [fuzzBase],
        ours,
        theirs: [fuzzBase, layer(theirsNodes, 'theirs')],
      });
      expect(plan.conflicts).toEqual([]);

      const merged = stateAfterMerge(ours, plan.autoOps);
      for (const [path, expectation] of expectations) {
        const entity = merged.get(path);
        expect(entity).toBeDefined();
        const value = entity?.components.get('pset:Pset_FireSafety')?.[FIRE];
        const index = path.split('-')[1];
        if (expectation === 'ours') expect(value).toBe(`OURS-${index}`);
        else if (expectation === 'theirs') expect(value).toBe(`THEIRS-${index}`);
        else expect(value).toBe('REI60');
      }
    }
  });
});
