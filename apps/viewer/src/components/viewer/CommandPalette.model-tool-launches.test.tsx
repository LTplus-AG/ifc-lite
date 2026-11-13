/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { act, useState } from 'react';
import type { BimContext } from '@ifc-lite/sdk';
import type { MeshData } from '@ifc-lite/geometry';
import { BimReactContext } from '@/sdk/BimProvider';
import { setLocale } from '@/i18n';
import { en } from '@/i18n/en';
import { useViewerStore } from '@/store';
import { toGlobalIdFromModels } from '@/store/globalId';
import { MODEL_ID, STOREY, ROTATED_BEAM, HUNG_SLAB, seedModelingSession } from '@/test/modeling-session-fixture';
import { envelopeWasm } from '@/test/space-envelope-oracle';
import { advance, cleanup, click, press, render, type as typeInto } from '@/test/render';
import { ensureSpaceWasm } from '@/lib/rooms/space-wasm';
import { getCommandRuntime } from '@/lib/commands/modeling/runtime';
import type { AlignGesture } from '@/lib/commands/modeling/align-gesture';
import { setRequestRemesh } from '@/lib/commands/modeling/transaction';
import { isWorkplane } from '@/lib/commands/modeling/workplane';
import { ViewportHud } from '../viewport-ui/hud/ViewportHud';
import { CommandBar } from './tools/command/CommandHud';
import { CommandPalette } from './CommandPalette';
import { RECENT_KEY } from './commandPaletteSearch';
import '@/lib/commands/modeling/builtin';

// #8947 access charter: stop at real configuration / launch controls. Geometry
// commits and pointer gestures are covered by the command-specific suites.
const original = useViewerStore.getState();
let restoreRemesh = () => {};
beforeEach(async () => {
  setLocale('en');
  localStorage.clear();
  await seedModelingSession();
  useViewerStore.setState({ collabRole: null, canCollabEdit: () => true,
    selectedEntityId: null, selectedEntityIds: new Set(), selectedEntity: null,
    sectionPlane: { ...useViewerStore.getState().sectionPlane, enabled: false, custom: undefined, box: undefined } });
  restoreRemesh = setRequestRemesh(() => {});
});
afterEach(() => {
  act(() => useViewerStore.getState().exitModelWorkspace());
  cleanup();
  restoreRemesh();
  useViewerStore.setState(original);
  localStorage.clear();
});

function Harness() {
  const [open, setOpen] = useState(false);
  return <BimReactContext.Provider value={{} as BimContext}>
    <button onClick={() => setOpen(true)}>Commands</button>
    <CommandPalette open={open} onOpenChange={setOpen} />
    <ViewportHud />
    <CommandBar />
  </BimReactContext.Provider>;
}
function option(id: string) {
  const row = document.querySelector<HTMLElement>(`[role="option"][data-command-id="${id}"]`);
  assert.ok(row, `discoverable palette route ${id}`);
  return row;
}
function mount(id: string, label: string) {
  const ui = render(<Harness />);
  click(ui.querySelector('button')!);
  const input = document.querySelector<HTMLInputElement>('input[role="combobox"]');
  assert.ok(input);
  typeInto(input, label);
  assert.ok(option(id).textContent?.includes(label), 'the translated route label is visible');
  assert.notEqual(option(id).getAttribute('aria-disabled'), 'true');
  return input;
}
function select(expressId: number) {
  const s = useViewerStore.getState();
  s.setSelectedEntityId(toGlobalIdFromModels(s.models, MODEL_ID, expressId));
  // Split's surface handler consumes the property channel as well as the
  // renderer id used by its canonical command. A viewer selection has both.
  useViewerStore.setState({ selectedEntity: { modelId: MODEL_ID, expressId } });
}
async function launch(id: string, commandId: string, label: string, keyboard = false) {
  const input = mount(id, label);
  if (keyboard) {
    assert.equal(option(id).getAttribute('aria-selected'), 'true');
    press(input, 'Enter');
  } else click(option(id));
  await advance(60);
  assert.equal(document.querySelector('input[role="combobox"]'), null, 'activation closes the palette');
  const runtime = getCommandRuntime();
  assert.equal(runtime.command?.id, commandId, 'canonical runtime owns the launched command');
  assert.ok(runtime.ctx?.workplane && isWorkplane(runtime.ctx.workplane), 'real IFC workplane resolves');
  const bar = document.querySelector<HTMLElement>(`[data-command-id="${commandId}"]`);
  assert.ok(bar, 'the actual command HUD mounts');
  return bar;
}
function hint(key: keyof typeof en) {
  const status = document.querySelector('[data-hud-region="bottom-center"] [role="status"]');
  assert.ok(status, 'real host prompt mounts');
  // #8947: the primary prompt stays exact; main #9201 adds a separate aiming hint below it.
  assert.equal(status.firstElementChild?.textContent, en[key]);
}
function choose(bar: HTMLElement, groupLabel: string, label: string) {
  const group = [...bar.querySelectorAll('[role="radiogroup"]')]
    .find(node => node.getAttribute('aria-label') === groupLabel);
  assert.ok(group, groupLabel);
  const radio = [...group.querySelectorAll('[role="radio"]')].find(node => node.textContent === label);
  assert.ok(radio, label);
  click(radio);
  assert.equal(radio.getAttribute('aria-checked'), 'true', 'real command configuration updates');
}
function cancel(bar: HTMLElement) {
  const close = [...bar.querySelectorAll('button')]
    .find(button => button.getAttribute('aria-label') === en['modelingCommand.closeAria']);
  assert.ok(close);
  click(close);
  assert.equal(getCommandRuntime().command, null);
  assert.equal(useViewerStore.getState().session?.activeCommandId, null);
  assert.equal(document.querySelector('[data-hud-region="bottom-center"] [role="status"]'), null);
}

test('#8947 palette grid reaches spacing/tag controls and cancels without creating axes', async () => {
  const before = useViewerStore.getState().mutationViews.get(MODEL_ID)!.getNewEntities().length;
  const bar = await launch('tool:grid', 'grid.place', en['grid.palette'], true);
  hint('grid.hint.corner');
  assert.ok(bar.querySelector(`[aria-label="${en['grid.field.spacingU']}"]`));
  assert.ok(bar.querySelector(`[aria-label="${en['grid.field.spacingV']}"]`));
  choose(bar, en['grid.tags.label'], en['grid.tags.letters']);
  cancel(bar);
  assert.equal(useViewerStore.getState().mutationViews.get(MODEL_ID)!.getNewEntities().length, before);
});

test('#8947 palette room reaches Draw configuration and its corner prompt', async t => {
  if (!envelopeWasm(t)) return;
  await ensureSpaceWasm();
  const bar = await launch('tool:room', 'room.place', en['roomTool.palette']);
  choose(bar, en['roomTool.mode.label'], en['roomTool.mode.draw']);
  hint('modelingCommand.slab.hintCorner');
  choose(bar, en['modelingCommand.slab.mode'], en['modelingCommand.slab.polygon']);
  hint('roomTool.hint.drawCorner');
  cancel(bar);
});

test('#8947 palette envelope resolves an actual authored IfcSpace and exposes roof modes', async () => {
  const s = useViewerStore.getState();
  const room = s.addSpace(MODEL_ID, STOREY, { Profile: 'polygon', OuterCurve: [[0, 0], [4, 0], [4, 3], [0, 3]],
    Position: [0, 0, 0], Height: 3, Name: 'Palette envelope witness' });
  assert.ok('expressId' in room);
  select(room.expressId);
  const before = useViewerStore.getState().undoStacks.get(MODEL_ID)?.length;
  const bar = await launch('tool:space-envelope', 'space.envelope', en['spaceEnvelope.label'], true);
  hint('spaceEnvelope.pick');
  choose(bar, en['spaceEnvelope.mode'], en['spaceEnvelope.pitched']);
  cancel(bar);
  assert.equal(useViewerStore.getState().undoStacks.get(MODEL_ID)?.length, before, 'configuration cancellation does not edit the room');
});

test('#8947 palette split targets the parsed horizontal slab and presents the cutting prompt', async () => {
  // The rotated beam is deliberately unsupported by canonical Split (#6233).
  // Use the imported horizontal slab whose extrusion the tool can preserve.
  select(HUNG_SLAB);
  const verdict = useViewerStore.getState().readSplitTarget(MODEL_ID, HUNG_SLAB);
  assert.deepEqual(verdict, { ok: true, kind: 'slab' }, 'parsed IFC slab is splittable');
  const bar = await launch('tool:split', 'element.split', en['commandPalette.tool.split.label']);
  hint('splitTool.hint');
  cancel(bar);
});

test('#8947 palette multi-split resolves selected IFC geometry and presents its cut scope', async () => {
  select(ROTATED_BEAM);
  const bar = await launch('tool:split-multi', 'split.multi', en['commandPalette.tool.splitMulti.label'], true);
  hint('multiSplit.hintStart');
  const scope = bar.querySelector('[data-multi-split="scope"]');
  assert.ok(scope);
  assert.match(scope.textContent ?? '', /1/);
  assert.equal(bar.querySelector('[data-multi-split="splits"]')?.getAttribute('data-count'), '0');
  cancel(bar);
});

test('#8947 palette align reads the parsed beam rendered bounds and exposes edge configuration', async () => {
  // #8947: profile corner (u,v), extrusion d, solid placement #87 and
  // product placement #81 yield IFC (v,d,2.5+u), then render (v,2.5+u,-d).
  // This rotates the offset rectangle; its world X range is not its local u.
  const positions = new Float32Array([-0.1, 0.1].flatMap(x => [2.26, 2.5].flatMap(y => [0, -4].flatMap(z => [x, y, z]))));
  const mesh: MeshData = { expressId: ROTATED_BEAM, ifcType: 'IfcBeam', positions, normals: new Float32Array(positions.length),
    indices: new Uint32Array([0, 1, 3, 0, 3, 2, 4, 6, 7, 4, 7, 5,
      0, 4, 5, 0, 5, 1, 2, 3, 7, 2, 7, 6, 0, 2, 6, 0, 6, 4, 1, 5, 7, 1, 7, 3]), color: [0.8, 0.8, 0.8, 1] };
  const s = useViewerStore.getState();
  const model = s.models.get(MODEL_ID)!;
  assert.ok(model.geometryResult);
  s.updateModel(MODEL_ID, { geometryResult: { ...model.geometryResult, meshes: [mesh] } });
  select(ROTATED_BEAM);
  const bar = await launch('tool:align', 'element.align', en['commandPalette.tool.align.label']);
  hint('align.hint.targets');
  const gesture = getCommandRuntime().gesture as AlignGesture;
  assert.equal(gesture.reference, ROTATED_BEAM);
  const box = gesture.boxes.get(ROTATED_BEAM);
  assert.ok(box, 'canonical Align resolves the selected beam bounds');
  const actual = [...box.min, ...box.max, box.z0, box.z1];
  const expected = [-0.1, 0, 0.1, 4, 2.26, 2.5];
  actual.forEach((value, i) => assert.ok(Math.abs(value - expected[i]!) < 1e-6, `rotated IFC bound ${i}`));
  assert.ok(bar.querySelector('[data-align-count]'));
  choose(bar, en['align.mode.aria'], en['align.mode.right']);
  cancel(bar);
});

test('#8947 palette trim/extend reads parsed storey targets and offers a boundary prompt and modes', async () => {
  const bar = await launch('tool:trim-extend', 'element.trimExtend', en['commandPalette.tool.trimExtend.label'], true);
  hint('trimExtend.hint.boundary');
  assert.equal(bar.querySelector('[data-trim-extend="boundary"]')?.getAttribute('data-picked'), 'false');
  choose(bar, en['trimExtend.mode.label'], en['trimExtend.mode.extend']);
  cancel(bar);
});

for (const refusal of ['lost selection', 'read-only role'] as const) {
  test(`#8947 pending palette split rechecks ${refusal} before starting a command`, async () => {
    select(HUNG_SLAB);
    assert.deepEqual(useViewerStore.getState().readSplitTarget(MODEL_ID, HUNG_SLAB), { ok: true, kind: 'slab' });
    const input = mount('tool:split', en['commandPalette.tool.split.label']);
    click(option('tool:split'));
    act(() => {
      if (refusal === 'lost selection') useViewerStore.setState({ selectedEntityId: null, selectedEntityIds: new Set(), selectedEntity: null });
      else useViewerStore.setState({ collabRole: 'viewer', canCollabEdit: () => false });
    });
    await advance(60);
    assert.equal(input.isConnected, false);
    assert.equal(useViewerStore.getState().workspaceMode, 'view');
    assert.equal(useViewerStore.getState().session, null);
    assert.equal(getCommandRuntime().command, null);
    assert.ok(!JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]').includes('tool:split'));
  });
}
