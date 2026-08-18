/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `componentKeyForAttribute` must agree with the producer side of the
 * pipe: `packages/mutations/src/change-set-to-ops.ts` builds
 * `pset:<name>` / `qset:<name>` component keys unconditionally from the
 * mutation type, for ANY author-chosen set name — not only names
 * starting with `Pset_`/`Qto_`. `@ifc-lite/collab`'s structured-attribute
 * inflation (packages/collab/src/snapshot/structured-attrs.ts) already
 * disambiguates a custom v5a set name by value shape (typed record →
 * pset, plain finite number → quantity) and documents that convention as
 * "already shared" by the merge engine's componentKey vocabulary — this
 * pins that this package actually holds up its end.
 */

import { describe, expect, it } from 'vitest';
import type { IfcxFile } from '@ifc-lite/ifcx';
import { componentKeyForAttribute, extractStackState, projectStackStates } from './component-state.js';
import { planThreeWayMerge } from './three-way.js';

describe('componentKeyForAttribute', () => {
  it('buckets a custom (non-Pset_) set name as pset:<name> when the value is a typed property record', () => {
    const key = componentKeyForAttribute('bsi::ifc::v5a::MyCustomSet::FireRating', {
      type: 'IfcLabel',
      value: 'REI60',
    });
    expect(key).toBe('pset:MyCustomSet');
  });

  it('buckets a custom (non-Qto_) set name as qset:<name> when the value is a plain finite number', () => {
    const key = componentKeyForAttribute('bsi::ifc::v5a::MyMetrics::Height', 3.2);
    expect(key).toBe('qset:MyMetrics');
  });

  it('still buckets the standard Pset_/Qto_ prefixes the same as before, value or no value', () => {
    expect(componentKeyForAttribute('bsi::ifc::v5a::Pset_FireSafety::FireRating', { type: 'IfcLabel', value: 'REI60' })).toBe(
      'pset:Pset_FireSafety',
    );
    expect(componentKeyForAttribute('bsi::ifc::v5a::Pset_FireSafety::FireRating', null)).toBe('pset:Pset_FireSafety');
    expect(componentKeyForAttribute('bsi::ifc::v5a::Qto_WallBaseQuantities::Height', 3)).toBe(
      'qset:Qto_WallBaseQuantities',
    );
    expect(componentKeyForAttribute('bsi::ifc::v5a::Qto_WallBaseQuantities::Height', null)).toBe(
      'qset:Qto_WallBaseQuantities',
    );
  });
});

function layerWith(attributes: Record<string, unknown>): IfcxFile {
  return {
    header: { id: 'l', ifcxVersion: 'ifcx_alpha', dataVersion: '1.0.0', author: 't', timestamp: 't' },
    imports: [],
    schemas: {},
    data: [{ path: 'wall-guid-1', attributes }],
  } as unknown as IfcxFile;
}

describe('extractStackState + a whole-pset tombstone lookup on a custom-named set (the buildDeltaNodes path)', () => {
  it('finds the custom-named pset members under pset:<name>, not a one-off attr:<key> bucket', () => {
    const base: IfcxFile = {
      header: { id: 'base', ifcxVersion: 'ifcx_alpha', dataVersion: '1.0.0', author: 't', timestamp: 't' },
      imports: [],
      schemas: {},
      data: [
        {
          path: 'wall-guid-1',
          attributes: {
            'bsi::ifc::v5a::MyCustomSet::FireRating': { type: 'IfcLabel', value: 'REI60' },
          },
        },
      ],
    };
    const state = extractStackState([base]);
    const entity = state.get('wall-guid-1');
    // Before the fix this component simply didn't exist under
    // `pset:MyCustomSet` — every member fell into its own
    // `attr:<full key>` bucket instead, so a whole-component tombstone
    // lookup (`buildDeltaNodes`'s `tombstone-component` case) found
    // nothing to null and silently deleted zero attributes.
    expect(entity?.components.get('pset:MyCustomSet')).toEqual({
      'bsi::ifc::v5a::MyCustomSet::FireRating': { type: 'IfcLabel', value: 'REI60' },
    });
  });

  /**
   * A `null` member deletion carries no value shape, so classifying it by
   * shape sent the delete to a DIFFERENT component than the live value it
   * was meant to remove — and the member survived:
   *
   *   live   (CarbonMetrics::CO2, 42)   -> qset:CarbonMetrics
   *   delete (CarbonMetrics::CO2, null) -> attr:bsi::ifc::v5a::CarbonMetrics::CO2
   *   components after delete: {"qset:CarbonMetrics":{"...::CO2":42}}
   *
   * The fold is weakest-first, so the value is already present when the
   * deletion is seen; the resolver looks up which component actually holds
   * the key rather than guessing from a shape that isn't there.
   */
  it.each([
    ['custom quantity set', 'bsi::ifc::v5a::CarbonMetrics::CO2', 42 as unknown],
    ['custom property set', 'bsi::ifc::v5a::MyCustomSet::FireRating', { type: 'IfcLabel', value: 'F30' }],
    // Controls: the standard prefixes always routed correctly. They must
    // still behave identically, or the fix has changed more than intended.
    ['standard Pset_', 'bsi::ifc::v5a::Pset_WallCommon::IsExternal', { type: 'IfcBoolean', value: true }],
    ['standard Qto_', 'bsi::ifc::v5a::Qto_WallBaseQuantities::NetArea', 12.5 as unknown],
  ])('a null deletion removes the member it targets (%s)', (_label, key, value) => {
    const live = layerWith({ [key]: value });
    const deletion = layerWith({ [key]: null });
    const state = extractStackState([live, deletion]);
    const entity = state.get('wall-guid-1');
    // The member is gone from every component, not merely absent from the
    // one the deletion happened to be classified into.
    const surviving = [...(entity?.components.values() ?? [])].filter((attrs) => key in attrs);
    expect(surviving).toEqual([]);
  });
});

/**
 * `projectSide` (the fast-path 05 §5.7 clone-on-write fold, this file's
 * `for (const layer of suffix)` loop) folds a side's suffix layers
 * weakest-first, per attribute — same contract as `extractStackState`'s
 * comment: "later opinions shadow earlier ones per attribute." That
 * ordering was structurally unpinned: every `ours`/`theirs` array in the
 * rest of this suite (three-way.test.ts, merge-layer.test.ts,
 * resurrect.test.ts, fast-path-differential.test.ts,
 * real-model-fuzz.test.ts, ref-flow-resolutions.test.ts) is
 * `[...ancestor, oneLayer]` — a suffix of length exactly 1, so "earlier"
 * never exists and the fold cannot be observed. This fixture uses a
 * TWO-layer ours suffix that writes the SAME attribute in both layers
 * (with different values, so the fold is observable at all) plus an
 * attribute written only in the earlier layer (so shadowing-per-attribute
 * is distinguished from wholesale replacement).
 */
describe('projectSide folds a multi-layer suffix weakest-first, per attribute', () => {
  const FIRE = 'bsi::ifc::v5a::Pset_FireSafety::FireRating';
  const SMOKE = 'bsi::ifc::v5a::Pset_FireSafety::SmokeRating';

  function layerAt(id: string, attributes: Record<string, unknown>): IfcxFile {
    return {
      header: { id, ifcxVersion: 'ifcx_alpha', dataVersion: '1.0.0', author: 't', timestamp: 't' },
      imports: [],
      schemas: {},
      data: [{ path: 'e1', attributes }],
    } as unknown as IfcxFile;
  }

  const ancestor = [layerAt('base', { [FIRE]: { type: 'IfcLabel', value: 'REI60' } })];
  // Ours suffix: two layers, weakest first.
  //  - o1 (earlier): writes FIRE=REI90 AND SmokeRating=S30.
  //  - o2 (later):   writes FIRE=REI120 only — SMOKE is untouched here.
  // Correct (weakest-first) fold: FIRE=REI120 (o2 shadows o1), SMOKE=S30
  // (only o1 wrote it, so o2 must not erase it). A reversed fold instead
  // yields FIRE=REI90 (o1 clobbers o2 because it is applied last).
  const oursSuffix = [
    layerAt('o1', { [FIRE]: { type: 'IfcLabel', value: 'REI90' }, [SMOKE]: { type: 'IfcLabel', value: 'S30' } }),
    layerAt('o2', { [FIRE]: { type: 'IfcLabel', value: 'REI120' } }),
  ];
  // Theirs: unrelated edit to the same attribute so the merge matrix
  // records a real `concurrent-edit` conflict whose `ours` snapshot is
  // the folded component — carrying the fold-order-dependent value into
  // an actual merge result, not just an internal state map.
  const theirsSuffix = [layerAt('t1', { [FIRE]: { type: 'IfcLabel', value: 'REI999' } })];

  it('this fixture is fast-path eligible (no tombstones, shared ancestor prefix) — the fold under test actually runs', () => {
    // Confirms which code path executes: a null return here would mean
    // the assertions below exercise extractStackState's full fold
    // instead of projectSide's clone-on-write fold.
    const projected = projectStackStates(ancestor, oursSuffix, theirsSuffix);
    expect(projected).not.toBeNull();
  });

  it('later layer shadows the earlier layer PER ATTRIBUTE: FireRating from o2, SmokeRating survives from o1', () => {
    const projected = projectStackStates(ancestor, oursSuffix, theirsSuffix);
    const oursComponent = projected?.o.get('e1')?.components.get('pset:Pset_FireSafety');
    expect(oursComponent).toEqual({
      [FIRE]: { type: 'IfcLabel', value: 'REI120' },
      [SMOKE]: { type: 'IfcLabel', value: 'S30' },
    });
  });

  it('matches extractStackState (the reference fold) on the same multi-layer stack', () => {
    const projected = projectStackStates(ancestor, oursSuffix, theirsSuffix);
    const reference = extractStackState([...ancestor, ...oursSuffix]);
    expect(projected?.o.get('e1')?.components.get('pset:Pset_FireSafety')).toEqual(
      reference.get('e1')?.components.get('pset:Pset_FireSafety')
    );
  });

  it('the fold-order-dependent value reaches an actual merge conflict via planThreeWayMerge', () => {
    const plan = planThreeWayMerge({ ancestor, ours: [...ancestor, ...oursSuffix], theirs: [...ancestor, ...theirsSuffix] });
    const conflict = plan.conflicts.find((c) => c.path === 'e1' && c.componentKey === 'pset:Pset_FireSafety');
    expect(conflict?.kind).toBe('concurrent-edit');
    expect(conflict?.ours?.attributes).toEqual({
      [FIRE]: { type: 'IfcLabel', value: 'REI120' },
      [SMOKE]: { type: 'IfcLabel', value: 'S30' },
    });
  });
});
