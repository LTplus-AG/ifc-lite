/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import 'fake-indexeddb/auto';
import { installLayout } from '@/test/dom-layout';
installLayout();
import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { Drawing2DGenerator } from '@ifc-lite/drawing-2d';
import { useViewerStore } from '@/store';
import { setLocale } from '@/i18n';
import { IdbFlavorStorage } from '@/services/extensions/idb-flavor-storage';
import { FlavorDialogHost } from '@/components/extensions/FlavorDialogHost';
import { advance, cleanup, click, press, type as enterText, waitFor } from '@/test/render';
import { seedModelingSession, MODEL_ID, STOREY, MESH_WALL } from '@/test/modeling-session-fixture';
import { mountDestinations, launchDestination, namedButton, searchDestination, destinationOption } from '@/test/palette-destinations';
import { storeyWallAxes } from '@/lib/snap/sources/semantic-walls';
import { sX, sY } from '@/lib/rooms/plate-geometry';
import '@/lib/commands/modeling/builtin';
import { PresentationPanel } from './presentation/PresentationPanel';
import { ModelWorkspaceSplit } from './model/ModelWorkspaceSplit';
import { fitPlan } from './plan/plan-fit';
import { publishSplitWidth } from './model/model-layout';

// #8947: real local consumers, no success-handler substitutions. The 3D sibling
// is deliberately a DOM probe: camera animation/thumbnail pixels are NOT proved.
const initial = useViewerStore.getState();
const hosts: ReturnType<typeof mountDestinations>[] = [];
beforeEach(async () => {
  setLocale('en'); localStorage.clear();
  await new IdbFlavorStorage().clear();
  await seedModelingSession();
  useViewerStore.setState({ loading: false, collabRole: null,
    basketViews: [], pinboardEntities: new Set(), activeBasketViewId: null,
    basketPresentationVisible: false, flavorDialogRequested: false, savedLenses: [],
    selectedEntityId: null, selectedEntityIds: new Set(), cameraCallbacks: {},
    sidebarMode: 'collapsed', rightPanelCollapsed: true, floatingPanels: [], poppedOutIds: [] });
});
afterEach(async () => {
  act(() => useViewerStore.getState().endCommand('cancel'));
  cleanup();
  for (const host of hosts.splice(0)) await host.dispose();
  useViewerStore.setState(initial); publishSplitWidth(0); localStorage.clear();
  await new IdbFlavorStorage().clear();
});
function PresentationDestination() {
  return useViewerStore(s => s.basketPresentationVisible) ? <PresentationPanel /> : null;
}
function required<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector); assert.ok(element, selector); return element;
}
function pointer(target: Element, kind: string, x: number, y: number, init: PointerEventInit = {}) {
  act(() => target.dispatchEvent(new window.PointerEvent(kind, {
    bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, pointerId: 1, ...init,
  })));
}
async function openPlan() {
  hosts.push(mountDestinations(<ModelWorkspaceSplit><div data-workspace-3d-probe /></ModelWorkspaceSplit>));
  act(() => { useViewerStore.getState().enterModelWorkspace(); useViewerStore.getState().setModelLayout('3d'); publishSplitWidth(1280); });
  await launchDestination('model:plan', 'plan layout');
  await waitFor(() => !!document.querySelector('[data-plan-axis]'), 'parsed wall axis did not appear');
  return required<SVGSVGElement>('[data-plan-canvas]');
}

test('#8947 palette Presentation saves parsed collection, Play restores it, Stop ends playback and empty collection refuses Save', async () => {
  hosts.push(mountDestinations(<PresentationDestination />));
  await launchDestination('panel:presentation', 'presentation');
  const save = namedButton('Save current collection as presentation view');
  const playLabel = 'Play all saved views (Shift+Click to loop)';
  assert.equal(save.disabled, true);
  assert.equal(namedButton(playLabel).disabled, true);
  // A real parsed IfcWall is the collection's entity, through the public action.
  act(() => useViewerStore.getState().setBasket([{ modelId: MODEL_ID, expressId: MESH_WALL }]));
  assert.equal(save.disabled, false);
  click(save);
  await waitFor(() => useViewerStore.getState().basketViews.length === 1, 'Save did not create a view');
  const view = useViewerStore.getState().basketViews[0];
  assert.deepEqual(view.entityRefs, [`${MODEL_ID}:${MESH_WALL}`]);
  assert.ok(namedButton(view.name), 'the saved view is in the real filmstrip');
  assert.equal(view.thumbnailDataUrl, null, 'renderer-free save uses the supported null-thumbnail branch');
  act(() => useViewerStore.getState().clearBasket());
  assert.equal(save.disabled, true);
  click(namedButton(playLabel));
  await waitFor(() => useViewerStore.getState().pinboardEntities.has(`${MODEL_ID}:${MESH_WALL}`), 'Play did not restore saved entities');
  assert.equal(useViewerStore.getState().activeBasketViewId, view.id);
  assert.ok(useViewerStore.getState().isolatedEntities?.has(MESH_WALL), 'real activator restored visibility');
  click(namedButton('Stop playback'));
  assert.equal(namedButton(playLabel).disabled, false);
  // Drain the one bounded in-flight wait; no loop or helper timer survives cleanup.
  await advance(950);
  assert.equal(useViewerStore.getState().basketViews.length, 1);
});

test('#8947 palette Flavors configures a named profile, cancels without a write, then creates through the real service', async () => {
  const host = mountDestinations(<FlavorDialogHost />); hosts.push(host);
  await launchDestination('extensions:flavors', 'flavors');
  await waitFor(() => !!document.querySelector('[role="dialog"]'), 'Flavors host did not open');
  const before = await host.flavors.list();
  click(namedButton('Create a new empty profile'));
  let input = required<HTMLInputElement>('input[placeholder="Empty workspace"]');
  assert.equal(namedButton('Create').disabled, true, 'blank configuration refuses Create');
  enterText(input, 'Cancelled workspace'); click(namedButton('Cancel'));
  assert.deepEqual(await host.flavors.list(), before, 'Cancel must not persist the draft');
  click(namedButton('Create a new empty profile'));
  input = required<HTMLInputElement>('input[placeholder="Empty workspace"]');
  enterText(input, 'Palette workspace'); click(namedButton('Create'));
  await waitFor(() => [...document.querySelectorAll('li')].some(row => row.textContent?.includes('Palette workspace') && [...row.querySelectorAll('span')].some(span => span.textContent === 'Active')), 'created profile row missing');
  const created = (await host.flavors.list()).find(flavor => flavor.name === 'Palette workspace');
  assert.ok(created); assert.deepEqual(created.lenses, []);
  assert.equal(await host.flavors.activeId(), created.id);
  press(required('[role="dialog"]'), 'Escape');
  await waitFor(() => !document.querySelector('[role="dialog"]'), 'profile dialog did not close');
});

test('#8947 palette Flavors reviews real iflv contents and cancels before import or activation', async () => {
  const host = mountDestinations(<FlavorDialogHost />); hosts.push(host);
  await host.flavors.put({ schemaVersion: 1, id: 'palette.review-source', name: 'Archive review workspace',
    description: 'Local review contents', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
    extensions: [], lenses: [], savedQueries: [], keybindings: [], layout: { state: {} }, settings: {} });
  const bytes = await host.flavors.exportFlavor('palette.review-source');
  const before = await host.flavors.list();
  const active = await host.flavors.activeId();
  await launchDestination('extensions:flavors', 'flavors');
  await waitFor(() => !!document.querySelector('input[accept=".iflv"]'), 'import input missing');
  const picker = required<HTMLInputElement>('input[accept=".iflv"]');
  let pickerRequests = 0;
  const observePicker = () => { pickerRequests++; };
  picker.addEventListener('click', observePicker);
  click(namedButton('Import'));
  assert.equal(pickerRequests, 1, 'real Import action requests its canonical file input');
  picker.removeEventListener('click', observePicker);
  const transfer = new window.DataTransfer();
  transfer.items.add(new window.File([new Uint8Array(bytes)], 'workspace.iflv', { type: 'application/octet-stream' }));
  act(() => { picker.files = transfer.files; picker.dispatchEvent(new window.Event('change', { bubbles: true })); });
  await waitFor(() => [...document.querySelectorAll('button')].some(b => b.textContent?.trim() === 'Merge…'), 'real archive preview missing');
  const dialog = required('[role="dialog"]');
  assert.match(dialog.textContent ?? '', /Archive review workspace/);
  assert.match(dialog.textContent ?? '', /Local review contents/);
  assert.ok(namedButton('Replace existing')); assert.ok(namedButton('Save as new'));
  click(namedButton('Cancel'));
  await waitFor(() => !!document.querySelector('input[accept=".iflv"]'), 'cancel did not return to library');
  assert.deepEqual(await host.flavors.list(), before);
  assert.equal(await host.flavors.activeId(), active);
  press(dialog, 'Escape');
});

test('#8947 palette Plan Grid and Fit affect parsed wall geometry; pointer navigation and layout controls remain live', async () => {
  const svg = await openPlan();
  const probe = required('[data-workspace-3d-probe]');
  const axis = () => required(`[data-plan-axis="${MESH_WALL}"]`);
  const coords = () => ['x1', 'y1', 'x2', 'y2'].map(key => axis().getAttribute(key));
  const original = coords();
  const grid = namedButton('Grid');
  assert.equal(grid.getAttribute('aria-pressed'), 'true');
  assert.ok(document.querySelector('[data-plan-layer="grid"]'));
  click(grid);
  assert.equal(grid.getAttribute('aria-pressed'), 'false');
  assert.equal(document.querySelector('[data-plan-layer="grid"]'), null);
  click(grid); assert.ok(document.querySelector('[data-plan-layer="grid"]'));
  pointer(svg, 'pointerdown', 100, 100, { button: 1, buttons: 4 });
  pointer(svg, 'pointermove', 180, 140, { button: 1, buttons: 4 });
  pointer(svg, 'pointerup', 180, 140, { button: 1 });
  assert.notDeepEqual(coords(), original, 'pan changes the real axis projection');
  click(namedButton('Fit the plan to the view')); assert.deepEqual(coords(), original);
  act(() => svg.dispatchEvent(new window.WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: -100, clientX: 300, clientY: 200 })));
  assert.notDeepEqual(coords(), original, 'wheel zoom changes projected content');
  click(namedButton('Fit the plan to the view')); assert.deepEqual(coords(), original);
  const layout = (name: string) => {
    const radio = [...document.querySelectorAll('[role="radio"]')].find(el => el.textContent === name);
    assert.ok(radio, name); click(radio);
  };
  layout('Plan'); assert.equal(useViewerStore.getState().modelLayout, 'plan');
  layout('Split'); assert.equal(useViewerStore.getState().modelLayout, 'split');
  layout('3D'); assert.equal(document.querySelector('[data-plan-view]'), null);
  assert.equal(required('[data-workspace-3d-probe]'), probe);
  await launchDestination('model:plan', 'plan layout');
  assert.ok(document.querySelector('[data-plan-view]'));
  assert.equal(required('[data-workspace-3d-probe]'), probe);
});

test('#8947 palette Plan Retry recovers an actual authored-wall cut after one reported cutter failure', async () => {
  const svg = await openPlan();
  const s = useViewerStore.getState();
  const axes = storeyWallAxes(s.models.get(MODEL_ID)!.ifcDataStore!, s.mutationViews.get(MODEL_ID)!, STOREY);
  const fit = fitPlan([], [], axes, 1280, 800);
  const real = Drawing2DGenerator.prototype.generate;
  let rejectNext = true;
  let rejected = 0;
  let delegated = 0;
  // Fault injection only: recovery always calls the real cutter, never a
  // fabricated drawing or successful mock result. Restored even on failure.
  Drawing2DGenerator.prototype.generate = function (...args: Parameters<typeof real>) {
    if (rejectNext) { rejectNext = false; rejected++; return Promise.reject(new Error('#8947 transient plan cut failure')); }
    delegated++; return real.apply(this, args);
  };
  try {
    act(() => useViewerStore.getState().startCommand('wall.place'));
    for (const [x, y] of [[-2, 1], [3, 1]]) {
      pointer(svg, 'pointerdown', sX(fit, x), sY(fit, y));
      pointer(svg, 'pointerup', sX(fit, x), sY(fit, y));
    }
    act(() => useViewerStore.getState().endCommand('cancel'));
    await waitFor(() => !!document.querySelector('[data-plan-status="failed"]'), 'cut failure was not reported');
    assert.equal(rejected, 1);
    assert.ok(useViewerStore.getState().mutationViews.get(MODEL_ID)!.getNewEntities().some(e => e.type.toUpperCase() === 'IFCWALL'), 'real authoring command created a wall');
    click(namedButton('Retry', required('[data-plan-status="failed"]')));
    await waitFor(() => delegated > 0 && !document.querySelector('[data-plan-status="failed"]') && !!document.querySelector('[data-plan-entity]'), 'Retry did not produce real cut geometry');
    assert.equal(rejected, 1, 'Retry did not fabricate a second failure');
  } finally {
    Drawing2DGenerator.prototype.generate = real;
  }
});


test('#8947 palette Plan explains measured narrow-host refusal and leaves 3D usable', async () => {
  // Happy DOM has no layout. Supply the split HOST's actual measured width,
  // allowing ModelWorkspaceSplit to publish it through its production effect.
  const real = window.Element.prototype.getBoundingClientRect;
  window.Element.prototype.getBoundingClientRect = function () {
    return this.hasAttribute('data-model-split-width')
      ? new window.DOMRect(0, 0, 400, 800) : real.call(this);
  };
  try {
    act(() => { useViewerStore.getState().enterModelWorkspace(); useViewerStore.getState().setModelLayout('3d'); });
    hosts.push(mountDestinations(<ModelWorkspaceSplit><div data-workspace-3d-probe /></ModelWorkspaceSplit>));
    await advance(20);
    assert.equal(required('[data-model-split-width]').getAttribute('data-model-split-width'), '400');
    searchDestination('plan layout');
    const option = destinationOption('model:plan');
    assert.equal(option.getAttribute('aria-disabled'), 'true');
    assert.match(option.textContent ?? '', /No room for the plan beside 3D/);
    click(option);
    assert.ok(document.querySelector('[role="combobox"]'), 'refusal keeps the palette open');
    assert.equal(useViewerStore.getState().modelLayout, '3d');
    assert.equal(document.querySelector('[data-plan-view]'), null);
    assert.ok(document.querySelector('[data-workspace-3d-probe]'));
  } finally {
    window.Element.prototype.getBoundingClientRect = real;
  }
});
