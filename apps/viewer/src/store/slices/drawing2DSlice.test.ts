/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createStore } from 'zustand/vanilla';
import type { DxfUnderlay } from '@ifc-lite/drawing-2d';
import { createDrawing2DSlice, type Drawing2DSlice } from './drawing2DSlice.js';
import { generateCloudArcs } from '../../components/viewer/tools/cloudPathGenerator.js';

const makeStore = () => createStore<Drawing2DSlice>(createDrawing2DSlice);

const makeUnderlay = (): DxfUnderlay => ({
  name: 'test.dxf',
  layers: [],
  bounds: { min: { x: 0, y: 0 }, max: { x: 10, y: 10 } },
  unitScale: 1,
  skipped: {},
  warnings: [],
});

// PR #1965 review, item 1: `georeferenced` is tri-state (`true`/`false`
// explicit, `undefined` "auto"). The invariant that must never break: an
// entry created WITHOUT explicitly opting into 'auto' can never end up
// auto -- only `ingestDxfFile`'s own call site does that, so anything else
// constructing an entry (a hypothetical future load/migration path for
// entries that predate this field, a test fixture, another call site)
// stays conservative by construction.
describe('drawing2DSlice.addDxfUnderlay (PR #1965 review: tri-state georeferenced seeding)', () => {
  it('defaults to explicit false (never auto) when options are omitted entirely', () => {
    const s = makeStore();
    const id = s.getState().addDxfUnderlay(makeUnderlay());
    const entry = s.getState().dxfUnderlays.find((u) => u.id === id);
    assert.strictEqual(entry?.georeferenced, false);
  });

  it('defaults to explicit false when options.georeferenced is omitted', () => {
    const s = makeStore();
    const id = s.getState().addDxfUnderlay(makeUnderlay(), {});
    const entry = s.getState().dxfUnderlays.find((u) => u.id === id);
    assert.strictEqual(entry?.georeferenced, false);
  });

  it('stores true/false verbatim when the caller passes them explicitly', () => {
    const s = makeStore();
    const onId = s.getState().addDxfUnderlay(makeUnderlay(), { georeferenced: true });
    const offId = s.getState().addDxfUnderlay(makeUnderlay(), { georeferenced: false });
    assert.strictEqual(s.getState().dxfUnderlays.find((u) => u.id === onId)?.georeferenced, true);
    assert.strictEqual(s.getState().dxfUnderlays.find((u) => u.id === offId)?.georeferenced, false);
  });

  it("stores 'auto' as undefined -- ONLY reachable by explicitly requesting it", () => {
    const s = makeStore();
    const id = s.getState().addDxfUnderlay(makeUnderlay(), { georeferenced: 'auto' });
    const entry = s.getState().dxfUnderlays.find((u) => u.id === id);
    assert.strictEqual(entry?.georeferenced, undefined);
    assert.ok('georeferenced' in (entry ?? {}), 'the field itself is still present, just undefined');
  });

  it('setDxfUnderlayGeoreferenced always writes an explicit boolean, never undefined -- the user-touch escape hatch out of auto mode', () => {
    const s = makeStore();
    const id = s.getState().addDxfUnderlay(makeUnderlay(), { georeferenced: 'auto' });
    s.getState().setDxfUnderlayGeoreferenced(id, true);
    assert.strictEqual(s.getState().dxfUnderlays.find((u) => u.id === id)?.georeferenced, true);
    s.getState().setDxfUnderlayGeoreferenced(id, false);
    assert.strictEqual(s.getState().dxfUnderlays.find((u) => u.id === id)?.georeferenced, false);
  });
});

// SectionPanel.tsx's "View 2D" button calls clearDrawing2D() purely to force
// regeneration with current settings (see the comment at its call site).
// clearDrawing2D used to `set(getDefaultState())`, wiping the ENTIRE slice --
// graphic overrides, DXF underlays, and all annotations -- exactly like the
// `clearSheet` whole-state-default defect (sheetSlice.ts:180). It must only
// reset the drawing-generation fields.
describe('drawing2DSlice.clearDrawing2D (regression: must not wipe unrelated slice state)', () => {
  it('resets drawing-generation fields but leaves overrides, DXF underlays, and annotations untouched', () => {
    const s = makeStore();
    s.getState().addCustomRule({
      id: 'r1', name: 'rule 1', priority: 1, enabled: true,
      criteria: { logic: 'and', conditions: [] }, style: {},
    });
    s.getState().setOverridesEnabled(false);
    s.getState().addTextAnnotation2D({
      id: 't1', position: { x: 0, y: 0 }, text: 'hello',
      fontSize: 14, color: '#000', backgroundColor: '#fff', borderColor: '#000',
    });
    s.getState().addDxfUnderlay(makeUnderlay());
    s.getState().setDrawing2D({} as never);

    s.getState().clearDrawing2D();

    const state = s.getState();
    assert.strictEqual(state.drawing2D, null);
    assert.strictEqual(state.drawing2DStatus, 'idle');
    assert.strictEqual(state.customOverrideRules.length, 1, 'clearDrawing2D must not wipe custom override rules');
    assert.strictEqual(state.overridesEnabled, false, 'clearDrawing2D must not reset overridesEnabled');
    assert.strictEqual(state.textAnnotations2D.length, 1, 'clearDrawing2D must not wipe text annotations');
    assert.strictEqual(state.dxfUnderlays.length, 1, 'clearDrawing2D must not wipe DXF underlays');
  });
});

// Issue #2043: `visible` (2D) and `visible3D` (3D) are independent toggles,
// both defaulting to on -- the issue's explicit "default to visible in both
// 2D and 3D" requirement, and a load-time-only 2D-vs-3D choice was rejected.
describe('drawing2DSlice: independent 2D/3D DXF underlay visibility (issue #2043)', () => {
  it('addDxfUnderlay defaults both visible and visible3D to true', () => {
    const s = makeStore();
    const id = s.getState().addDxfUnderlay(makeUnderlay());
    const entry = s.getState().dxfUnderlays.find((u) => u.id === id);
    assert.strictEqual(entry?.visible, true);
    assert.strictEqual(entry?.visible3D, true);
  });

  it('setDxfUnderlayVisible3D flips only visible3D, leaving visible untouched', () => {
    const s = makeStore();
    const id = s.getState().addDxfUnderlay(makeUnderlay());
    s.getState().setDxfUnderlayVisible3D(id, false);
    let entry = s.getState().dxfUnderlays.find((u) => u.id === id);
    assert.strictEqual(entry?.visible3D, false);
    assert.strictEqual(entry?.visible, true);

    s.getState().setDxfUnderlayVisible(id, false);
    entry = s.getState().dxfUnderlays.find((u) => u.id === id);
    assert.strictEqual(entry?.visible, false);
    assert.strictEqual(entry?.visible3D, false, 'toggling 2D must not touch the already-off 3D flag');
  });
});

// Issue #4197: completeMeasure2D already rejects a degenerate (near-zero
// length) measurement via MIN_MEASUREMENT_DISTANCE, but completePolygonArea2D
// and completeCloudAnnotation2D only checked point *count*, not size. Three
// coincident clicks passed the `points.length < 3` check and stored a
// polygon with area 0 (rendered as a permanent "0.0 cm2" label); a
// zero-size cloud passed `points.length < 2` and was stored but rendered as
// nothing (cloudPathGenerator.ts skips edges under 0.001), leaving an
// invisible-but-selectable, localStorage-persisted annotation.
describe('drawing2DSlice: degenerate polygon/cloud rejection (issue #4197)', () => {
  it('completePolygonArea2D discards a coincident-point polygon (area ~0) instead of storing it', () => {
    const s = makeStore();
    const { addPolygonArea2DPoint, completePolygonArea2D } = s.getState();
    // Three clicks at (nearly) the same point -- a real user mis-click, not
    // a synthetic zero.
    addPolygonArea2DPoint({ x: 1, y: 1 });
    addPolygonArea2DPoint({ x: 1, y: 1 });
    addPolygonArea2DPoint({ x: 1, y: 1 });
    completePolygonArea2D(0, 0);
    assert.strictEqual(
      s.getState().polygonArea2DResults.length,
      0,
      'a zero-area polygon must not be stored'
    );
    assert.deepStrictEqual(
      s.getState().polygonArea2DPoints,
      [],
      'in-progress points must still be reset on rejection, mirroring completeMeasure2D'
    );
  });

  it('completePolygonArea2D discards a collinear-point polygon (area ~0) the same way', () => {
    const s = makeStore();
    const { addPolygonArea2DPoint, completePolygonArea2D } = s.getState();
    // Three collinear points: zero area despite being three *distinct* clicks.
    addPolygonArea2DPoint({ x: 0, y: 0 });
    addPolygonArea2DPoint({ x: 1, y: 0 });
    addPolygonArea2DPoint({ x: 2, y: 0 });
    completePolygonArea2D(0, 2);
    assert.strictEqual(
      s.getState().polygonArea2DResults.length,
      0,
      'a collinear (zero-area) polygon must not be stored'
    );
  });

  it('completePolygonArea2D still accepts a legitimate small polygon a user could plausibly draw', () => {
    const s = makeStore();
    const { addPolygonArea2DPoint, completePolygonArea2D } = s.getState();
    // A 0.1m x 0.1m square (10cm x 10cm) -- small but real, e.g. a stud or
    // a detail callout. Area = 0.01 m^2, perimeter = 0.4 m.
    addPolygonArea2DPoint({ x: 0, y: 0 });
    addPolygonArea2DPoint({ x: 0.1, y: 0 });
    addPolygonArea2DPoint({ x: 0.1, y: 0.1 });
    addPolygonArea2DPoint({ x: 0, y: 0.1 });
    completePolygonArea2D(0.01, 0.4);
    assert.strictEqual(s.getState().polygonArea2DResults.length, 1, 'a real small polygon must still be accepted');
    assert.strictEqual(s.getState().polygonArea2DResults[0]?.area, 0.01);
  });

  it('completeCloudAnnotation2D discards a zero-size cloud (both points identical) instead of storing it', () => {
    const s = makeStore();
    const { addCloudAnnotation2DPoint, completeCloudAnnotation2D } = s.getState();
    addCloudAnnotation2DPoint({ x: 2, y: 2 });
    addCloudAnnotation2DPoint({ x: 2, y: 2 });
    completeCloudAnnotation2D('note');
    assert.strictEqual(
      s.getState().cloudAnnotations2D.length,
      0,
      'a zero-size (invisible) cloud must not be stored'
    );
    assert.deepStrictEqual(
      s.getState().cloudAnnotation2DPoints,
      [],
      'in-progress points must still be reset on rejection, mirroring completeMeasure2D'
    );
  });

  it('completeCloudAnnotation2D still accepts a legitimate small cloud a user could plausibly draw', () => {
    const s = makeStore();
    const { addCloudAnnotation2DPoint, completeCloudAnnotation2D } = s.getState();
    // A 0.05m x 0.05m (5cm) cloud around a small detail -- small but real.
    addCloudAnnotation2DPoint({ x: 0, y: 0 });
    addCloudAnnotation2DPoint({ x: 0.05, y: 0.05 });
    completeCloudAnnotation2D('detail');
    assert.strictEqual(s.getState().cloudAnnotations2D.length, 1, 'a real small cloud must still be accepted');
  });

  // isDegenerateCloud rejects only when BOTH bounding-box dimensions are
  // below threshold (Math.max of width/height). A 5m x 0m cloud has one
  // zero dimension but one very real 5m dimension: cloudPathGenerator only
  // skips the two zero-length edges, the two 5m edges still produce arcs,
  // so this cloud is visible and must be accepted. Using Math.min instead
  // of Math.max would falsely reject it -- nothing else in this file
  // exercises the asymmetric (one-flat-dimension) case, so a future
  // max-to-min edit would pass every other test here.
  it('completeCloudAnnotation2D accepts a cloud with one zero dimension and one real dimension (5m x 0m), and it renders', () => {
    const s = makeStore();
    const { addCloudAnnotation2DPoint, completeCloudAnnotation2D } = s.getState();
    addCloudAnnotation2DPoint({ x: 0, y: 0 });
    addCloudAnnotation2DPoint({ x: 5, y: 0 });
    completeCloudAnnotation2D('flat-edge');
    assert.strictEqual(
      s.getState().cloudAnnotations2D.length,
      1,
      'a 5m x 0m cloud has a real 5m dimension and must be accepted, not treated as degenerate'
    );

    const [p1, p2] = s.getState().cloudAnnotations2D[0]!.points;
    const arcs = generateCloudArcs(p1!, p2!, 0.2);
    assert.ok(arcs.length > 0, 'the two 5m edges must still produce renderable arcs even though the other two edges are zero-length');
  });
});
