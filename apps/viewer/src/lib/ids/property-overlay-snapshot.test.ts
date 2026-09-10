/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The overlay snapshot that lets the IDS worker see pending property edits
 * (#3946).
 *
 * Two properties matter, and neither is safe to take on trust:
 *
 * 1. **It carries the LIVE overlay, not the mutation history.** History is
 *    append-only and undo does not pop it (`mutationSlice.ts` re-applies the
 *    inverse with `skipHistory=true`), so a snapshot built from history would
 *    ship a reverted correction to the worker as if it were still active —
 *    the #3929 bug, reintroduced in a realm where it is harder to see.
 *
 * 2. **It carries ONLY property overrides.** That is what makes routing an
 *    edited model to the worker equivalent to validating it on the main
 *    thread rather than merely similar: the bridge accessor consults the
 *    overlay in `getPropertyValue`/`getPropertySets` and nowhere else, so the
 *    other ten kinds of state `hasPendingChanges()` reports (attribute edits,
 *    retypes, quantities, tombstones, ...) were never visible to IDS
 *    validation on EITHER path. If a snapshot silently started carrying them
 *    the two realms would still agree, but the claim in this file's callers
 *    would stop being the reason why.
 *
 * Expectations here are written out literally rather than derived from the
 * functions under test, so a defect in the projection cannot also move the
 * oracle.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MutablePropertyView } from '@ifc-lite/mutations';
import { PropertyValueType } from '@ifc-lite/data';

import {
  snapshotPropertyOverlay,
  overlayResolverFromSnapshot,
} from './property-overlay-snapshot.js';

function view(): MutablePropertyView {
  return new MutablePropertyView(null, 'model-1');
}

describe('snapshotPropertyOverlay', () => {
  it('is empty for a view with no edits', () => {
    assert.deepEqual(snapshotPropertyOverlay(view()), []);
  });

  it('projects a scalar correction as one PropertyOverride', () => {
    const v = view();
    v.setProperty(7, 'Pset_WallCommon', 'FireRating', 'F90', PropertyValueType.String);

    assert.deepEqual(snapshotPropertyOverlay(v), [
      [7, [{ psetName: 'Pset_WallCommon', propName: 'FireRating', value: 'F90', dataType: undefined }]],
    ]);
  });

  it('groups several edits on one entity into a single entry', () => {
    const v = view();
    v.setProperty(7, 'Pset_WallCommon', 'FireRating', 'F90', PropertyValueType.String);
    v.setProperty(7, 'Pset_WallCommon', 'IsExternal', true, PropertyValueType.Boolean);

    const snapshot = snapshotPropertyOverlay(v);
    assert.equal(snapshot.length, 1);
    assert.equal(snapshot[0][0], 7);
    assert.deepEqual(
      snapshot[0][1].map((o) => [o.propName, o.value]),
      [['FireRating', 'F90'], ['IsExternal', true]]
    );
  });

  it('is O(edits): entities that were never touched contribute nothing', () => {
    const v = view();
    v.setProperty(7, 'Pset_WallCommon', 'FireRating', 'F90', PropertyValueType.String);

    const snapshot = snapshotPropertyOverlay(v);
    assert.equal(snapshot.length, 1, 'a 250k-entity model with one edit must ship one entry');
    assert.equal(overlayResolverFromSnapshot(snapshot)!(999), undefined);
  });

  // The #3929 regression, moved into a new realm. History keeps the SET row
  // after the delete unwinds it, so a history-derived snapshot would ship the
  // stale 'F90' and the worker would report PASS on data that reverted.
  it('does NOT report a correction that has since been unwound', () => {
    const v = view();
    v.setProperty(7, 'Pset_WallCommon', 'FireRating', 'F90', PropertyValueType.String);
    v.deleteProperty(7, 'Pset_WallCommon', 'FireRating');

    assert.equal(
      v.getPropertyMutation(7, 'Pset_WallCommon', 'FireRating'),
      undefined,
      'oracle: the LIVE overlay no longer holds this key'
    );
    assert.ok(
      v.getMutations().some((m) => m.propName === 'FireRating'),
      'oracle: history still does, which is what makes this test worth having'
    );
    assert.deepEqual(snapshotPropertyOverlay(v), []);
  });

  it('skips a list/array value rather than shipping a shape the bridge cannot apply', () => {
    const v = view();
    v.setProperty(7, 'Pset_WallCommon', 'Tags', ['a', 'b'] as unknown as string, PropertyValueType.String);

    assert.deepEqual(snapshotPropertyOverlay(v), []);
  });

  // Property edits are the ONLY thing the accessor ever reflected — see the
  // module doc. If any of these started appearing, the equivalence argument
  // for routing edited models to the worker would need re-deriving.
  it('carries no entry for mutations the IDS accessor never consulted', () => {
    const v = view();
    v.setAttribute(7, 'Name', 'Renamed Wall');
    v.setQuantity(7, 'Qto_WallBaseQuantities', 'NetSideArea', 12.5);
    v.setEntityType(7, 'IfcWall', 'IfcWallStandardCase');

    assert.equal(v.hasPendingChanges(), true, 'the view really does carry pending state');
    assert.deepEqual(
      snapshotPropertyOverlay(v),
      [],
      'none of these were ever visible to IDS validation, on either path'
    );
  });

  // A timing assertion would be flaky; this pins the SHAPE instead.
  // `getMutationsForEntity` is a `filter` over the whole history, so one call
  // per edited entity is O(edits^2) — measured at 174ms for 10k pending edits
  // against 3.9ms for the single grouping pass. That is a main-thread stall
  // put back by a different door.
  it('walks the mutation history once, not once per edited entity', () => {
    const v = view();
    for (let i = 1; i <= 50; i += 1) {
      v.setProperty(i, 'Pset_WallCommon', 'FireRating', `F${i}`, PropertyValueType.String);
    }

    let perEntityScans = 0;
    const realPerEntity = v.getMutationsForEntity.bind(v);
    v.getMutationsForEntity = (entityId: number) => {
      perEntityScans += 1;
      return realPerEntity(entityId);
    };

    const snapshot = snapshotPropertyOverlay(v);

    assert.equal(snapshot.length, 50, 'sanity: every edit is still projected');
    assert.equal(perEntityScans, 0, 'a per-entity history filter makes this quadratic');
  });

  it('is structured-clone safe, which is how it reaches the worker', () => {
    const v = view();
    v.setProperty(7, 'Pset_WallCommon', 'FireRating', 'F90', PropertyValueType.String);
    v.setProperty(8, 'Pset_WallCommon', 'IsExternal', false, PropertyValueType.Boolean);

    const snapshot = snapshotPropertyOverlay(v);
    // A `MutablePropertyView` would throw DataCloneError here: it holds Maps of
    // class instances and injected extractor FUNCTIONS. Plain pairs do not.
    assert.deepEqual(structuredClone(snapshot), snapshot);
  });
});

describe('overlayResolverFromSnapshot', () => {
  it('returns undefined for an absent or empty snapshot, so the caller takes the no-overlay path', () => {
    assert.equal(overlayResolverFromSnapshot(undefined), undefined);
    assert.equal(overlayResolverFromSnapshot([]), undefined);
  });

  it('round-trips a snapshot back to per-entity overrides', () => {
    const v = view();
    v.setProperty(7, 'Pset_WallCommon', 'FireRating', 'F90', PropertyValueType.String);
    v.setProperty(8, 'Pset_WallCommon', 'FireRating', 'F30', PropertyValueType.String);

    // Through structuredClone, because a resolver rebuilt in the worker is
    // rebuilt from the CLONE, never from the object the main thread holds.
    const resolver = overlayResolverFromSnapshot(structuredClone(snapshotPropertyOverlay(v)))!;

    assert.equal(resolver(7)?.[0].value, 'F90');
    assert.equal(resolver(8)?.[0].value, 'F30');
    assert.equal(resolver(9), undefined);
  });
});
