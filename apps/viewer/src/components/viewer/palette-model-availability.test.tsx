/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { MutablePropertyView, StoreEditor } from '@ifc-lite/mutations';
import { useViewerStore } from '@/store';
import { MODEL_ID, STOREY, UPPER_STOREY, seedModelingSession } from '@/test/modeling-session-fixture';
import { toGlobalIdFromModels } from '@/store/globalId';
import { clearCopyClipboard, readCopyClipboard, copySelectionToClipboard } from '@/lib/commands/modeling/copy-clipboard';
import { getCommandRuntime } from '@/lib/commands/modeling/runtime';
import { setRequestRemesh } from '@/lib/commands/modeling/transaction';
import { paletteSurfaceCommands } from './surface-commands';
import { canRunPaletteCommand } from './palette-availability';
import { paletteModelBlock } from './palette-model-availability';
import '@/lib/commands/modeling/builtin';

const original = useViewerStore.getState();
let restoreRemesh = () => {};
beforeEach(async () => {
  await seedModelingSession();
  useViewerStore.setState({ collabRole: null, canCollabEdit: () => true, selectedEntityId: null, selectedEntityIds: new Set(), selectedEntity: null });
  clearCopyClipboard();
  restoreRemesh = setRequestRemesh(() => {});
});
afterEach(() => { useViewerStore.getState().exitModelWorkspace(); restoreRemesh(); clearCopyClipboard(); useViewerStore.setState(original); });
function row(id: string) {
  const command = paletteSurfaceCommands({ canEditInSession: true }, () => {}).find(row => row.id === id);
  assert.ok(command, id);
  return command;
}
function column() {
  const s = useViewerStore.getState();
  const result = s.addColumn(MODEL_ID, STOREY, { Position: [1, 2, 0], Width: 0.3, Depth: 0.3, Height: 3 });
  assert.ok('expressId' in result);
  s.setSelectedEntityId(toGlobalIdFromModels(s.models, MODEL_ID, result.expressId));
  return result.expressId;
}

for (const [id, commandId] of [['tool:array', 'element.array'], ['tool:move', 'element.move'], ['tool:rotate', 'element.rotate']]) {
  test(`#8947 ${id} launches a real session and keeps whole-model positioning separate`, () => {
    column();
    const command = row(id);
    assert.equal(canRunPaletteCommand(command), true);
    command.action();
    assert.equal(useViewerStore.getState().workspaceMode, 'model');
    assert.equal(getCommandRuntime().command?.id, commandId);
    assert.equal(useViewerStore.getState().modelPlacement.preview, null);
  });
}

test('#8947 copy and paste-in-place use real clipboard and one undoable copy', () => {
  const source = column();
  useViewerStore.getState().enterModelWorkspace({ storeyId: STOREY });
  const copy = row('model:copy');
  assert.equal(canRunPaletteCommand(copy), true);
  copy.action();
  assert.deepEqual(readCopyClipboard()?.ids, [source]);
  const before = useViewerStore.getState().undoStacks.get(MODEL_ID)?.length ?? 0;
  const paste = row('model:paste-in-place');
  assert.equal(canRunPaletteCommand(paste), true);
  paste.action();
  const after = useViewerStore.getState();
  const added = after.undoStacks.get(MODEL_ID)?.slice(before) ?? [];
  assert.ok(added.length > 0, 'paste produces actual IFC mutations');
  const tags = new Set(added.map(mutation => after.mutationBatchTags.get(mutation.id)));
  assert.equal(tags.size, 1, 'all copied geometry belongs to one undo operation');
  assert.ok(!tags.has(undefined));
  const columns = () => useViewerStore.getState().mutationViews.get(MODEL_ID)!.getNewEntities()
    .filter(entity => entity.type.toUpperCase() === 'IFCCOLUMN'
      && !useViewerStore.getState().mutationViews.get(MODEL_ID)!.isDeleted(entity.expressId))
    .map(entity => entity.expressId);
  const copiedColumns = columns();
  assert.equal(copiedColumns.length, 2, 'the copied column is a live IFC product');
  assert.notEqual(after.selectedEntityId, source);
  after.undo(MODEL_ID);
  assert.deepEqual(columns(), [source], 'one undo removes the copied product and preserves its source');
  assert.equal(useViewerStore.getState().undoStacks.get(MODEL_ID)?.length, before);
  useViewerStore.getState().redo(MODEL_ID);
  assert.deepEqual(columns(), copiedColumns, 'one redo restores the same copied IFC product');
});

test('#8947 paste launches the cursor command; storey steps stop at bounds and exit cancels', () => {
  column();
  useViewerStore.getState().enterModelWorkspace({ storeyId: STOREY });
  row('model:copy').action();
  assert.equal(canRunPaletteCommand(row('model:paste')), true);
  row('model:paste').action();
  assert.equal(getCommandRuntime().command?.id, 'element.paste');
  assert.equal(canRunPaletteCommand(row('model:storey-down')), false);
  row('model:storey-up').action();
  assert.equal(useViewerStore.getState().session?.storeyId, UPPER_STOREY);
  assert.equal(canRunPaletteCommand(row('model:storey-up')), false);
  row('model:storey-down').action();
  assert.equal(useViewerStore.getState().session?.storeyId, STOREY);
  row('model:exit').action();
  assert.equal(useViewerStore.getState().session, null);
  assert.equal(getCommandRuntime().command, null);
});

test('#8947 live eligibility refuses lost targets, role, clipboard and workplane without entering workspace', () => {
  column();
  const move = row('tool:move');
  useViewerStore.setState({ selectedEntityId: null, selectedEntityIds: new Set() });
  assert.equal(canRunPaletteCommand(move), false);
  assert.equal(useViewerStore.getState().workspaceMode, 'view');
  assert.equal(canRunPaletteCommand(row('tool:column')), true, 'creators do not require selection');
  column();
  const active = row('tool:move');
  useViewerStore.setState({ collabRole: 'viewer', canCollabEdit: () => false });
  assert.equal(canRunPaletteCommand(active), false);
  useViewerStore.setState({ collabRole: null, canCollabEdit: () => true });
  assert.equal(paletteModelBlock('model:copy', useViewerStore.getState()), 'commandPalette.availability.workspace');
  useViewerStore.getState().enterModelWorkspace({ storeyId: STOREY });
  row('model:copy').action();
  const paste = row('model:paste');
  assert.equal(canRunPaletteCommand(paste), true);
  clearCopyClipboard();
  assert.equal(canRunPaletteCommand(paste), false);
  useViewerStore.setState({ session: { ...useViewerStore.getState().session!, workplane: null } });
  assert.equal(canRunPaletteCommand(active), false);
});

test('#8947 cold palette inspection does not register mutation state', () => {
  useViewerStore.setState({ mutationViews: new Map(), storeEditors: new Map() });
  useViewerStore.getState().setSelectedEntityId(130);
  const before = useViewerStore.getState();
  row('tool:array'); row('tool:move'); row('model:copy');
  const after = useViewerStore.getState();
  assert.equal(after.mutationViews, before.mutationViews);
  assert.equal(after.storeEditors.size, 0);
  assert.equal(after.session, null);
});

test('#8947 duplicate chrome entrypoints and context-only mutations do not create misleading rows', () => {
  const ids = paletteSurfaceCommands({ canEditInSession: true }, () => {}).map(row => row.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const id of ['ui:commands', 'view:theme', 'context:delete', 'context:duplicate', 'context:copy-global-id']) {
    assert.ok(!ids.includes(id), id);
  }
  assert.ok(ids.includes('pref:theme'), 'the shared theme operation is already present');
  assert.ok(ids.includes('elements:entity-actions'), 'context mutations are reached through their real destination');
});

// #8947 / review4510186236: count real index reads/allocator scans, not wall-clock timing.
test('#8947 cold copy availability shares inspection without registering editors', (t) => {
  useViewerStore.getState().setSelectedEntityId(130);
  useViewerStore.getState().enterModelWorkspace({ storeyId: STOREY });
  assert.equal(copySelectionToClipboard(useViewerStore.getState(), MODEL_ID).ok, true);
  useViewerStore.setState({ mutationViews: new Map(), storeEditors: new Map() });
  const s = useViewerStore.getState(), data = s.models.get(MODEL_ID)!.ifcDataStore!;
  const buckets = t.mock.method(data.entityIndex.byType, 'get');
  const watermark = t.mock.method(MutablePropertyView.prototype, 'setExpressIdWatermark');
  const scanCount = () => buckets.mock.calls.filter(call => call.arguments[0] === 'IFCRELFILLSELEMENT').length;
  for (let round = 0; round < 3; round++) {
    for (const id of ['model:copy', 'tool:array', 'model:paste', 'model:paste-in-place']) {
      assert.equal(paletteModelBlock(id, useViewerStore.getState()), null, id);
    }
    assert.equal(scanCount(), 1, 'one shared relationship-index construction for four checks');
    assert.equal(watermark.mock.callCount(), 1, 'one cold editor construction, not one per command');
  }
  assert.equal(useViewerStore.getState().mutationViews, s.mutationViews);
  assert.equal(useViewerStore.getState().storeEditors, s.storeEditors);
  assert.equal(s.mutationViews.size, 0); assert.equal(s.storeEditors.size, 0);
});

test('#8947 copy inspection invalidates live identities and revisions while activation stays live', (t) => {
  const source = column();
  useViewerStore.getState().enterModelWorkspace({ storeyId: STOREY });
  assert.equal(copySelectionToClipboard(useViewerStore.getState(), MODEL_ID).ok, true);
  const data = useViewerStore.getState().models.get(MODEL_ID)!.ifcDataStore!;
  const buckets = t.mock.method(data.entityIndex.byType, 'get');
  const scans = () => buckets.mock.calls.filter(call => call.arguments[0] === 'IFCRELFILLSELEMENT').length;
  const check = () => paletteModelBlock('model:paste-in-place', useViewerStore.getState());
  assert.equal(check(), null);
  let count = scans(); assert.ok(count > 0);
  assert.equal(check(), null); assert.equal(scans(), count);
  const view = useViewerStore.getState().mutationViews.get(MODEL_ID)!;
  // Same history-independent revision changes even without a store version bump.
  view.deleteEntity(source);
  assert.equal(check(), 'copyArray.paste.stale'); assert.equal(scans(), ++count);
  assert.equal(check(), 'copyArray.paste.stale'); assert.equal(scans(), count);
  const freshView = new MutablePropertyView(data.properties || null, MODEL_ID);
  const freshEditor = new StoreEditor(data, freshView);
  useViewerStore.setState({ mutationViews: new Map([[MODEL_ID, freshView]]), storeEditors: new Map([[MODEL_ID, freshEditor]]) });
  assert.equal(check(), 'copyArray.paste.stale'); assert.equal(scans(), ++count);
  useViewerStore.setState({ storeEditors: new Map([[MODEL_ID, new StoreEditor(data, freshView)]]) });
  assert.equal(check(), 'copyArray.paste.stale'); assert.equal(scans(), ++count);
  useViewerStore.getState().bumpMutationVersion();
  assert.equal(check(), 'copyArray.paste.stale'); assert.equal(scans(), ++count);
  const model = useViewerStore.getState().models.get(MODEL_ID)!;
  useViewerStore.setState({ models: new Map([[MODEL_ID, { ...model, ifcDataStore: { ...data } }]]) });
  assert.equal(check(), 'copyArray.paste.stale'); assert.equal(scans(), ++count);
  useViewerStore.getState().setSelectedEntityId(130);
  assert.equal(copySelectionToClipboard(useViewerStore.getState(), MODEL_ID).ok, true);
  assert.equal(check(), null, 'replacement source and clipboard are used live');
  const command = row('model:paste-in-place');
  assert.equal(canRunPaletteCommand(command), true);
  freshView.deleteEntity(130);
  const before = freshView.getNewEntities().length;
  command.action();
  assert.equal(freshView.getNewEntities().length, before, 'activation refuses the now-deleted clipboard source');
  assert.equal(check(), 'copyArray.paste.stale');
});
