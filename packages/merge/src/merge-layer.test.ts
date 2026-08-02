/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import type { IfcxFile, IfcxNode } from '@ifc-lite/ifcx';
import { IFCLITE_ATTR, computeLayerId, getProvenance } from '@ifc-lite/ifcx';
import { planThreeWayMerge } from './three-way.js';
import { applyResolutions, buildMergeLayer } from './merge-layer.js';
import { buildRevertLayer } from './inverse.js';
import { planRebase } from './rebase.js';
import { extractStackState } from './component-state.js';
import { makeLayer } from './three-way.test.js';

const FIRE = 'bsi::ifc::v5a::Pset_FireSafety::FireRating';

const base = makeLayer(
  [
    { path: 'storey-eg', children: { Wall: 'wall-1' } },
    {
      path: 'wall-1',
      attributes: { 'bsi::ifc::class': { code: 'IfcWall', uri: 'u' }, [FIRE]: 'REI60' },
    },
  ],
  'base'
);

function conflictingPlanInputs() {
  return {
    ancestor: [base],
    ours: [base, makeLayer([{ path: 'wall-1', attributes: { [FIRE]: 'REI90' } }], 'ours')],
    theirs: [base, makeLayer([{ path: 'wall-1', attributes: { [FIRE]: 'REI120' } }], 'theirs')],
  };
}

describe('applyResolutions', () => {
  it('ours keeps target state, theirs adopts candidate, edited replaces', () => {
    const plan = planThreeWayMerge(conflictingPlanInputs());
    expect(plan.conflicts).toHaveLength(1);

    const ours = applyResolutions(plan, [
      { path: 'wall-1', componentKey: 'pset:Pset_FireSafety', choice: 'ours' },
    ]);
    expect(ours.ops).toEqual([]);
    expect(ours.unresolved).toEqual([]);
    expect(ours.resolutions).toEqual([
      { entity: 'wall-1', componentKey: 'pset:Pset_FireSafety', choice: 'ours' },
    ]);

    const theirs = applyResolutions(plan, [
      { path: 'wall-1', componentKey: 'pset:Pset_FireSafety', choice: 'theirs' },
    ]);
    expect(theirs.ops).toEqual([
      {
        op: 'set-component',
        path: 'wall-1',
        componentKey: 'pset:Pset_FireSafety',
        attributes: { [FIRE]: 'REI120' },
      },
    ]);

    const edited = applyResolutions(plan, [
      {
        path: 'wall-1',
        componentKey: 'pset:Pset_FireSafety',
        choice: 'edited',
        attributes: { [FIRE]: 'REI180' },
      },
    ]);
    expect(edited.ops[0]).toMatchObject({ attributes: { [FIRE]: 'REI180' } });
  });

  it('reports unaddressed conflicts as unresolved', () => {
    const plan = planThreeWayMerge(conflictingPlanInputs());
    const applied = applyResolutions(plan, []);
    expect(applied.unresolved).toHaveLength(1);
  });
});

describe('buildMergeLayer', () => {
  it('publishes an immutable, content-addressed merge layer with manifest.merge', () => {
    const plan = planThreeWayMerge(conflictingPlanInputs());
    const applied = applyResolutions(plan, [
      { path: 'wall-1', componentKey: 'pset:Pset_FireSafety', choice: 'theirs' },
    ]);
    const published = buildMergeLayer({
      ops: [...plan.autoOps, ...applied.ops],
      author: { kind: 'human', principal: 'louis@lt.plus' },
      intent: 'Merge fire-safety reclassification into main',
      base: { kind: 'layer', id: computeLayerId(base) },
      merge: {
        candidate: 'blake3:candidate',
        into: 'main',
        resolutions: applied.resolutions,
        resolver: 'louis@lt.plus',
      },
    });

    expect(published.layerId.startsWith('blake3:')).toBe(true);
    expect(published.file.header.id).toBe(published.layerId);
    // The stored document re-hashes to its own id (header.id excluded).
    expect(computeLayerId(published.file)).toBe(published.layerId);

    const manifest = getProvenance(published.file);
    expect(manifest?.merge?.candidate).toBe('blake3:candidate');
    expect(manifest?.merge?.into).toBe('main');
    expect(manifest?.merge?.resolutions).toEqual(applied.resolutions);

    // Composing ours + merge layer lands the resolved value.
    const merged = extractStackState([...conflictingPlanInputs().ours, published.file]);
    expect(merged.get('wall-1')?.components.get('pset:Pset_FireSafety')).toEqual({
      [FIRE]: 'REI120',
    });
  });
});

describe('buildRevertLayer', () => {
  it('composing [base, L, revert(L)] restores the base component state', () => {
    const delta = makeLayer(
      [
        { path: 'wall-1', attributes: { [FIRE]: 'REI120' } },
        { path: 'door-1', attributes: { 'bsi::ifc::class': { code: 'IfcDoor', uri: 'u' } } },
        { path: 'storey-eg', attributes: { [IFCLITE_ATTR.DELETED]: true } },
      ],
      'delta'
    );
    const revert = buildRevertLayer({
      layer: delta,
      base: [base],
      author: { kind: 'human', principal: 'louis@lt.plus' },
      layerId: 'blake3:delta',
    });

    const before = extractStackState([base]);
    const after = extractStackState([base, delta, revert.file]);

    // Stack state keeps tombstones visible; the added door is dead.
    expect(after.get('door-1')?.deleted).toBe(true);
    expect(after.get('wall-1')?.components.get('pset:Pset_FireSafety')).toEqual({ [FIRE]: 'REI60' });
    const storey = after.get('storey-eg');
    expect(storey?.deleted).toBe(false);
    expect(storey?.children.get('Wall')).toBe('wall-1');
    // Every path in base is back.
    for (const path of before.keys()) {
      expect(after.has(path)).toBe(true);
    }
    expect(getProvenance(revert.file)?.parents).toEqual(['blake3:delta']);
  });
});

describe('planRebase', () => {
  it('re-plans against the moved ref and replays prior resolutions', () => {
    const candidate = makeLayer([{ path: 'wall-1', attributes: { [FIRE]: 'REI120' } }], 'candidate');
    const movedMain = [base, makeLayer([{ path: 'wall-1', attributes: { [FIRE]: 'REI90' } }], 'moved')];

    const first = planRebase({ candidate, oldBase: [base], newBase: movedMain });
    expect(first.plan.conflicts).toHaveLength(1);
    expect(first.applied.unresolved).toHaveLength(1);

    const second = planRebase({
      candidate,
      oldBase: [base],
      newBase: movedMain,
      priorResolutions: [
        { path: 'wall-1', componentKey: 'pset:Pset_FireSafety', choice: 'theirs' },
      ],
    });
    expect(second.applied.unresolved).toEqual([]);
    expect(second.applied.ops).toEqual([
      {
        op: 'set-component',
        path: 'wall-1',
        componentKey: 'pset:Pset_FireSafety',
        attributes: { [FIRE]: 'REI120' },
      },
    ]);
  });
});
