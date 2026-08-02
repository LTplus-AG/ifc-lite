/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Regression coverage for issue #1908: HBJSON export read the model's original
 * IFC bytes (`store.source`) instead of the mutation view, so anything
 * authored through the in-store edit APIs (the CLI equivalent of the viewer's
 * Space Sketch tool) was invisible to the exporter by construction.
 *
 * `bim.store.addSpace` is the same `StoreEditor` / `MutablePropertyView`
 * overlay the viewer's Space Sketch editor writes to (both go through
 * `StoreEditor` in `@ifc-lite/mutations`), so exercising it here proves the
 * headless/CLI export path, not just the viewer dialog.
 */

import { describe, it, expect, vi } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { MutablePropertyView, StoreEditor } from '@ifc-lite/mutations';
import { addSpaceToStore, resolveSpatialAnchor } from '@ifc-lite/create';
import { StepExporter } from '@ifc-lite/export';
import { GeometryProcessor } from '@ifc-lite/geometry';
import { createHeadlessContext } from './loader.js';
import { exportHbjson } from './hbjson-export.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
// Committed viewer demo sample (not the network-fetched tests/models/ fixture
// set) — always present, so this suite never needs `pnpm fixtures`. It ships
// one storey (#42) and one pre-existing IfcSpace ("My Space") whose Body is a
// Tessellation (IfcPolygonalFaceSet), not an extruded-area profile — rooms.rs
// only builds rooms from extrusion profiles (BRep/tessellated spaces are an
// explicit backlog item, out of scope for #1908), so that space is skipped
// for a reason unrelated to the mutation-view bug. It still exercises the
// exact real-world shape: a model with some rooms exportable and some not.
const SAMPLE_IFC = join(__dirname, '../../../apps/viewer/public/samples/hello-wall.ifc');
const STOREY_EXPRESS_ID = 42;
const WALL_EXPRESS_ID = 1222;

function roomCount(hbjson: string): number {
  const parsed = JSON.parse(hbjson) as { rooms?: unknown[] };
  return Array.isArray(parsed.rooms) ? parsed.rooms.length : 0;
}

describe('HeadlessBackend hbjson export (#1908)', () => {
  it('an unedited model (no mutation view) exports unchanged — the common case must not regress', async () => {
    const { bim } = await createHeadlessContext(SAMPLE_IFC);
    const hbjson = await bim.export.hbjson({ name: 'baseline' });
    // The one pre-existing space is a Tessellation body (see SAMPLE_IFC comment
    // above) and is skipped for a reason unrelated to #1908 — this asserts the
    // no-mutation-view path still runs `store.source` straight through, exactly
    // as before the fix, not that this particular space becomes a room.
    expect(roomCount(hbjson)).toBe(0);
  }, 30_000);

  it('a space drawn through the in-store editor is present in the HBJSON output', async () => {
    const { bim } = await createHeadlessContext(SAMPLE_IFC);
    const modelId = bim.model.activeId();
    expect(modelId).not.toBeNull();

    bim.store.addSpace(modelId as string, STOREY_EXPRESS_ID, {
      Position: [10, 10, 0],
      Width: 4,
      Depth: 3,
      Height: 3,
      LongName: 'Drawn Room',
    });

    const hbjson = await bim.export.hbjson({ name: 'edited' });
    // The newly drawn (extruded-profile) space becomes a room; the pre-existing
    // tessellated space stays skipped (unrelated, out of scope). Before the fix,
    // export read `store.source` directly and this overlay-only entity was
    // invisible to it, so this stayed at 0.
    expect(roomCount(hbjson)).toBe(1);
  }, 30_000);

  it('a mutation view that is registered but carries no edits exports unchanged — the common case', async () => {
    const { bim } = await createHeadlessContext(SAMPLE_IFC);
    const modelId = bim.model.activeId() as string;

    // `bim.store.removeEntity` on an id that exists in neither the parsed
    // store nor the overlay lazily registers a mutation view (any
    // `bim.store.*` call does, via `getOrCreateStoreEditor`) but
    // `StoreEditor.removeEntity` returns false *before* calling
    // `view.deleteEntity`, so no mutation is ever recorded — the same shape
    // as the viewer eagerly registering a `MutablePropertyView` when the
    // Properties panel / BulkPropertyEditor / DataConnector / ExportDialog
    // opens, with zero edits made. Gating on mere mutation-view existence
    // (rather than `hasPendingChanges()`) would route this export through a
    // redundant StepExporter regeneration.
    const removed = bim.store.removeEntity({ modelId, expressId: 999_999_999 });
    expect(removed).toBe(false);

    // roomCount alone would stay 0 whether or not the StepExporter regen
    // path runs (re-serializing an unedited overlay reproduces the same
    // rooms), so it would not catch a regression that drops the
    // `hasPendingChanges()` gate. Spy on `StepExporter.export` directly to
    // pin that the gate actually skips the regeneration.
    const exportSpy = vi.spyOn(StepExporter.prototype, 'export');
    try {
      const hbjson = await bim.export.hbjson({ name: 'registered-but-empty' });
      expect(roomCount(hbjson)).toBe(0);
      expect(exportSpy).not.toHaveBeenCalled();
    } finally {
      exportSpy.mockRestore();
    }
  }, 30_000);

  it('a space restored via restoreNewEntity (not freshly authored) is still present in the output', async () => {
    // `restoreNewEntity` (undo of delete-then-restore, called from
    // apps/viewer/src/store/slices/mutationSlice.ts) repopulates
    // `newEntities` WITHOUT pushing to `mutationHistory`. Since issue #1915,
    // `hasChanges()` reads the live overlay (the same footprint as
    // `hasPendingChanges()`) instead of the append-only history, so a view
    // built this way now reports `true` for both. A test that only exercises
    // `StoreEditor.addEntity` (like the "drawn through the in-store editor"
    // test above) would not catch a regression back to the history-based
    // reading; this one isolates the restore path specifically.
    const { store } = await createHeadlessContext(SAMPLE_IFC);

    // Build the space's entity graph (space, profile, rel aggregates, ...)
    // against a throwaway view/editor pair, exactly like `bim.store.addSpace`
    // does in headless-backend.ts, so ids allocate above this file's real max.
    const buildView = new MutablePropertyView(store.properties ?? null, 'default');
    const buildEditor = new StoreEditor(store, buildView);
    const anchor = resolveSpatialAnchor(store, STOREY_EXPRESS_ID);
    addSpaceToStore(buildEditor, anchor, {
      Position: [10, 10, 0],
      Width: 4,
      Depth: 3,
      Height: 3,
      LongName: 'Restored Room',
    });
    const createdEntities = buildView.getNewEntities();
    expect(createdEntities.length).toBeGreaterThan(0);

    // A *fresh* view that never called addEntity/deleteEntity on itself —
    // only restoreNewEntity, mirroring what the undo stack does after a
    // delete-then-restore (or, for the viewer, a session restore).
    const restoredView = new MutablePropertyView(store.properties ?? null, 'default');
    for (const entity of createdEntities) {
      restoredView.restoreNewEntity(entity);
    }
    expect(restoredView.hasChanges()).toBe(true);
    expect(restoredView.hasPendingChanges()).toBe(true);

    const hbjson = await exportHbjson(store, restoredView, 'restored');
    expect(roomCount(hbjson)).toBe(1);
  }, 30_000);

  it('a mutation unrelated to spaces (a renamed wall) does not change room output', async () => {
    const { bim } = await createHeadlessContext(SAMPLE_IFC);
    const modelId = bim.model.activeId() as string;

    // Positional index 2 on IFCWALL is Name (GlobalId, OwnerHistory, Name, ...).
    bim.store.setPositionalAttribute({ modelId, expressId: WALL_EXPRESS_ID }, 2, 'Renamed Wall');

    const hbjson = await bim.export.hbjson({ name: 'renamed-wall' });
    expect(roomCount(hbjson)).toBe(0);
  }, 30_000);

  it('disposes the GeometryProcessor WASM handle on the success path (#1956 review fix)', async () => {
    const { store } = await createHeadlessContext(SAMPLE_IFC);
    const disposeSpy = vi.spyOn(GeometryProcessor.prototype, 'dispose');
    try {
      await exportHbjson(store, null, 'dispose-success');
      expect(disposeSpy).toHaveBeenCalledTimes(1);
    } finally {
      disposeSpy.mockRestore();
    }
  }, 30_000);

  it('disposes the GeometryProcessor WASM handle even when exportHbjson throws (#1956 review fix)', async () => {
    // `GeometryProcessor.exportHbjson` returning null (engine unavailable)
    // makes `exportHbjson` in hbjson-export.ts throw. Stub the prototype
    // method to force that path deterministically — this is the early-return
    // the fix's try/finally must cover, not just the happy path.
    const { store } = await createHeadlessContext(SAMPLE_IFC);
    const disposeSpy = vi.spyOn(GeometryProcessor.prototype, 'dispose');
    const exportSpy = vi.spyOn(GeometryProcessor.prototype, 'exportHbjson').mockReturnValue(null);
    try {
      await expect(exportHbjson(store, null, 'dispose-throw')).rejects.toThrow(
        'Geometry engine unavailable for HBJSON export.',
      );
      expect(disposeSpy).toHaveBeenCalledTimes(1);
    } finally {
      exportSpy.mockRestore();
      disposeSpy.mockRestore();
    }
  }, 30_000);
});
