/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Unit coverage for the #1908 fix's routing decision logic. The end-to-end
 * behaviour (StepExporter actually regenerating bytes that include
 * overlay-authored entities) is exercised for real by
 * `packages/cli/src/headless-backend.hbjson.test.ts`, which shares the same
 * `StepExporter` + `GeometryProcessor` pipeline this dialog calls into — this
 * suite covers only the branching that decides which bytes source to use.
 * The dialog itself is exercised in `HbjsonExportDialog.test.tsx` against the
 * happy-dom harness (`src/test/setup-dom.ts`); keeping the branch logic in a
 * plain module keeps these cases readable without rendering anything.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { MutablePropertyView, StoreEditor, type MutationStoreShape, type NewEntity } from '@ifc-lite/mutations';
import { resolveHbjsonMutationSource, type HbjsonSourceStore } from './hbjson-export-source.js';

function makeStore(): HbjsonSourceStore & { source: Uint8Array } {
  return { source: new Uint8Array([1, 2, 3]), schemaVersion: 'IFC4' };
}

// Minimal StoreEditor-compatible shape (mirrors packages/create's space.test.ts).
function makeMutationStore(maxId: number): MutationStoreShape {
  const byId = new Map();
  for (let id = 1; id <= maxId; id++) {
    byId.set(id, { expressId: id, type: 'IFCDUMMY', byteOffset: 0, byteLength: 1, lineNumber: id });
  }
  return { entityIndex: { byId } };
}

describe('resolveHbjsonMutationSource', () => {
  it('returns null (raw-bytes path) when there is no mutation view', () => {
    const store = makeStore();
    const result = resolveHbjsonMutationSource({ mutationView: null, dataStore: store, schemaVersion: 'IFC4' });
    assert.strictEqual(result, null);
  });

  it('returns null when the mutation view is registered but carries no edits — the common case', () => {
    // Opening the Properties panel, BulkPropertyEditor, DataConnector, or
    // ExportDialog all construct-and-register a MutablePropertyView with zero
    // edits. Gating on mere existence (rather than hasPendingChanges()) would
    // route every later export through a StepExporter regeneration just
    // because some panel had been opened.
    const store = makeStore();
    const view = new MutablePropertyView(null, 'm1');
    assert.strictEqual(view.hasPendingChanges(), false);
    const result = resolveHbjsonMutationSource({ mutationView: view, dataStore: store, schemaVersion: 'IFC4' });
    assert.strictEqual(result, null);
  });

  it('resolves the regeneration path for an entity restored via restoreNewEntity, not just freshly authored', () => {
    // restoreNewEntity (undo of delete-then-restore, called from
    // apps/viewer/src/store/slices/mutationSlice.ts) repopulates
    // `newEntities` WITHOUT pushing to `mutationHistory` — so `hasChanges()`
    // (append-only history) would read false here even though the overlay
    // genuinely carries a new IfcSpace. A test that only exercises
    // StoreEditor.addEntity (like the one above) passes under either
    // `hasChanges()` or `hasPendingChanges()` and would not catch a
    // regression back to the former; this one isolates the restore path.
    const store = makeStore();
    const restored: NewEntity = { expressId: 500, type: 'IfcSpace', attributes: ['guid', null, 'Restored Space'] };
    const view = new MutablePropertyView(null, 'm1');
    view.restoreNewEntity(restored);
    assert.strictEqual(view.hasChanges(), false);
    assert.strictEqual(view.hasPendingChanges(), true);
    const result = resolveHbjsonMutationSource({ mutationView: view, dataStore: store, schemaVersion: 'IFC4' });
    assert.notStrictEqual(result, null);
  });

  it('returns null when there is no data store', () => {
    // Must carry real edits so hasPendingChanges() is true and execution
    // actually reaches the `!dataStore` branch — otherwise the earlier
    // hasPendingChanges() short-circuit returns null regardless of the
    // `!dataStore` check, and this test would pass even if that guard were
    // deleted entirely.
    const view = new MutablePropertyView(null, 'm1');
    const editor = new StoreEditor(makeMutationStore(40), view);
    editor.addEntity('IfcSpace', ['guid', null, 'New Space']);
    assert.strictEqual(view.hasPendingChanges(), true);
    const result = resolveHbjsonMutationSource({ mutationView: view, dataStore: null, schemaVersion: 'IFC4' });
    assert.strictEqual(result, null);
  });

  it('returns null for IFC5/IFCX (no STEP representation to regenerate), even with real edits', () => {
    const store = makeStore();
    const view = new MutablePropertyView(null, 'm1');
    const editor = new StoreEditor(makeMutationStore(40), view);
    editor.addEntity('IfcSpace', ['guid', null, 'New Space']);
    assert.strictEqual(view.hasChanges(), true);
    const result = resolveHbjsonMutationSource({ mutationView: view, dataStore: store, schemaVersion: 'IFC5' });
    assert.strictEqual(result, null);
  });

  it('returns null when source bytes were not retained (avoids a degenerate StepExporter regen), even with real edits', () => {
    const store = { ...makeStore(), source: new Uint8Array(0) };
    const view = new MutablePropertyView(null, 'm1');
    const editor = new StoreEditor(makeMutationStore(40), view);
    editor.addEntity('IfcSpace', ['guid', null, 'New Space']);
    const result = resolveHbjsonMutationSource({ mutationView: view, dataStore: store, schemaVersion: 'IFC4' });
    assert.strictEqual(result, null);
  });

  it('resolves the mutation-view regeneration path when the view has real edits + source + a STEP schema', () => {
    const store = makeStore();
    const view = new MutablePropertyView(null, 'm1');
    const editor = new StoreEditor(makeMutationStore(40), view);
    editor.addEntity('IfcSpace', ['guid', null, 'New Space']);
    const result = resolveHbjsonMutationSource({ mutationView: view, dataStore: store, schemaVersion: 'IFC4' });
    assert.notStrictEqual(result, null);
    assert.strictEqual(result?.dataStore, store);
    assert.strictEqual(result?.mutationView, view);
  });
});
