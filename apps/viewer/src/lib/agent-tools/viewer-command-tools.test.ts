/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resetFeaturesForTest } from '@/lib/features';
import { useViewerStore } from '@/store';
import { registerAgentCommandHost, getAgentCommandHost } from '@/lib/agent-bridge/command-host';
import { paletteSurfaceCommands } from '@/components/viewer/surface-commands';
import type { Command } from '@/components/viewer/commandPaletteSearch';
import { model, parseHelloWall, seed, viewerHost, WALL_ID } from '@/test/agent-tools-fixture';
import { dispatchMainViewerTool } from './main-viewer-dispatch';

const cleanups: Array<() => void> = [];
const register = (commands: readonly Command[]) => {
  const cleanup = registerAgentCommandHost(() => commands);
  cleanups.push(cleanup);
  return cleanup;
};
const rows = () => paletteSurfaceCommands({ canEditInSession: true }, () => {}, {
  activateRightPanel: panel => { useViewerStore.getState().showWorkspacePanel(panel, 'palette'); },
  activateBottomPanel: panel => { useViewerStore.getState().showWorkspacePanel(panel, 'palette'); },
});
const run = (name: string, args: Record<string, unknown> = {}, canEdit = () => true, signal?: AbortSignal) =>
  dispatchMainViewerTool(viewerHost(), name, args, { canEdit, signal });
const invoke = (command_id: string, canEdit = () => true) => run('viewer_command_run', { command_id }, canEdit);
const currentSelection = () => useViewerStore.getState().selectedEntityIds;

beforeEach(async () => {
  seed([model('hello', await parseHelloWall())]);
  useViewerStore.setState({ selectedEntityId: null, selectedEntityIds: new Set(),
    selectedEntity: null, selectedEntitiesSet: new Set(), cameraCallbacks: {}, collabRole: null, loading: false });
});
afterEach(() => { resetFeaturesForTest(); cleanups.reverse().forEach(cleanup => cleanup()); cleanups.length = 0; });

describe('palette bridge commands: native actions and hostile callers', () => {
  it('fails explicitly without the mounted host, even with permission', async () => {
    assert.equal((await invoke('view:fit')).errorCode, 'UNSUPPORTED_OPERATION');
    assert.equal((await run('viewer_commands')).errorCode, 'UNSUPPORTED_OPERATION');
  });

  it('discovers real palette features with bounded pages and exact-id inspection', async () => {
    register(rows());
    const page = await run('viewer_commands', { limit: 2 });
    assert.equal(page.isError, false, page.text);
    const result = page.structured as { total: number; next_offset: number; commands: unknown[] };
    assert.ok(result.total > 30);
    assert.equal(result.commands.length, 2);
    assert.equal(result.next_offset, 2);
    const exact = await run('viewer_commands', { command_id: 'view:fit' });
    assert.match(exact.text, /camera/);
    assert.match(exact.text, /dispatch-only/);
  });

  it('ranks natural-language queries and hints when nothing matches', async () => {
    register(rows());
    const ranked = (await run('viewer_commands', { query: 'zoom to fit the whole model', limit: 3 })).structured as {
      commands: Array<{ command_id: string }>; hint?: string };
    assert.ok(ranked.commands.some(command => command.command_id === 'view:fit'), JSON.stringify(ranked.commands));
    assert.equal(ranked.hint, undefined);
    const none = (await run('viewer_commands', { query: 'qqqxyzzy' })).structured as { total: number; hint: string };
    assert.equal(none.total, 0);
    assert.match(none.hint, /View/);
    const unknown = (await run('viewer_commands', { command_id: 'view:fitt' })).structured as { hint: string };
    assert.match(unknown.hint, /view:fit/);
  });

  it('uses the same camera action as the palette, and refuses absent callbacks', async () => {
    register(rows());
    assert.equal((await invoke('view:fit')).errorCode, 'UNSUPPORTED_OPERATION');
    let fits = 0;
    useViewerStore.setState({ cameraCallbacks: { fitAll: () => { fits++; } } });
    assert.equal((await invoke('view:fit')).isError, false);
    assert.equal(fits, 1);
    useViewerStore.setState({ cameraCallbacks: {} });
    assert.equal((await invoke('view:fit')).errorCode, 'UNSUPPORTED_OPERATION');
    assert.equal(fits, 1);
  });

  it('selects the real IFC wall through both native selection channels, then hides it', async () => {
    register(rows());
    const selected = await run('viewer_select', { model_id: 'hello', express_ids: [WALL_ID] });
    assert.equal(selected.isError, false, selected.text);
    assert.ok(currentSelection().has(WALL_ID));
    assert.equal(useViewerStore.getState().selectedEntity?.expressId, WALL_ID);
    const read = await run('viewer_get_selection');
    assert.deepEqual(read.structured, { selection: [{ modelId: 'hello', expressId: WALL_ID }] });
    const hidden = await invoke('vis:hide');
    assert.equal(hidden.isError, false, hidden.text);
    assert.ok(useViewerStore.getState().hiddenEntities.has(WALL_ID));
  });

  it('validates an entire selection before changing it; fabricated and cross-model ids cannot partially select', async () => {
    // The real hello-wall storey differs from the first id in the invalid request.
    const seeded = await run('viewer_select', { express_ids: [42] });
    assert.equal(seeded.isError, false, seeded.text);
    const snapshot = () => {
      const state = useViewerStore.getState();
      return { ids: new Set(state.selectedEntityIds), id: state.selectedEntityId,
        ref: state.selectedEntity && { ...state.selectedEntity },
        refs: new Set(state.selectedEntitiesSet) };
    };
    const before = snapshot();
    assert.equal(before.id, 42);
    assert.deepEqual(before.ref, { modelId: 'hello', expressId: 42 });
    for (const args of [
      { express_ids: [WALL_ID, 999999] }, { express_ids: [String(WALL_ID)] },
      { model_id: 'missing', express_ids: [WALL_ID] }, { express_ids: [-1] },
      { express_ids: [1.5] }, { express_ids: [NaN] }, { express_ids: [Infinity] },
      { express_ids: Array(1001).fill(WALL_ID) },
    ]) {
      assert.equal((await run('viewer_select', args)).isError, true);
      assert.deepEqual(snapshot(), before, 'both numeric and property selection channels remain unchanged');
    }
  });

  it('requires model_id for federation, with no active-model guessing', async () => {
    seed([model('a', await parseHelloWall()), model('b', await parseHelloWall(), { idOffset: 200000 })]);
    assert.equal((await run('viewer_select', { express_ids: [WALL_ID] })).isError, true);
    const selected = await run('viewer_select', { model_id: 'b', express_ids: [WALL_ID] });
    assert.equal(selected.isError, false, selected.text);
    assert.deepEqual((await run('viewer_get_selection')).structured, { selection: [{ modelId: 'b', expressId: WALL_ID }] });
  });

  it('refuses commands and selection without the grant, even when a hostile bridge forwards them', async () => {
    register(rows());
    const projection = useViewerStore.getState().projectionMode;
    assert.equal((await invoke('view:projection', () => false)).errorCode, 'READ_ONLY');
    assert.equal((await dispatchMainViewerTool(viewerHost(), 'viewer_command_run', { command_id: 'view:projection' })).errorCode, 'READ_ONLY');
    assert.equal((await run('viewer_select', { express_ids: [WALL_ID] }, () => false)).errorCode, 'READ_ONLY');
    assert.equal(useViewerStore.getState().projectionMode, projection);
    assert.equal(currentSelection().size, 0);
  });

  it('checks revocation after a command prerequisite callback and before the action', async () => {
    let granted = true;
    const projection = useViewerStore.getState().projectionMode;
    const native = rows().find(row => row.id === 'view:projection')!;
    register([{ ...native, checkAvailability: () => { granted = false; return { status: 'available' }; } }]);
    assert.equal((await invoke(native.id, () => granted)).errorCode, 'READ_ONLY');
    assert.equal(useViewerStore.getState().projectionMode, projection);
  });

  it('rejects a stale host replaced during a prerequisite callback', async () => {
    const native = rows().find(row => row.id === 'view:projection')!;
    register([{ ...native, checkAvailability: () => { register([]); return { status: 'available' }; } }]);
    assert.equal((await invoke(native.id)).errorCode, 'STATE_CHANGED');
  });

  it('an old owner cannot unregister its replacement', () => {
    const old = register(rows());
    const replacement = register([]);
    const host = getAgentCommandHost();
    old();
    assert.equal(getAgentCommandHost(), host);
    replacement();
    assert.equal(getAgentCommandHost(), null);
  });

  it('never turns a command without live prerequisites into an executable action', async () => {
    const native = rows().find(row => row.id === 'view:projection')!;
    register([{ ...native, checkAvailability: undefined }]);
    assert.equal((await invoke(native.id)).errorCode, 'UNSUPPORTED_OPERATION');
  });

  it('rechecks host feature gates even for a command captured before the feature was disabled', async () => {
    register(rows());
    resetFeaturesForTest({ default: 'all', disable: ['check.clash'] });
    assert.equal((await invoke('panel:clash')).errorCode, 'UNSUPPORTED_OPERATION');
    const discovery = await run('viewer_commands', { command_id: 'panel:clash' });
    assert.match(discovery.text, /availability.feature/);
  });

  it('refuses ambiguous command ids rather than choosing a handler', async () => {
    const native = rows().find(row => row.id === 'view:projection')!;
    const projection = useViewerStore.getState().projectionMode;
    register([native, native]);
    assert.equal((await invoke(native.id)).errorCode, 'INVALID_INPUT');
    assert.equal(useViewerStore.getState().projectionMode, projection);
  });

  it('does not claim file pickers opened without transient user activation', async () => {
    register(rows());
    const result = await invoke('file:open');
    assert.equal(result.errorCode, 'UNSUPPORTED_OPERATION');
    assert.match(result.text, /user gesture/);
  });

  it('does not run a cancelled call or reinterpret code, selectors, prototypes or extra inputs', async () => {
    register(rows());
    const projection = useViewerStore.getState().projectionMode;
    for (const args of [
      { command_id: '__proto__' }, { command_id: 'constructor' }, { command_id: 'view:projection', code: 'throw 1' },
      { command_id: 'view:projection', args: { value: 1 } }, { command_id: 2 }, { command_id: '' },
    ]) assert.equal((await run('viewer_command_run', args)).errorCode, 'INVALID_INPUT');
    const controller = new AbortController(); controller.abort();
    assert.equal((await run('viewer_command_run', { command_id: 'view:projection' }, () => true, controller.signal)).isError, true);
    assert.equal(useViewerStore.getState().projectionMode, projection);
  });

  it('rejects unbounded and malformed discovery inputs', async () => {
    register(rows());
    for (const args of [{ limit: null }, { limit: -1 }, { limit: 51 }, { offset: 0.5 }, { offset: Infinity },
      { query: {} }, { query: 'x'.repeat(201) }, { unknown: true }]) {
      assert.equal((await run('viewer_commands', args)).errorCode, 'INVALID_INPUT');
    }
  });

  it('reports dispatch without asserting completion of an interactive workflow', async () => {
    register(rows());
    const result = await invoke('panel:clash');
    assert.equal(result.isError, false, result.text);
    assert.equal(useViewerStore.getState().clashPanelVisible, true);
    assert.match(result.text, /dispatched/);
    assert.match(result.text, /does not assert workflow completion/);
  });
});
