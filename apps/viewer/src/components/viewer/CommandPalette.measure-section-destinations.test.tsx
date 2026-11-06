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
import { cleanup, click, advance } from '@/test/render';
import { useViewerStore } from '@/store';
import { seedModelingSession } from '@/test/modeling-session-fixture';
import { ViewportHud } from '@/components/viewport-ui/hud/ViewportHud';
import { MeasureToolbar } from './tools/MeasureToolbar';
import { MeasureHint } from './tools/MeasureHudReadouts';
import { SectionToolbar } from './tools/SectionToolbar';
import { SectionHint } from './tools/SectionHint';
import { MeasurementsPanel } from './MeasurementsPanel';
import { getDefaultSectionPlane } from '@/store/slices/sectionSlice';
import { useMeasurementDestination } from '@/lib/panels/measurement-destination';
import { MAX_SECTION_PLANES } from '@/lib/section/section-plane-set';
import { useAlignmentToolState, leaveAlignmentMode } from '@/lib/section/alignment-controller';
import { MEASURE_MODE_LABELS } from './tools/measure-modes/readouts';
import { resolveEnglish } from '@/i18n/registry';
import { setLocale } from '@/i18n';
import { loadDialogs } from '@/test/dialog-host';
import { mountDestinations, launchDestination, destinationOption, searchDestination, namedButton } from '@/test/palette-destinations';

const initial = useViewerStore.getState();
const hosts: ReturnType<typeof mountDestinations>[] = [];
beforeEach(async () => {
  setLocale('en'); localStorage.clear(); await seedModelingSession();
  useViewerStore.setState({ loading: false, activeTool: 'select', selectedEntityId: null, selectedEntityIds: new Set(),
    selectedEntity: null, sectionPlane: getDefaultSectionPlane(), inactiveSectionPlanes: [],
    snapEnabled: true, measurements: [], polylineMeasurements: [], angleMeasurements: [], radiusMeasurements: [],
    sectionPickMode: false, angleKind: 'points', collabRole: null });
  useMeasurementDestination.setState({ tab: 'list', revision: 0 });
});
afterEach(async () => {
  cleanup(); for (const host of hosts.splice(0)) await host.dispose(); leaveAlignmentMode();
  useViewerStore.setState(initial); useMeasurementDestination.setState({ tab: 'list', revision: 0 }); localStorage.clear();
});
function Bodies() {
  const tool = useViewerStore(s => s.activeTool);
  const panel = useViewerStore(s => s.sidebarActivePanel);
  return <><ViewportHud />
    {tool === 'measure' && <><MeasureToolbar /><MeasureHint /></>}
    {tool === 'section' && <><SectionToolbar /><SectionHint /></>}
    {panel === 'measurements' && <MeasurementsPanel />}
  </>;
}
function mount() { hosts.push(mountDestinations(<Bodies />)); }
for (const [mode, key] of MEASURE_MODE_LABELS) test(`#8947 ${mode} launches real measurement controls without selection`, async () => {
  mount(); await launchDestination(`measure:${mode}`, resolveEnglish(key));
  const radio = [...document.querySelectorAll('[role="radio"]')].find(r => r.textContent?.trim() === resolveEnglish(key));
  assert.ok(radio); assert.equal(radio.getAttribute('aria-checked'), 'true');
  assert.ok(document.querySelector('[data-hud-region="bottom-center"]')?.textContent?.trim());
  click(namedButton('Snap'));
  assert.equal(useViewerStore.getState().snapEnabled, false);
  if (mode === 'angle') {
    const faces = [...document.querySelectorAll('[role="radio"]')].find(r => r.textContent?.trim() === 'Faces'); assert.ok(faces); click(faces);
    assert.match(document.querySelector('[data-hud-region="bottom-center"]')?.textContent ?? '', /first face/);
  }
});
for (const [tab, label] of [['list', 'List'], ['point', 'Point'], ['quantities', 'Qty'], ['centreline', 'Source']] as const)
  test(`#8947 Measurements ${tab} destination reveals its body repeatedly after another tab`, async () => {
    mount();
    for (let i = 0; i < 2; i++) {
      await launchDestination(`measure-panel:${tab}`, tab);
      assert.equal(document.querySelector('[role="tab"][data-state="active"]')?.textContent?.trim(), label);
      assert.ok(document.querySelector('[role="tabpanel"][data-state="active"]'));
      const other = [...document.querySelectorAll('[role="tab"]')].find(t => t.textContent?.trim() === (tab === 'list' ? 'Point' : 'List')); assert.ok(other); click(other);
    }
  });
test('#8947 consumed palette tab does not override Point navigation when the toolbar reopens Measurements', async () => {
  mount(); await launchDestination('measure:drag', 'drag');
  await launchDestination('measure-panel:list', 'list');
  const togglePanel = () => {
    const button = document.querySelector(`[data-testid="measure-toolbar"] button[title="${resolveEnglish('measure.panel.toggleTitle')}"]`);
    assert.ok(button); click(button);
  };
  togglePanel(); await advance(10);
  assert.equal(document.querySelector('[role="tablist"]'), null, 'the actual toolbar closes and unmounts the panel');
  const point = [...document.querySelectorAll('[role="radio"]')].find(r => r.textContent?.trim() === 'Point');
  assert.ok(point); click(point);
  togglePanel(); await advance(10);
  assert.equal(document.querySelector('[role="tab"][data-state="active"]')?.textContent?.trim(), 'Point');
  assert.ok(document.querySelector('[role="tabpanel"][data-state="active"]')?.textContent?.includes(resolveEnglish('measure.point.emptyPrompt')));
  for (let i = 0; i < 2; i++) {
    await launchDestination('measure-panel:list', 'list');
    assert.equal(document.querySelector('[role="tab"][data-state="active"]')?.textContent?.trim(), 'List', 'a fresh explicit destination still wins in Point mode');
    const pointTab = [...document.querySelectorAll('[role="tab"]')].find(t => t.textContent?.trim() === 'Point');
    assert.ok(pointTab); click(pointTab);
  }
});
test('#8947 List destination exposes real clear confirmation and cancel keeps measurements', async () => {
  const { ConfirmDialogHost } = await loadDialogs();
  const start = { x: 0, y: 0, z: 0, screenX: 0, screenY: 0 };
  useViewerStore.setState({ measurements: [{ id: 'measured', start, end: { ...start, x: 3 }, distance: 3 }] });
  hosts.push(mountDestinations(<><Bodies /><ConfirmDialogHost /></>));
  await launchDestination('measure-panel:list', 'clear all'); click(namedButton('Clear all'));
  const dialog = document.querySelector('[role="alertdialog"]'); assert.ok(dialog); assert.match(dialog.textContent ?? '', /Clear every measurement/);
  click(dialog.querySelector('button')!); await advance(20);
  assert.equal(useViewerStore.getState().measurements.length, 1);
});
for (const kind of ['down', 'front', 'side', 'face', 'box', 'alignment'] as const)
  test(`#8947 section Add ${kind} launches canonical flow and actual toolbar`, async () => {
    // Bounds come from Frame's real selection-boundary callback; fitting remains in useAddSectionPlane.
    useViewerStore.setState({ cameraCallbacks: { ...useViewerStore.getState().cameraCallbacks,
      selectionBounds: () => ({ min: { x: 0, y: 0, z: 0 }, max: { x: 10, y: 4, z: 8 } }) } });
    mount(); await launchDestination(`section-add:${kind}`, kind);
    assert.ok(document.querySelector('[data-testid="section-toolbar"]'));
    const s = useViewerStore.getState();
    if (kind === 'face') {
      assert.equal(s.sectionPickTarget, 'new');
      assert.match(document.querySelector('[data-hud-region="bottom-center"]')?.textContent ?? '', /face/i);
    } else if (kind === 'alignment') {
      assert.equal(useAlignmentToolState.getState().choosing, true);
      const row = document.querySelector('[data-testid="section-active-row"]'); assert.ok(row);
      assert.ok(row.querySelector(`[aria-label="${resolveEnglish('alignmentSection.model')}"]`));
      assert.equal(row.querySelector(`[aria-label="${resolveEnglish('alignmentSection.axis')}"]`)?.getAttribute('data-disabled'), '');
    }
    else if (kind === 'box') {
      assert.ok(s.sectionPlane.box);
      assert.ok(document.querySelector('[data-testid="section-box-size"]'));
    } else {
      assert.equal(s.sectionPlane.axis, kind);
      const before = s.sectionPlane.position;
      const row = document.querySelector('[data-testid="section-active-row"]'); assert.ok(row);
      click(namedButton(resolveEnglish('sectionPlanes.offset.inc'), row));
      assert.notEqual(useViewerStore.getState().sectionPlane.position, before);
    }
  });
test('#8947 section slot limit updates the open palette and refuses a previously enabled row', async () => {
  mount(); searchDestination('down'); assert.equal(destinationOption('section-add:down').getAttribute('aria-disabled'), null);
  act(() => { for (let n = 0; n < MAX_SECTION_PLANES; n++) useViewerStore.getState().addSectionPlane('down'); });
  const row = destinationOption('section-add:down'); assert.equal(row.getAttribute('aria-disabled'), 'true');
  assert.match(row.textContent ?? '', /Remove a cutting plane/); click(row); await advance(50);
  assert.ok(document.querySelector('[role="combobox"]'), 'refusal keeps palette open');
});
test('#8947 section Box unloaded refusal becomes eligible with live selection bounds', async () => {
  useViewerStore.setState({ models: new Map(), geometryResult: null, ifcDataStore: null, cameraCallbacks: {} });
  mount(); searchDestination('box'); assert.equal(destinationOption('section-add:box').getAttribute('aria-disabled'), 'true');
  act(() => useViewerStore.setState({ cameraCallbacks: { selectionBounds: () => ({ min: { x: 0, y: 0, z: 0 }, max: { x: 2, y: 2, z: 2 } }) } }));
  assert.equal(destinationOption('section-add:box').getAttribute('aria-disabled'), null);
  click(destinationOption('section-add:box')); await advance(50);
  assert.ok(document.querySelector('[data-testid="section-toolbar"]')); assert.ok(useViewerStore.getState().sectionPlane.box);
});
for (const context of ['U', 'L', 'S'] as const) test(`#8947 measurement chooser in ${context} and live retained-model refusal`, async () => {
  if (context === 'U') useViewerStore.setState({ models: new Map(), geometryResult: null, ifcDataStore: null });
  if (context === 'S') useViewerStore.getState().setSelectedEntityId(130);
  mount(); await launchDestination('measure:angle', 'angle');
  assert.ok(document.querySelector('[aria-label="Angle kind"]'));
  const face = [...document.querySelectorAll('[role="radio"]')].find(r => r.textContent?.trim() === 'Faces'); assert.ok(face); click(face);
  assert.match(document.querySelector('[data-hud-region="bottom-center"]')?.textContent ?? '', /first face/);
  if (context !== 'U') {
    searchDestination('angle');
    act(() => {
      const s = useViewerStore.getState(), m = [...s.models.values()][0]; assert.ok(m);
      useViewerStore.setState({ models: new Map([[m.id, { ...m, retainedGeometry: {
        kernel: 'retained', candidates: 1, published: 0, cancelled: 0, completeness: 'incomplete', obligationsUnmet: [], refused: [],
      } }]]) });
    });
    const row = destinationOption('measure:angle'); assert.equal(row.getAttribute('aria-disabled'), 'true');
    click(row); await advance(30); assert.ok(document.querySelector('[role="combobox"]'));
  }
});
