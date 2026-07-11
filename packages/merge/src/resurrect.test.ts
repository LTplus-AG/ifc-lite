/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Regression suite for alive-state transitions and per-attribute removal
 * semantics (adversarial review findings on the 05 §5.3 matrix):
 *
 *  - a resurrection is a CHANGE: one-sided resurrects merge automatically,
 *    never drop, and never re-delete the other side's resurrection;
 *  - reverting a deletion layer actually resurrects;
 *  - attribute removals inside a surviving component survive the merge
 *    (per-attribute LWW composition needs explicit nulls);
 *  - `[base, L, revert(L)]` matches `base` for resurrect+edit and
 *    edit+delete layers.
 */

import { describe, expect, it } from 'vitest';
import type { IfcxFile, IfcxNode } from '@ifc-lite/ifcx';
import { IFCLITE_ATTR } from '@ifc-lite/ifcx';
import { planThreeWayMerge } from './three-way.js';
import { applyResolutions, opsToNodes } from './merge-layer.js';
import { buildRevertLayer } from './inverse.js';
import { extractStackState } from './component-state.js';
import type { MergeOp } from './types.js';

const FIRE = 'bsi::ifc::v5a::Pset_FireSafety::FireRating';
const BEHAVIOUR = 'bsi::ifc::v5a::Pset_FireSafety::FireBehaviour';

function makeLayer(data: IfcxNode[], id: string): IfcxFile {
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

const base = makeLayer(
  [
    {
      path: 'wall-1',
      attributes: {
        'bsi::ifc::class': { code: 'IfcWall', uri: 'u' },
        [FIRE]: 'REI60',
        [BEHAVIOUR]: 'A1',
      },
    },
  ],
  'base'
);

const del = makeLayer([{ path: 'wall-1', attributes: { [IFCLITE_ATTR.DELETED]: true } }], 'del');

function stateAfterMerge(ours: IfcxFile[], ops: readonly MergeOp[]) {
  return extractStackState([...ours, makeLayer(opsToNodes(ops), 'merge')]);
}

describe('resurrection is a change (alive-state transitions)', () => {
  it('resurrect-only candidate on an unchanged target → auto take theirs', () => {
    const res = makeLayer([{ path: 'wall-1', attributes: { [IFCLITE_ATTR.DELETED]: false } }], 'res');
    const plan = planThreeWayMerge({
      ancestor: [base, del],
      ours: [base, del],
      theirs: [base, del, res],
    });
    expect(plan.conflicts).toEqual([]);
    expect(plan.autoOps).toContainEqual({ op: 'resurrect-entity', path: 'wall-1' });
    const merged = stateAfterMerge([base, del], plan.autoOps);
    expect(merged.get('wall-1')?.deleted).toBe(false);
  });

  it('resurrect + edit on an unchanged target → auto take theirs with the edit', () => {
    const res = makeLayer(
      [{ path: 'wall-1', attributes: { [IFCLITE_ATTR.DELETED]: false, [FIRE]: 'REI90' } }],
      'res'
    );
    const plan = planThreeWayMerge({
      ancestor: [base, del],
      ours: [base, del],
      theirs: [base, del, res],
    });
    expect(plan.conflicts).toEqual([]);
    const merged = stateAfterMerge([base, del], plan.autoOps);
    const wall = merged.get('wall-1');
    expect(wall?.deleted).toBe(false);
    expect(wall?.components.get('pset:Pset_FireSafety')?.[FIRE]).toBe('REI90');
  });

  it('ours resurrected, theirs untouched → keep ours (no re-delete)', () => {
    const res = makeLayer([{ path: 'wall-1', attributes: { [IFCLITE_ATTR.DELETED]: false } }], 'res');
    const other = makeLayer([{ path: 'door-1', attributes: { 'bsi::ifc::class': { code: 'IfcDoor', uri: 'u' } } }], 'other');
    const plan = planThreeWayMerge({
      ancestor: [base, del],
      ours: [base, del, res],
      theirs: [base, del, other],
    });
    expect(plan.conflicts).toEqual([]);
    expect(plan.autoOps).not.toContainEqual({ op: 'tombstone-entity', path: 'wall-1' });
    const merged = stateAfterMerge([base, del, res], plan.autoOps);
    expect(merged.get('wall-1')?.deleted).toBe(false);
  });

  it('resurrect vs concurrent component edit under the tombstone → delete-vs-modify stays conflict-free only when one side moved', () => {
    // Ours resurrected AND edited; theirs edited the dead entity's
    // components differently: both changed, divergent → conflict.
    const oursRes = makeLayer(
      [{ path: 'wall-1', attributes: { [IFCLITE_ATTR.DELETED]: false, [FIRE]: 'REI90' } }],
      'ours-res'
    );
    const theirsEdit = makeLayer(
      [{ path: 'wall-1', attributes: { [IFCLITE_ATTR.DELETED]: false, [FIRE]: 'REI120' } }],
      'theirs-edit'
    );
    const plan = planThreeWayMerge({
      ancestor: [base, del],
      ours: [base, del, oursRes],
      theirs: [base, del, theirsEdit],
    });
    expect(plan.conflicts.length).toBeGreaterThan(0);
  });

  it('reverting a deletion layer resurrects (three-way orientation used by layer revert)', () => {
    // CLI `layer revert` plans {ancestor: through, ours: current, theirs: before}.
    const plan = planThreeWayMerge({
      ancestor: [base, del],
      ours: [base, del],
      theirs: [base],
    });
    expect(plan.conflicts).toEqual([]);
    expect(plan.autoOps).toContainEqual({ op: 'resurrect-entity', path: 'wall-1' });
    const merged = stateAfterMerge([base, del], plan.autoOps);
    expect(merged.get('wall-1')?.deleted).toBe(false);
    expect(merged.get('wall-1')?.components.get('pset:Pset_FireSafety')?.[FIRE]).toBe('REI60');
  });
});

describe('attribute removals survive per-attribute LWW composition', () => {
  it('candidate nulls one attribute of a surviving component → merged state drops it', () => {
    const removal = makeLayer([{ path: 'wall-1', attributes: { [FIRE]: null } }], 'removal');
    const plan = planThreeWayMerge({
      ancestor: [base],
      ours: [base],
      theirs: [base, removal],
    });
    expect(plan.conflicts).toEqual([]);
    const merged = stateAfterMerge([base], plan.autoOps);
    const pset = merged.get('wall-1')?.components.get('pset:Pset_FireSafety');
    expect(pset?.[FIRE]).toBeUndefined();
    expect(pset?.[BEHAVIOUR]).toBe('A1');
  });

  it('theirs resolution nulls attribute keys ours added inside the conflicted component', () => {
    const oursEdit = makeLayer(
      [{ path: 'wall-1', attributes: { [FIRE]: 'REI90', [BEHAVIOUR]: 'A2' } }],
      'ours-edit'
    );
    const theirsEdit = makeLayer([{ path: 'wall-1', attributes: { [FIRE]: 'REI120', [BEHAVIOUR]: null } }], 'theirs-edit');
    const plan = planThreeWayMerge({
      ancestor: [base],
      ours: [base, oursEdit],
      theirs: [base, theirsEdit],
    });
    expect(plan.conflicts).toHaveLength(1);
    const applied = applyResolutions(plan, [
      { path: 'wall-1', componentKey: 'pset:Pset_FireSafety', choice: 'theirs' },
    ]);
    const merged = stateAfterMerge([base, oursEdit], [...plan.autoOps, ...applied.ops]);
    const pset = merged.get('wall-1')?.components.get('pset:Pset_FireSafety');
    expect(pset?.[FIRE]).toBe('REI120');
    expect(pset?.[BEHAVIOUR]).toBeUndefined();
  });

  it('delete-vs-modify resolved theirs tombstones ours-only components after the resurrect', () => {
    const NEW_PSET = 'bsi::ifc::v5a::Pset_Acoustic::Rw';
    // Ours edits (component visible under its later tombstone), then deletes.
    const oursEdit = makeLayer([{ path: 'wall-1', attributes: { [NEW_PSET]: 42 } }], 'ours-edit');
    const oursDel = makeLayer([{ path: 'wall-1', attributes: { [IFCLITE_ATTR.DELETED]: true } }], 'ours-del');
    const theirsEdit = makeLayer([{ path: 'wall-1', attributes: { [FIRE]: 'REI120' } }], 'theirs-edit');
    const plan = planThreeWayMerge({
      ancestor: [base],
      ours: [base, oursEdit, oursDel],
      theirs: [base, theirsEdit],
    });
    expect(plan.conflicts).toHaveLength(1);
    expect(plan.conflicts[0].kind).toBe('delete-vs-modify');
    const applied = applyResolutions(plan, [{ path: 'wall-1', choice: 'theirs' }]);
    const merged = stateAfterMerge([base, oursEdit, oursDel], [...plan.autoOps, ...applied.ops]);
    const wall = merged.get('wall-1');
    expect(wall?.deleted).toBe(false);
    expect(wall?.components.get('pset:Pset_FireSafety')?.[FIRE]).toBe('REI120');
    // Ours' pre-tombstone opinion must not shine through the resurrect.
    expect(wall?.components.get('pset:Pset_Acoustic')).toBeUndefined();
  });
});

describe('shell strips and shadowed subtrees (verification-round fixes)', () => {
  const CLASS = 'bsi::ifc::class';
  const treeBase = makeLayer(
    [
      {
        path: 'storey',
        children: { Wall: 'wall-1' },
        attributes: { [CLASS]: { code: 'IfcBuildingStorey', uri: 'u' } },
      },
      {
        path: 'wall-1',
        attributes: { [CLASS]: { code: 'IfcWall', uri: 'u' }, [FIRE]: 'REI60' },
      },
    ],
    'tree-base'
  );

  it('an entity theirs stripped to an empty shell is removed with nulls, never a tombstone', () => {
    // A tombstone on the stripped parent would shadow-kill the child that
    // theirs kept alive.
    const strip = makeLayer(
      [{ path: 'storey', children: { Wall: null }, attributes: { [CLASS]: null } }],
      'strip'
    );
    const plan = planThreeWayMerge({
      ancestor: [treeBase],
      ours: [treeBase],
      theirs: [treeBase, strip],
    });
    expect(plan.conflicts).toEqual([]);
    expect(plan.autoOps).not.toContainEqual({ op: 'tombstone-entity', path: 'storey' });
    const merged = stateAfterMerge([treeBase], plan.autoOps);
    expect(merged.get('wall-1')?.deleted).toBe(false);
    expect(merged.get('storey')?.deleted ?? false).toBe(false);
    expect(merged.get('storey')?.components.size ?? 0).toBe(0);
  });

  it('theirs deletes a parent whose child ours edited → ONE subtree conflict on the parent', () => {
    const oursEdit = makeLayer([{ path: 'wall-1', attributes: { [FIRE]: 'REI90' } }], 'ours-edit');
    const theirsDel = makeLayer(
      [{ path: 'storey', attributes: { [IFCLITE_ATTR.DELETED]: true } }],
      'theirs-del'
    );
    const plan = planThreeWayMerge({
      ancestor: [treeBase],
      ours: [treeBase, oursEdit],
      theirs: [treeBase, theirsDel],
    });
    // No auto tombstone rides along that would pre-empt the decision.
    expect(plan.autoOps).not.toContainEqual({ op: 'tombstone-entity', path: 'storey' });
    expect(plan.conflicts).toHaveLength(1);
    expect(plan.conflicts[0]).toMatchObject({
      kind: 'modify-vs-delete',
      path: 'storey',
      subtree: ['wall-1'],
    });

    // theirs: the reviewer knowingly deletes the subtree.
    const theirs = applyResolutions(plan, [{ path: 'storey', choice: 'theirs' }]);
    const deleted = stateAfterMerge([treeBase, oursEdit], [...plan.autoOps, ...theirs.ops]);
    expect(deleted.get('storey')?.deleted).toBe(true);
    expect(deleted.get('wall-1')?.deleted).toBe(true);

    // ours: subtree survives with the edit.
    const ours = applyResolutions(plan, [{ path: 'storey', choice: 'ours' }]);
    const kept = stateAfterMerge([treeBase, oursEdit], [...plan.autoOps, ...ours.ops]);
    expect(kept.get('storey')?.deleted ?? false).toBe(false);
    expect(kept.get('wall-1')?.components.get('pset:Pset_FireSafety')?.[FIRE]).toBe('REI90');
  });

  it('ours deleted a parent whose child theirs edited → parent gains a resurrectable conflict', () => {
    const oursDel = makeLayer(
      [{ path: 'storey', attributes: { [IFCLITE_ATTR.DELETED]: true } }],
      'ours-del'
    );
    const theirsEdit = makeLayer([{ path: 'wall-1', attributes: { [FIRE]: 'REI120' } }], 'theirs-edit');
    const plan = planThreeWayMerge({
      ancestor: [treeBase],
      ours: [treeBase, oursDel],
      theirs: [treeBase, theirsEdit],
    });
    const parentConflict = plan.conflicts.find((c) => c.path === 'storey');
    const childConflict = plan.conflicts.find((c) => c.path === 'wall-1');
    expect(parentConflict).toMatchObject({ kind: 'delete-vs-modify', subtree: ['wall-1'] });
    expect(childConflict).toMatchObject({ kind: 'delete-vs-modify' });

    // Resolving both as theirs resurrects the parent AND applies the edit
    // (without the parent conflict, the child resolution was a silent
    // no-op — subtree shadowing beats a child resurrect).
    const applied = applyResolutions(plan, [
      { path: 'storey', choice: 'theirs' },
      { path: 'wall-1', choice: 'theirs' },
    ]);
    const merged = stateAfterMerge([treeBase, oursDel], [...plan.autoOps, ...applied.ops]);
    expect(merged.get('storey')?.deleted).toBe(false);
    expect(merged.get('wall-1')?.deleted).toBe(false);
    expect(merged.get('wall-1')?.components.get('pset:Pset_FireSafety')?.[FIRE]).toBe('REI120');
  });
});

describe('revert invariant: [base, L, revert(L)] == base', () => {
  const author = { kind: 'human' as const, principal: 'tester' };

  it('holds for a resurrect+edit layer', () => {
    const layer = makeLayer(
      [{ path: 'wall-1', attributes: { [IFCLITE_ATTR.DELETED]: false, [FIRE]: 'REI90' } }],
      'res-edit'
    );
    const revert = buildRevertLayer({ layer, base: [base, del], author, created: '2026-06-09T00:00:00Z' });
    const reverted = extractStackState([base, del, layer, revert.file]);
    const original = extractStackState([base, del]);
    const wall = reverted.get('wall-1');
    expect(wall?.deleted).toBe(true);
    expect(wall?.components.get('pset:Pset_FireSafety')?.[FIRE]).toBe(
      original.get('wall-1')?.components.get('pset:Pset_FireSafety')?.[FIRE]
    );
  });

  it('holds for an edit+delete layer (keys added before the tombstone are nulled)', () => {
    const NEW_PSET = 'bsi::ifc::v5a::Pset_Acoustic::Rw';
    const layer = makeLayer(
      [{ path: 'wall-1', attributes: { [NEW_PSET]: 42, [IFCLITE_ATTR.DELETED]: true } }],
      'edit-del'
    );
    const revert = buildRevertLayer({ layer, base: [base], author, created: '2026-06-09T00:00:00Z' });
    const reverted = extractStackState([base, layer, revert.file]);
    const wall = reverted.get('wall-1');
    expect(wall?.deleted).toBe(false);
    expect(wall?.components.get('pset:Pset_Acoustic')).toBeUndefined();
    expect(wall?.components.get('pset:Pset_FireSafety')?.[FIRE]).toBe('REI60');
  });

  it('holds for a pure deletion layer', () => {
    const revert = buildRevertLayer({ layer: del, base: [base], author, created: '2026-06-09T00:00:00Z' });
    const reverted = extractStackState([base, del, revert.file]);
    expect(reverted.get('wall-1')?.deleted).toBe(false);
    expect(reverted.get('wall-1')?.components.get('pset:Pset_FireSafety')?.[FIRE]).toBe('REI60');
  });
});
