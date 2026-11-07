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
import { cleanup, click, advance, mouseDown } from '@/test/render';
import { useViewerStore } from '@/store';
import { seedModelingSession } from '@/test/modeling-session-fixture';
import { setLocale } from '@/i18n';
import { ModelWorkspaceSplit } from './model/ModelWorkspaceSplit';
import { publishSplitWidth } from './model/model-layout';
import { MeasurementsPanel } from './MeasurementsPanel';
import { PresentationPanel } from './presentation/PresentationPanel';
import { RetainedGeometryChip } from './RetainedGeometryChip';
import { ViewportHud } from '@/components/viewport-ui/hud';
import { useMeasurementDestination } from '@/lib/panels/measurement-destination';
import { registerAnalysisExtensions, openAnalysisExtension, getAnalysisExtensionsSnapshot, closeActiveAnalysisExtension } from '@/services/analysis-extensions';
import { mountDestinations, launchDestination, namedButton, searchDestination, destinationOption } from '@/test/palette-destinations';

const initial = useViewerStore.getState();
const hosts: ReturnType<typeof mountDestinations>[] = [];
let releaseExtension: (() => void) | undefined;
beforeEach(async () => {
  setLocale('en'); localStorage.clear(); await seedModelingSession();
  useViewerStore.setState({ loading: false, collabRole: null, selectedEntityId: null, selectedEntityIds: new Set(),
    sidebarActivePanel: 'properties', sidebarMode: 'collapsed', rightPanelCollapsed: true, floatingPanels: [], poppedOutIds: [] });
});
afterEach(async () => {
  cleanup(); for (const host of hosts.splice(0)) await host.dispose();
  releaseExtension?.(); releaseExtension = undefined; closeActiveAnalysisExtension();
  useViewerStore.setState(initial); useMeasurementDestination.setState({ tab: 'list', revision: 0 }); publishSplitWidth(0); localStorage.clear();
});
function Panels() {
  const sidebar = useViewerStore(s => s.sidebarActivePanel);
  const presentation = useViewerStore(s => s.basketPresentationVisible);
  return <>{sidebar === 'measurements' && <MeasurementsPanel />}{presentation && <PresentationPanel />}</>;
}
for (const detached of ['docked', 'folded', 'floating', 'popout'] as const)
  test(`#8947 palette reveals ${detached} Measurements body and repeated invocation keeps it open`, async () => {
    const start = { x: 0, y: 0, z: 0, screenX: 0, screenY: 0 };
    const end = { x: 3, y: 3, z: -4, screenX: 3, screenY: 3 };
    // Renderer (3, 3, -4) is IFC (3, 4, 3), as in MeasurementsPanel.test.
    useViewerStore.setState({ measurements: [{ id: 'endpoint', start, end, distance: Math.hypot(3, 3, 4) }],
      measureMode: 'drag', activeMeasurement: null, measureReferencePoint: null, unitDisplayOverrides: {} });
    const s = useViewerStore.getState(); s.showWorkspacePanel('measurements');
    if (detached === 'folded') s.setRightPanelCollapsed(true);
    if (detached === 'floating') s.floatPanel('measurements');
    if (detached === 'popout') s.setPanelPoppedOut('measurements', true);
    hosts.push(mountDestinations(<Panels />));
    releaseExtension = registerAnalysisExtensions([{ id: 'fixture', label: 'Fixture', icon: () => null, renderPanel: () => null }]);
    openAnalysisExtension('fixture');
    for (let n = 0; n < 2; n++) {
      await launchDestination('panel:measurements', 'measurements');
      assert.ok(document.querySelector('[role="tab"]'), 'real measurement tabs visible');
      const point = [...document.querySelectorAll('[role="tab"]')].find(t => t.textContent?.trim() === 'Point'); assert.ok(point); mouseDown(point);
      assert.equal(document.querySelector('[role="tab"][data-state="active"]')?.textContent?.trim(), 'Point');
      assert.equal(point.getAttribute('aria-selected'), 'true');
      const panel = document.querySelector('[role="tabpanel"][data-state="active"]'); assert.ok(panel);
      assert.equal(panel.getAttribute('aria-labelledby'), point.id);
      assert.match(panel.textContent ?? '', /X 3\.000\s+Y 4\.000\s+Z 3\.000/);
      assert.equal(useViewerStore.getState().sidebarActivePanel, 'measurements');
      assert.equal(useViewerStore.getState().rightPanelCollapsed, false);
      assert.equal(useViewerStore.getState().floatingPanels.some(p => p.id === 'measurements'), false);
      assert.equal(useViewerStore.getState().poppedOutIds.includes('measurements'), false);
      assert.equal(getAnalysisExtensionsSnapshot().activeId, null);
    }
  });
test('#8947 Presentation opens its actual saved-view controls and stays open', async () => {
  hosts.push(mountDestinations(<Panels />));
  for (let n = 0; n < 2; n++) {
    await launchDestination('panel:presentation', 'presentation');
    assert.equal(useViewerStore.getState().basketPresentationVisible, true);
    assert.ok(namedButton('Save current collection as presentation view'));
    assert.ok(namedButton('Play all saved views (Shift+Click to loop)'));
  }
});
test('#8947 model plan destination mounts the real rail layout flow and refuses narrow width', async () => {
  hosts.push(mountDestinations(<ModelWorkspaceSplit><div data-viewport-stub /></ModelWorkspaceSplit>));
  act(() => { useViewerStore.getState().enterModelWorkspace(); useViewerStore.getState().setModelLayout('3d'); publishSplitWidth(1280); });
  await launchDestination('model:plan', 'plan layout');
  assert.ok(document.querySelector('[data-model-plan-pane]'));
  assert.ok(document.querySelector('[data-viewport-stub]'));
  await launchDestination('model:plan', 'plan layout');
  assert.ok(document.querySelector('[data-model-plan-pane]'));
  act(() => publishSplitWidth(400)); searchDestination('plan layout');
  assert.equal(destinationOption('model:plan').getAttribute('aria-disabled'), 'true');
});
test('#8947 conditional retained report opens the existing chip report and disables after owner loss', async () => {
  const s = useViewerStore.getState(), model = [...s.models.values()][0]; assert.ok(model);
  useViewerStore.setState({ models: new Map([[model.id, { ...model, retainedGeometry: {
    kernel: 'retained', candidates: 1, published: 0, cancelled: 0, completeness: 'incomplete', obligationsUnmet: [],
    refused: [{ expressId: 130, ifcType: 'IfcWall', code: 'operation_unsupported' }],
  } }]]) });
  hosts.push(mountDestinations(<><ViewportHud /><RetainedGeometryChip reload={() => { throw new Error('Report access must not reload'); }} /></>));
  await launchDestination('panel:retained-report', 'retained report');
  assert.ok(document.querySelector('[data-retained-geometry-panel]'));
  assert.ok(document.querySelector('[data-retained-row="130"]'));
  click(namedButton('Close', document.querySelector('[data-retained-geometry-panel]')!));
  act(() => useViewerStore.setState({ models: new Map(), geometryResult: null, ifcDataStore: null }));
  searchDestination('retained report');
  assert.equal(destinationOption('panel:retained-report').getAttribute('aria-disabled'), 'true');
  click(destinationOption('panel:retained-report')); await advance(30);
  assert.ok(document.querySelector('[role="combobox"]'));
});
