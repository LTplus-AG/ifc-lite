/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createStore } from 'zustand/vanilla';
import type { DxfUnderlay } from '@ifc-lite/drawing-2d';
import { createDrawing2DSlice, type Drawing2DSlice } from './drawing2DSlice.js';

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
