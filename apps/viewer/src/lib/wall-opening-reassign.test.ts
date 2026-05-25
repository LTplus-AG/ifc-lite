/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { reassignWallOpenings } from './wall-opening-reassign.js';

import { StubStoreEditor, StubView, makeStubDataStore, type OverlayEntity } from './__test__/stubs.js';

/**
 * Build a fixture with a source wall + two openings.
 *
 *   #100 IfcWall (source) at wall-local origin
 *   #200 IfcRelVoidsElement → wall #100, opening #201
 *     #201 IfcOpeningElement at wall-local X = 1 m
 *   #210 IfcRelVoidsElement → wall #100, opening #211
 *     #211 IfcOpeningElement at wall-local X = 4 m
 *
 * The two new wall ids (left/right) and their placements aren't
 * walked by the helper — it just rewrites the references.
 */
function makeFixture() {
  const opening1Point: OverlayEntity = {
    expressId: 230,
    type: 'IFCCARTESIANPOINT',
    attributes: [[1, 0, 0]],
  };
  const opening1Axis: OverlayEntity = {
    expressId: 240,
    type: 'IFCAXIS2PLACEMENT3D',
    attributes: [230, null, null],
  };
  // PlacementRelTo points at source wall's placement (#150 — not
  // walked; the helper just rewrites this attr).
  const opening1Placement: OverlayEntity = {
    expressId: 250,
    type: 'IFCLOCALPLACEMENT',
    attributes: [150, 240],
  };
  const opening1: OverlayEntity = {
    expressId: 201,
    type: 'IFCOPENINGELEMENT',
    attributes: ['gid1', null, null, null, null, 250, null, null],
  };
  const rel1: OverlayEntity = {
    expressId: 200,
    type: 'IFCRELVOIDSELEMENT',
    attributes: ['gid2', null, null, null, 100, 201],
  };

  const opening2Point: OverlayEntity = {
    expressId: 231,
    type: 'IFCCARTESIANPOINT',
    attributes: [[4, 0, 0]],
  };
  const opening2Axis: OverlayEntity = {
    expressId: 241,
    type: 'IFCAXIS2PLACEMENT3D',
    attributes: [231, null, null],
  };
  const opening2Placement: OverlayEntity = {
    expressId: 251,
    type: 'IFCLOCALPLACEMENT',
    attributes: [150, 241],
  };
  const opening2: OverlayEntity = {
    expressId: 211,
    type: 'IFCOPENINGELEMENT',
    attributes: ['gid3', null, null, null, null, 251, null, null],
  };
  const rel2: OverlayEntity = {
    expressId: 210,
    type: 'IFCRELVOIDSELEMENT',
    attributes: ['gid4', null, null, null, 100, 211],
  };

  // Source wall + its placement chain — the reassign helper now
  // requires this to verify each opening's PlacementRelTo
  // actually points at THIS wall before rewriting it.
  const wallPoint: OverlayEntity = {
    expressId: 140,
    type: 'IFCCARTESIANPOINT',
    attributes: [[0, 0, 0]],
  };
  const wallAxis: OverlayEntity = {
    expressId: 141,
    type: 'IFCAXIS2PLACEMENT3D',
    attributes: [140, null, null],
  };
  const wallPlacement: OverlayEntity = {
    expressId: 150,
    type: 'IFCLOCALPLACEMENT',
    attributes: [null, 141],
  };
  const wall: OverlayEntity = {
    expressId: 100,
    type: 'IFCWALL',
    attributes: ['gid-wall', null, 'Wall', null, null, 150, null, null],
  };

  return {
    entities: [
      wallPoint, wallAxis, wallPlacement, wall,
      opening1Point, opening1Axis, opening1Placement, opening1, rel1,
      opening2Point, opening2Axis, opening2Placement, opening2, rel2,
    ],
    ids: {
      sourceWall: 100,
      leftWall: 101,
      rightWall: 102,
      leftPlacement: 151,
      rightPlacement: 152,
      rel1: 200,
      rel2: 210,
      opening1Placement: 250,
      opening2Placement: 251,
      opening1Point: 230,
      opening2Point: 231,
    },
  };
}

function makeStore(byType: Map<string, number[]>) {
  return makeStubDataStore(byType) as unknown as Parameters<typeof reassignWallOpenings>[0];
}

describe('reassignWallOpenings', () => {
  it('moves a sub-distance opening to the left half without offset', () => {
    const fx = makeFixture();
    // Only opening 1 (X=1) — drop opening 2 from the fixture so we
    // assert one move at a time.
    // Keep the source-wall chain entities (100/150/141/140) so the
    // helper's "verify PlacementRelTo points at source wall" guard
    // passes. Drop opening 2's payload so we exercise one move at a time.
    const entities = fx.entities.filter((e) =>
      [100, 140, 141, 150, fx.ids.rel1, fx.ids.opening1Placement, fx.ids.opening1Point, 201, 240].includes(e.expressId),
    );
    const editor = new StubStoreEditor(entities);
    const view = new StubView() as unknown as Parameters<typeof reassignWallOpenings>[1];
    const store = makeStore(new Map([['IFCRELVOIDSELEMENT', [fx.ids.rel1]]]));
    const summary = reassignWallOpenings(
      store,
      view,
      editor as unknown as Parameters<typeof reassignWallOpenings>[2],
      fx.ids.sourceWall,
      fx.ids.leftWall,
      fx.ids.rightWall,
      2.5,
      fx.ids.leftPlacement,
      fx.ids.rightPlacement,
    );
    assert.strictEqual(summary.toLeft, 1);
    assert.strictEqual(summary.toRight, 0);
    // Rel rewritten to leftWall.
    assert.strictEqual(editor.getNewEntity(fx.ids.rel1)?.attributes[4], fx.ids.leftWall);
    // Opening's placement points at leftPlacement.
    assert.strictEqual(editor.getNewEntity(fx.ids.opening1Placement)?.attributes[0], fx.ids.leftPlacement);
    // Local-X unchanged because left half coincides with source's origin.
    assert.deepStrictEqual(editor.getNewEntity(fx.ids.opening1Point)?.attributes[0], [1, 0, 0]);
  });

  it('moves a past-distance opening to the right half AND offsets local X', () => {
    const fx = makeFixture();
    const entities = fx.entities.filter((e) =>
      [100, 140, 141, 150, fx.ids.rel2, fx.ids.opening2Placement, fx.ids.opening2Point, 211, 241].includes(e.expressId),
    );
    const editor = new StubStoreEditor(entities);
    const view = new StubView() as unknown as Parameters<typeof reassignWallOpenings>[1];
    const store = makeStore(new Map([['IFCRELVOIDSELEMENT', [fx.ids.rel2]]]));
    const summary = reassignWallOpenings(
      store,
      view,
      editor as unknown as Parameters<typeof reassignWallOpenings>[2],
      fx.ids.sourceWall,
      fx.ids.leftWall,
      fx.ids.rightWall,
      2.5,
      fx.ids.leftPlacement,
      fx.ids.rightPlacement,
    );
    assert.strictEqual(summary.toLeft, 0);
    assert.strictEqual(summary.toRight, 1);
    assert.strictEqual(editor.getNewEntity(fx.ids.rel2)?.attributes[4], fx.ids.rightWall);
    assert.strictEqual(editor.getNewEntity(fx.ids.opening2Placement)?.attributes[0], fx.ids.rightPlacement);
    // Local-X shifted by -2.5 so the world position stays put.
    assert.deepStrictEqual(editor.getNewEntity(fx.ids.opening2Point)?.attributes[0], [1.5, 0, 0]);
  });

  it('handles a mixed batch (one left, one right) in a single call', () => {
    const fx = makeFixture();
    const editor = new StubStoreEditor(fx.entities);
    const view = new StubView() as unknown as Parameters<typeof reassignWallOpenings>[1];
    const store = makeStore(
      new Map([['IFCRELVOIDSELEMENT', [fx.ids.rel1, fx.ids.rel2]]]),
    );
    const summary = reassignWallOpenings(
      store,
      view,
      editor as unknown as Parameters<typeof reassignWallOpenings>[2],
      fx.ids.sourceWall,
      fx.ids.leftWall,
      fx.ids.rightWall,
      2.5,
      fx.ids.leftPlacement,
      fx.ids.rightPlacement,
    );
    assert.strictEqual(summary.toLeft, 1);
    assert.strictEqual(summary.toRight, 1);
    assert.strictEqual(summary.skipped, 0);
  });

  it('skips relationships that do not target the source wall', () => {
    const fx = makeFixture();
    // Switch rel2's target to an unrelated wall id — should be
    // ignored.
    const rel2 = fx.entities.find((e) => e.expressId === fx.ids.rel2)!;
    rel2.attributes = ['gid4', null, null, null, 999, 211];
    const editor = new StubStoreEditor(fx.entities);
    const view = new StubView() as unknown as Parameters<typeof reassignWallOpenings>[1];
    const store = makeStore(
      new Map([['IFCRELVOIDSELEMENT', [fx.ids.rel1, fx.ids.rel2]]]),
    );
    const summary = reassignWallOpenings(
      store,
      view,
      editor as unknown as Parameters<typeof reassignWallOpenings>[2],
      fx.ids.sourceWall,
      fx.ids.leftWall,
      fx.ids.rightWall,
      2.5,
      fx.ids.leftPlacement,
      fx.ids.rightPlacement,
    );
    assert.strictEqual(summary.toLeft, 1);
    assert.strictEqual(summary.toRight, 0);
    // Unrelated rel untouched.
    assert.strictEqual(editor.getNewEntity(fx.ids.rel2)?.attributes[4], 999);
  });

  it('preserves overlay #X-string ref form', () => {
    const fx = makeFixture();
    // Rewrite rel1's RelatingBuildingElement as a #-string.
    const rel1 = fx.entities.find((e) => e.expressId === fx.ids.rel1)!;
    rel1.attributes = ['gid2', null, null, null, '#100', 201];
    const editor = new StubStoreEditor(fx.entities);
    const view = new StubView() as unknown as Parameters<typeof reassignWallOpenings>[1];
    const store = makeStore(new Map([['IFCRELVOIDSELEMENT', [fx.ids.rel1]]]));
    reassignWallOpenings(
      store,
      view,
      editor as unknown as Parameters<typeof reassignWallOpenings>[2],
      fx.ids.sourceWall,
      fx.ids.leftWall,
      fx.ids.rightWall,
      2.5,
      fx.ids.leftPlacement,
      fx.ids.rightPlacement,
    );
    // Output preserves the string form.
    assert.strictEqual(editor.getNewEntity(fx.ids.rel1)?.attributes[4], `#${fx.ids.leftWall}`);
  });

  it('skips openings whose PlacementRelTo does not point at the source wall', () => {
    // World-absolute opening: PlacementRelTo === null. Reassigning
    // would teleport it because the new wall's local frame is
    // different from the world frame.
    const fx = makeFixture();
    const opening1Placement = fx.entities.find((e) => e.expressId === fx.ids.opening1Placement)!;
    opening1Placement.attributes = [null, 240]; // PlacementRelTo null
    const editor = new StubStoreEditor(fx.entities);
    const view = new StubView() as unknown as Parameters<typeof reassignWallOpenings>[1];
    const store = makeStore(new Map([['IFCRELVOIDSELEMENT', [fx.ids.rel1]]]));
    const summary = reassignWallOpenings(
      store,
      view,
      editor as unknown as Parameters<typeof reassignWallOpenings>[2],
      fx.ids.sourceWall,
      fx.ids.leftWall,
      fx.ids.rightWall,
      2.5,
      fx.ids.leftPlacement,
      fx.ids.rightPlacement,
    );
    assert.strictEqual(summary.toLeft, 0);
    assert.strictEqual(summary.toRight, 0);
    assert.strictEqual(summary.skipped, 1);
    // Rel untouched.
    assert.strictEqual(editor.getNewEntity(fx.ids.rel1)?.attributes[4], fx.ids.sourceWall);
  });
});
