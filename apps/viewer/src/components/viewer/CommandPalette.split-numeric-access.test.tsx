/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { act, useState } from 'react';
import { createBimContext } from '@ifc-lite/sdk';
import { BimReactContext } from '@/sdk/BimProvider';
import { LocalBackend } from '@/sdk/local-backend';
import { useViewerStore } from '@/store';
import { toGlobalIdFromModels } from '@/store/globalId';
import { MODEL_ID, STOREY, seedModelingSession } from '@/test/modeling-session-fixture';
import { cleanup, click, press, type as typeInto, waitFor } from '@/test/render';
import { getLocale, setLocale } from '@/i18n';
import { en } from '@/i18n/en';
import { commandPointerMove, getCommandRuntime } from '@/lib/commands/modeling/runtime';
import type { SplitGesture } from '@/lib/commands/modeling/commands/element-split';
import { setRequestRemesh } from '@/lib/commands/modeling/transaction';
import { ViewportHud } from '../viewport-ui/hud/ViewportHud';
import { renderScene } from '../viewport-ui/scene/test/scene-test-support';
import { CommandBar, CommandScene } from './tools/command/CommandHud';
import { CommandPalette } from './CommandPalette';
import '@/lib/commands/modeling/builtin';

// #8947 C1243: real palette, command runtime and scene host over parsed IFC.
// The shared scene harness supplies projection only; this is not GPU evidence.
const initial = useViewerStore.getState();
const locale = getLocale();
const sdk = createBimContext({ backend: new LocalBackend(useViewerStore) });
let restoreRemesh = () => {};
beforeEach(async () => {
  setLocale('en'); localStorage.clear();
  await seedModelingSession();
  restoreRemesh = setRequestRemesh(() => {});
  useViewerStore.setState({ collabRole: null, canCollabEdit: () => true,
    selectedEntityId: null, selectedEntityIds: new Set(), selectedEntity: null });
});
afterEach(() => {
  act(() => useViewerStore.getState().exitModelWorkspace());
  cleanup(); restoreRemesh();
  useViewerStore.setState(initial, true); setLocale(locale); localStorage.clear();
});
function Harness() {
  const [open, setOpen] = useState(false);
  return <BimReactContext.Provider value={sdk}>
    <button onClick={() => setOpen(true)}>Commands</button>
    <button aria-label="Model viewport focus target" data-viewport="main" />
    <CommandPalette open={open} onOpenChange={setOpen} />
    <ViewportHud /><CommandBar /><CommandScene />
  </BimReactContext.Provider>;
}
for (const federated of [false, true]) {
  test(`#8947 palette Split reaches real non-footprint numeric drafts and cancels (${federated ? 'N' : '1'} model)`, async () => {
    if (federated) {
      const model = useViewerStore.getState().models.get(MODEL_ID)!;
      useViewerStore.setState({ models: new Map([
        [MODEL_ID, { ...model, idOffset: 1_000_000 }],
        ['peer', { ...model, id: 'peer', idOffset: 2_000_000 }],
      ]) });
    }
    const state = useViewerStore.getState();
    const wall = state.addWall(MODEL_ID, STOREY,
      { Start: [0, 0, 0], End: [3, 0, 0], Thickness: 0.2, Height: 3 });
    assert.ok('expressId' in wall);
    const globalId = toGlobalIdFromModels(useViewerStore.getState().models, MODEL_ID, wall.expressId);
    state.setSelectedEntityId(globalId); state.setSelectedEntityIds([globalId]);
    useViewerStore.setState({ selectedEntity: { modelId: MODEL_ID, expressId: wall.expressId } });
    assert.deepEqual(useViewerStore.getState().readSplitTarget(MODEL_ID, wall.expressId), { ok: true, kind: 'wall' });
    const before = useViewerStore.getState();
    const history = new Map([...before.undoStacks].map(([id, stack]) => [id, [...stack]]));
    const mutations = structuredClone(before.mutationViews.get(MODEL_ID)!.getMutations());
    const entities = structuredClone(before.mutationViews.get(MODEL_ID)!.getNewEntities());
    const scene = renderScene(<Harness />);
    const launcher = [...scene.container.querySelectorAll('button')].find(button => button.textContent === 'Commands');
    assert.ok(launcher); launcher.focus(); click(launcher);
    const search = document.querySelector<HTMLInputElement>('input[role="combobox"]'); assert.ok(search);
    typeInto(search, en['commandPalette.tool.split.label']);
    const row = document.querySelector('[role="option"][data-command-id="tool:split"]'); assert.ok(row);
    assert.equal(row.getAttribute('aria-selected'), 'true');
    assert.notEqual(row.getAttribute('aria-disabled'), 'true');
    press(search, 'Enter');
    await waitFor(() => getCommandRuntime().command?.id === 'element.split' && !document.querySelector('input[role="combobox"]'),
      'palette Enter opens the actual Split runtime');
    const gesture = getCommandRuntime().gesture as SplitGesture;
    assert.equal(gesture.target?.modelId, MODEL_ID);
    assert.equal(gesture.target?.expressId, wall.expressId);
    assert.equal(gesture.footprint, null, 'a wall takes the scalar-distance branch');
    assert.ok(gesture.plane);
    const plane = gesture.plane;
    act(() => commandPointerMove({ local: [1.5, 0], render: plane.localToRender([1.5, 0, 0]),
      winner: null, guides: [], locked: false }));
    act(() => { scene.flush(); });
    const input = document.querySelector<HTMLInputElement>('[data-scene-primitive="cursor-input"] input');
    assert.ok(input, 'CommandScene resolves SplitScene and its actual CursorInput');
    assert.equal(input.getAttribute('aria-label'), en['splitTool.cutDistanceAria']);
    assert.equal(input.placeholder, '1.50');
    assert.equal(document.activeElement, input);
    typeInto(input, '1.25'); assert.equal(input.value, '1.25');
    typeInto(input, '25%'); assert.equal(input.value, '25%');
    press(input, 'Escape');
    assert.equal(document.activeElement, document.querySelector('[data-viewport="main"]'));
    assert.equal((getCommandRuntime().gesture as SplitGesture).typed, null, 'Escape does not commit the typed draft');
    const close = document.querySelector<HTMLButtonElement>(`[data-command-id="element.split"] button[aria-label="${en['modelingCommand.closeAria']}"]`);
    assert.ok(close); click(close);
    assert.equal(getCommandRuntime().command, null);
    assert.equal(document.querySelector('[data-scene-primitive="cursor-input"]'), null);
    const after = useViewerStore.getState();
    assert.deepEqual(after.undoStacks, history);
    assert.deepEqual(after.mutationViews.get(MODEL_ID)!.getMutations(), mutations);
    assert.deepEqual(after.mutationViews.get(MODEL_ID)!.getNewEntities(), entities);
    if (federated) assert.equal(after.mutationViews.has('peer'), false);
  });
}
