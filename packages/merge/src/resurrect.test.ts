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

  it('theirs strips a parent to an empty shell while ours concurrently edits it → modify-vs-delete with a recorded (empty) theirs, resolved without a shadow-killing tombstone', () => {
    // Unlike the auto-merged case above, ours here touches `storey` ITSELF
    // (not just the child) — that's what turns the shell-strip into a real
    // conflict instead of an automatic "theirs" application.
    const oursEdit = makeLayer([{ path: 'storey', attributes: { [FIRE]: 'REI90' } }], 'ours-edit');
    const strip = makeLayer(
      [{ path: 'storey', children: { Wall: null }, attributes: { [CLASS]: null } }],
      'strip'
    );
    const plan = planThreeWayMerge({
      ancestor: [treeBase],
      ours: [treeBase, oursEdit],
      theirs: [treeBase, strip],
    });
    expect(plan.conflicts).toHaveLength(1);
    const conflict = plan.conflicts[0];
    expect(conflict.kind).toBe('modify-vs-delete');
    expect(conflict.path).toBe('storey');
    // The recorded (empty) theirs state is what routes applyResolutions
    // into the removal-opinions path instead of a plain tombstone.
    expect(conflict.theirs).toBeDefined();
    expect(conflict.theirs?.attributes).toEqual({});

    const applied = applyResolutions(plan, [{ path: 'storey', choice: 'theirs' }]);
    // No tombstone-entity op: that would shadow-kill wall-1, which theirs
    // never touched directly.
    expect(applied.ops).not.toContainEqual({ op: 'tombstone-entity', path: 'storey' });
    const merged = stateAfterMerge([treeBase, oursEdit], [...plan.autoOps, ...applied.ops]);
    // The whole point of the branch: the child survives instead of dying
    // under a parent tombstone it was never the target of.
    expect(merged.get('wall-1')?.deleted).toBe(false);
    expect(merged.get('wall-1')?.components.get('pset:Pset_FireSafety')?.[FIRE]).toBe('REI60');
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

/**
 * Every shadowed-subtree fixture above is a ONE-level tree with a SINGLE
 * child (`storey` → `wall-1`). Three symmetries hide in that shape, and
 * mutation testing confirmed all three are invisible to the suite as it
 * stood — each mutant below left the whole `@ifc-lite/merge` suite green:
 *
 *  1. depth. `extractStackState`'s tombstone-shadow pass is a work queue,
 *     but at depth 1 a queue that never re-enqueues is indistinguishable
 *     from one that does. Truncating it to `if (child) child.deleted = true`
 *     (no `queue.push`) passed 101/101.
 *  2. root selection. `escalateShadowedConflicts`'s `rootIn` walks to the
 *     nearest ancestor whose death is EXPLICIT, deliberately stepping over
 *     merely shadow-dead ancestors. At depth 1 the first parent is always
 *     the explicit root, so keying on `entity?.deleted` instead of
 *     `entity?.explicitDeleted` passed 101/101.
 *  3. ordering. `subtree` is sorted so the conflict record is stable, but
 *     a one-element list is its own sort — dropping `.sort()` passed
 *     101/101.
 *
 * This fixture breaks all three: three levels (`building` → `storey` →
 * two walls), and the walls are declared in REVERSE sorted order so the
 * natural iteration order is not the sorted order.
 */
describe('shadowed subtrees deeper than one level', () => {
  const CLASS = 'bsi::ifc::class';
  const deepBase = makeLayer(
    [
      {
        path: 'building',
        children: { Storey: 'storey' },
        attributes: { [CLASS]: { code: 'IfcBuilding', uri: 'u' } },
      },
      {
        path: 'storey',
        // Slot names chosen so neither the slot order nor the path order
        // matches the sorted path order.
        children: { WallB: 'wall-2', WallA: 'wall-1' },
        attributes: { [CLASS]: { code: 'IfcBuildingStorey', uri: 'u' } },
      },
      // Declared out of sorted order on purpose: `planFromStates` iterates
      // the union of path keys in insertion order, so an unsorted `subtree`
      // would come out as ['wall-2', 'wall-1'].
      { path: 'wall-2', attributes: { [CLASS]: { code: 'IfcWall', uri: 'u' }, [FIRE]: 'REI60' } },
      { path: 'wall-1', attributes: { [CLASS]: { code: 'IfcWall', uri: 'u' }, [FIRE]: 'REI60' } },
    ],
    'deep-base'
  );

  it('theirs deletes a grandparent whose GRANDCHILDREN ours edited → one conflict on the grandparent, subtree sorted', () => {
    const oursEdit = makeLayer(
      [
        { path: 'wall-2', attributes: { [FIRE]: 'REI90' } },
        { path: 'wall-1', attributes: { [FIRE]: 'REI120' } },
      ],
      'ours-edit'
    );
    const theirsDel = makeLayer(
      [{ path: 'building', attributes: { [IFCLITE_ATTR.DELETED]: true } }],
      'theirs-del'
    );
    const plan = planThreeWayMerge({
      ancestor: [deepBase],
      ours: [deepBase, oursEdit],
      theirs: [deepBase, theirsDel],
    });

    // The grandchildren are shadow-dead on the theirs side even though the
    // tombstone sits two levels up — that is the depth the queue provides.
    const theirsState = extractStackState([deepBase, theirsDel]);
    expect(theirsState.get('storey')?.deleted).toBe(true);
    expect(theirsState.get('wall-1')?.deleted).toBe(true);
    expect(theirsState.get('wall-2')?.deleted).toBe(true);
    // ...and only `building` owns an explicit tombstone; the descendants
    // are shadow deaths, which is what `rootIn` must walk past.
    expect(theirsState.get('building')?.explicitDeleted).toBe(true);
    expect(theirsState.get('storey')?.explicitDeleted).toBe(false);
    expect(theirsState.get('wall-1')?.explicitDeleted).toBe(false);

    // One decision, taken at the explicitly-tombstoned ROOT — not at
    // `storey` (merely shadow-dead) and not once per wall.
    expect(plan.conflicts).toHaveLength(1);
    expect(plan.conflicts[0]).toMatchObject({
      kind: 'modify-vs-delete',
      path: 'building',
      subtree: ['wall-1', 'wall-2'],
    });
    // No auto tombstone rides along that would pre-empt the decision.
    expect(plan.autoOps).not.toContainEqual({ op: 'tombstone-entity', path: 'building' });

    // theirs: the whole two-level subtree goes, knowingly.
    const takeTheirs = applyResolutions(plan, [{ path: 'building', choice: 'theirs' }]);
    const deleted = stateAfterMerge([deepBase, oursEdit], [...plan.autoOps, ...takeTheirs.ops]);
    expect(deleted.get('building')?.deleted).toBe(true);
    expect(deleted.get('storey')?.deleted).toBe(true);
    expect(deleted.get('wall-1')?.deleted).toBe(true);
    expect(deleted.get('wall-2')?.deleted).toBe(true);

    // ours: the whole subtree survives, both edits intact and distinct.
    const takeOurs = applyResolutions(plan, [{ path: 'building', choice: 'ours' }]);
    const kept = stateAfterMerge([deepBase, oursEdit], [...plan.autoOps, ...takeOurs.ops]);
    expect(kept.get('building')?.deleted ?? false).toBe(false);
    expect(kept.get('wall-1')?.components.get('pset:Pset_FireSafety')?.[FIRE]).toBe('REI120');
    expect(kept.get('wall-2')?.components.get('pset:Pset_FireSafety')?.[FIRE]).toBe('REI90');
  });

  it('ours deletes a grandparent whose GRANDCHILDREN theirs edited → resurrectable root conflict plus the per-wall conflicts that carry the edits', () => {
    const oursDel = makeLayer(
      [{ path: 'building', attributes: { [IFCLITE_ATTR.DELETED]: true } }],
      'ours-del'
    );
    const theirsEdit = makeLayer(
      [
        { path: 'wall-2', attributes: { [FIRE]: 'REI90' } },
        { path: 'wall-1', attributes: { [FIRE]: 'REI120' } },
      ],
      'theirs-edit'
    );
    const plan = planThreeWayMerge({
      ancestor: [deepBase],
      ours: [deepBase, oursDel],
      theirs: [deepBase, theirsEdit],
    });

    // The root gains the resurrectable conflict; `storey`, merely
    // shadow-dead and untouched by theirs, must not be mistaken for it.
    expect(plan.conflicts.find((c) => c.path === 'building')).toMatchObject({
      kind: 'delete-vs-modify',
      subtree: ['wall-1', 'wall-2'],
    });
    expect(plan.conflicts.find((c) => c.path === 'storey')).toBeUndefined();
    // The descendant conflicts are KEPT on this side: their theirs-side
    // resolutions carry the actual edits, and become satisfiable only once
    // the root is resurrected.
    expect(plan.conflicts.find((c) => c.path === 'wall-1')).toMatchObject({
      kind: 'delete-vs-modify',
    });
    expect(plan.conflicts.find((c) => c.path === 'wall-2')).toMatchObject({
      kind: 'delete-vs-modify',
    });

    const applied = applyResolutions(plan, [
      { path: 'building', choice: 'theirs' },
      { path: 'wall-1', choice: 'theirs' },
      { path: 'wall-2', choice: 'theirs' },
    ]);
    const merged = stateAfterMerge([deepBase, oursDel], [...plan.autoOps, ...applied.ops]);
    expect(merged.get('building')?.deleted).toBe(false);
    expect(merged.get('wall-1')?.deleted).toBe(false);
    expect(merged.get('wall-2')?.deleted).toBe(false);
    expect(merged.get('wall-1')?.components.get('pset:Pset_FireSafety')?.[FIRE]).toBe('REI120');
    expect(merged.get('wall-2')?.components.get('pset:Pset_FireSafety')?.[FIRE]).toBe('REI90');
  });
});
