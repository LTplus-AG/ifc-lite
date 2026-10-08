/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { render, cleanup, click, advance } from '@/test/render';
import { seedAuthoringSample } from '@/test/authoring-sample-fixture';
import { useViewerStore } from '@/store';
import { ADAPTERS } from '@/lib/assistant/adapters/registry';
import { PANEL_SURFACE_COMMANDS } from '@/components/viewer/surface-commands-panels';
import { WORKSPACE_PANELS } from '@/lib/panels/registry';
import { readHostSnapshot } from '@/lib/assistant/reuse/recipe-availability';
import { stepAction } from '@/lib/assistant/reuse/recipe-run';
import { fixtureModel, fixtureModels } from '@/test/store-fixture';
import { nativeSourceShard } from '@/test/source-actions-fixture';
import { seedCoincidentWalls } from '@/test/clash-run-fixture';
import { SourcePicker } from './SourcePicker';

const initial = useViewerStore.getState();
afterEach(() => { cleanup(); useViewerStore.setState(initial, true); });

test('#7160 a real source-only SketchUp model cannot advertise an enabled native clash run', async () => {
  await seedAuthoringSample();
  useViewerStore.setState({ clashResult: null, clashRawResult: null, clashRunning: false });
  const ui = render(<SourcePicker current={null} onAttach={() => undefined} onCancel={null} />);
  const row = ui.querySelector('li[data-source="clash"]');
  assert.ok(row);
  const run = Array.from(row.querySelectorAll('button')).find(button => button.textContent?.includes('Run clash detection'));
  assert.ok(!run || run.disabled, 'no native geometry means no enabled Run action');
});


test('#7160 every source describes existing panel commands, evidence requirements and explicit run-host boundaries', () => {
  const state = useViewerStore.getState();
  const host = readHostSnapshot(state, false);
  for (const adapter of ADAPTERS) {
    assert.ok(adapter.actions, `${adapter.id} has an action contract`);
    const open = adapter.actions.open;
    assert.ok(WORKSPACE_PANELS.some(panel => panel.id === open.panel), 'open names a real native workspace panel');
    const command = PANEL_SURFACE_COMMANDS.find(item => item.panelId === open.panel);
    assert.equal(open.commandId, command?.id ?? null, 'only an actual native command ID may be declared');
    assert.deepEqual(stepAction({ kind: 'analysis', source: adapter.id }), { kind: 'panel', panel: open.panel });
    assert.deepEqual(adapter.actions.discuss.requires, ['evidence']);
    assert.equal(host.readySources.has(adapter.id), adapter.readiness(state).ready);
    if (adapter.id === 'clash') assert.deepEqual(adapter.actions.run,
      { kind: 'native', producer: 'clash', requires: ['native-clash-host', 'clash-geometry', 'clash-idle'] });
    else assert.deepEqual(adapter.actions.run, { kind: 'panel-controls', reasonKey: 'assistant.pickRunInPanel' });
  }
});

test('#7160 drained native IFNS input stays offered only for its own eligible model, without flat/hash geometry', async (t) => {
  const native = await nativeSourceShard(t);
  if (!native) return;
  const { store, shard } = native;
  const owner = 'source-action-native-ifns';
  const geometry = { meshes: [], totalTriangles: 0, totalVertices: 0 };
  const model = { ...fixtureModel(owner), ifcDataStore: store,
    geometryResult: { ...geometry, coordinateInfo: { originShift: { x: 0, y: 0, z: 0 },
      originalBounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 } },
      shiftedBounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 } }, hasLargeCoordinates: false } } };
  useViewerStore.setState({ ...fixtureModels(model), clashResult: null, clashRawResult: null, clashRunning: false });
  let attached = 0;
  const ui = render(<SourcePicker current={null} onAttach={() => { attached++; }} onCancel={null} />);
  const run = () => Array.from(ui.querySelectorAll<HTMLButtonElement>('li[data-source="clash"] button'))
    .find(button => button.textContent?.includes('Run clash detection'));
  assert.equal(run()?.disabled, true);
  act(() => { useViewerStore.getState().appendInstancedShards(owner, [shard]); useViewerStore.getState().clearInstancedShards(); });
  assert.equal(run()?.disabled, false, 'queue drain and absent optional hashes do not erase native input availability');
  // Input delivery cannot stand in for live renderer residency. The actual native host refuses it.
  const offered = run();
  assert.ok(offered);
  click(offered);
  for (let attempt = 0; attempt < 100 && !ui.querySelector('[role="alert"]'); attempt++) await advance(20);
  assert.match(ui.querySelector('[role="alert"]')?.textContent ?? '', /No model geometry is loaded/);
  assert.equal(attached, 0);
  assert.equal(useViewerStore.getState().clashResult, null);
  act(() => useViewerStore.setState({ models: new Map([['unrelated-source', { ...model, id: 'unrelated-source' }]]) }));
  assert.equal(run()?.disabled, true, 'another model cannot claim the owner handoff');
  act(() => useViewerStore.setState({ models: new Map([[owner, { ...model, ifcDataStore: null }]]) }));
  assert.equal(run()?.disabled, true, 'geometry without IFC metadata cannot enter the native producer');
});

for (const count of [1, 2] as const) test(`#7160 picker dispatches the existing native clash producer with ${count} parsed IFC models`, async () => {
  await seedCoincidentWalls(count);
  let attached: string | null = null;
  const ui = render(<SourcePicker current={null} onAttach={source => { attached = source; }} onCancel={null} />);
  const row = ui.querySelector('li[data-source="clash"]');
  assert.ok(row);
  const open = row.querySelector('button[aria-label="Open Clash detection"]');
  assert.ok(open);
  click(open);
  assert.equal(useViewerStore.getState().clashPanelVisible, true);
  const run = Array.from(row.querySelectorAll('button')).find(button => button.textContent?.includes('Run clash detection'));
  assert.ok(run && !run.disabled);
  click(run);
  for (let attempt = 0; attempt < 100 && !attached; attempt++) await advance(20);
  assert.equal(attached, 'clash');
  assert.equal(useViewerStore.getState().clashRunning, false);
  assert.equal(useViewerStore.getState().clashResult?.clashes.length, 1, 'actual native unit-box intersection is retained');
});


test('#7160 empty and busy native hosts are explained without dispatching or attaching evidence', async () => {
  useViewerStore.setState({ models: new Map(), clashResult: null, clashRawResult: null, clashRunning: false });
  let attached = 0;
  const ui = render(<SourcePicker current={null} onAttach={() => { attached++; }} onCancel={null} />);
  const row = () => ui.querySelector('li[data-source="clash"]');
  const run = () => Array.from(row()?.querySelectorAll('button') ?? []).find(button => button.textContent?.includes('Run clash detection'));
  assert.equal(run()?.disabled, true);
  assert.match(row()?.textContent ?? '', /Load model geometry/);
  await act(async () => { await seedCoincidentWalls(1); });
  assert.equal(run()?.disabled, false);
  act(() => useViewerStore.setState({ clashRunning: true }));
  const busy = row()?.querySelector<HTMLButtonElement>('button[title="Running…"]');
  assert.ok(busy?.disabled);
  click(busy);
  assert.equal(attached, 0);
  assert.equal(useViewerStore.getState().clashResult, null);
});
