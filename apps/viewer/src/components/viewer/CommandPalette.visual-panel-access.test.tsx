/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import '@/test/content-fixture.js';
import { installLayout } from '@/test/dom-layout';
installLayout();
import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import type { GeometryResult, MeshData } from '@ifc-lite/geometry';
import { cleanup, click, press, type, waitFor } from '@/test/render';
import { namedButton } from '@/test/palette-destinations';
import { useViewerStore } from '@/store';
import { ARCH } from '@/test/artifact-models-fixture';
import { placementSourceIdentity } from '@/lib/model-placement/source-identity';
import { readSavedLensSource } from '@/lib/lens/persistence';
import { EVENT_FILE_DOWNLOADED } from '@/lib/tours/events';
import { DrawingRuntimeHost } from './drawing/DrawingRuntimeHost';
import { seedPanelWitness, mountPanelWitness, openPanelWitness, element, choose,
  openMenu, menuItem } from '@/test/palette-document-panel-witness';

const initial = useViewerStore.getState();
let host: ReturnType<typeof mountPanelWitness> | undefined;
beforeEach(seedPanelWitness);
afterEach(async () => {
  cleanup(); await host?.dispose(); host = undefined;
  useViewerStore.setState(initial, true); localStorage.clear();
});

// Same bounded box invariant as DrawingPanel.shell.test.tsx; attached to a
// parsed sample owner. This is a ready-drawing access fixture, not an IFC
// meshing, PDF binary, scale accuracy or geometry fidelity oracle.
function box(expressId: number): MeshData {
  const positions = new Float32Array([
    0, 0, 0, 10, 0, 0, 10, 10, 0, 0, 10, 0,
    0, 0, 10, 10, 0, 10, 10, 10, 10, 0, 10, 10,
  ]);
  const indices = new Uint32Array([
    0, 1, 2, 0, 2, 3, 4, 6, 5, 4, 7, 6, 0, 4, 5, 0, 5, 1,
    3, 2, 6, 3, 6, 7, 0, 3, 7, 0, 7, 4, 1, 5, 6, 1, 6, 2,
  ]);
  return { expressId, ifcType: 'IfcWall', modelIndex: 0, positions,
    normals: new Float32Array(positions.length), indices, color: [0.5, 0.5, 0.5, 1], geometryClass: 0 };
}

test('#8947 palette Drawing opens real ready-drawing PDF options and cancels without downloading', async () => {
  const s = useViewerStore.getState(), model = s.models.get(ARCH); assert.ok(model?.ifcDataStore);
  const wall = model.ifcDataStore.entityIndex.byType.get('IFCWALL')?.[0]; assert.ok(wall);
  const zero = { x: 0, y: 0, z: 0 }, max = { x: 10, y: 10, z: 10 };
  const geometry: GeometryResult = { meshes: [box(wall)], totalTriangles: 12, totalVertices: 8,
    coordinateInfo: { originShift: zero, originalBounds: { min: zero, max }, shiftedBounds: { min: zero, max }, hasLargeCoordinates: false } };
  useViewerStore.setState({ models: new Map([[ARCH, { ...model, geometryResult: geometry }]]),
    geometryResult: geometry, drawing2D: null, drawing2DStatus: 'idle', sheetEnabled: false,
    sectionPlane: { ...s.sectionPlane, axis: 'down', position: 50, enabled: true, custom: undefined } });
  host = mountPanelWitness(<DrawingRuntimeHost mergedGeometry={geometry} />);
  await openPanelWitness('drawing', '[data-drawing-canvas]');
  await waitFor(() => useViewerStore.getState().drawing2DStatus === 'ready' && !!useViewerStore.getState().drawing2D, 'real runtime generated the ready access fixture');
  let downloads = 0;
  const onDownload = () => { downloads++; };
  window.addEventListener(EVENT_FILE_DOWNLOADED, onDownload);
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      openMenu(namedButton('Export'));
      const pdf = menuItem('Download PDF (to scale)');
      assert.notEqual(pdf.getAttribute('aria-disabled'), 'true'); click(pdf);
      await waitFor(() => !!document.querySelector('[role="dialog"] [role="combobox"]'), 'actual PDF scale dialog');
      const dialog = element('[role="dialog"]');
      assert.match(dialog.textContent ?? '', /Choose the scale the PDF is drawn at/);
      const scale = element('[role="combobox"]', dialog); press(scale, 'ArrowDown');
      const custom = [...document.querySelectorAll('[role="option"]')].find(o => o.textContent?.startsWith('Custom')); assert.ok(custom);
      press(custom, 'Enter');
      const input = element<HTMLInputElement>('input', dialog); type(input, '250');
      assert.equal(input.value, '250'); assert.equal(namedButton('Export', dialog).disabled, false);
      click(namedButton('Cancel', dialog));
      await waitFor(() => !document.querySelector('[role="dialog"]'), 'PDF options cancelled');
      assert.equal(downloads, 0);
      assert.ok(document.querySelector('[data-drawing-canvas]'), 'actual parent remains mounted');
    }
  } finally { window.removeEventListener(EVENT_FILE_DOWNLOADED, onDownload); }
});

test('#8947 palette Lens opens AutoColor capture/clear and source config, cancels then saves and activates', async () => {
  const s = useViewerStore.getState(), model = s.models.get(ARCH); assert.ok(model?.ifcDataStore);
  const source = model.ifcDataStore.source;
  const bytes = new Uint8Array(source.slice(0, source.byteLength));
  const hash = await placementSourceIdentity(new Blob([bytes]), undefined, bytes); assert.ok(hash);
  useViewerStore.setState({ models: new Map([[ARCH, { ...model, sourceContentHash: hash }]]) });
  const wall = model.ifcDataStore.entityIndex.byType.get('IFCWALL')?.[0]; assert.ok(wall);
  act(() => {
    useViewerStore.getState().setSelectedEntity({ modelId: ARCH, expressId: wall });
    useViewerStore.getState().setSelectedEntityId(wall); // canonical single-model fallback
  });
  host = mountPanelWitness();
  await openPanelWitness('lens', 'button[aria-label="Export lenses as JSON"]');
  // Observe this family's real body before opening its actual editor.
  const launch = namedButton('New Auto-Color Lens'); click(launch);
  assert.ok(document.querySelector('fieldset legend'), 'AutoColor population control is mounted');
  click(namedButton('Capture selected'));
  assert.match(element('fieldset').textContent ?? '', /1 selected element captured from 1 file/);
  click(namedButton('Clear capture'));
  assert.match(element('fieldset').textContent ?? '', /All elements matching these criteria/);
  choose('select[aria-label="Source"]', 'attribute'); choose('select[aria-label="Name"]', 'Name');
  click(namedButton('Cancel'));
  assert.equal(useViewerStore.getState().savedLenses.length, 0);
  assert.equal(document.querySelector('select[aria-label="Source"]'), null);
  click(namedButton('New Auto-Color Lens'));
  assert.equal(element<HTMLSelectElement>('select[aria-label="Source"]').value, 'ifcType', 'cancel discards source draft');
  choose('select[aria-label="Source"]', 'attribute'); choose('select[aria-label="Name"]', 'Name');
  type(element<HTMLInputElement>('input[placeholder="Auto-color lens name..."]'), 'Palette captured names');
  click(namedButton('Capture selected'));
  assert.equal(namedButton('Save').disabled, false); click(namedButton('Save'));
  const saved = useViewerStore.getState().savedLenses.find(l => l.name === 'Palette captured names'); assert.ok(saved);
  assert.deepEqual(saved.autoColor, { source: 'attribute', propertyName: 'Name' });
  assert.equal(saved.capturedScope?.mode, 'selected');
  assert.deepEqual(saved.capturedScope?.sources[0].members, [{ expressId: wall }]);
  assert.equal(readSavedLensSource().rows.find(l => l.id === saved.id)?.capturedScope?.sources[0].sourceContentHash, hash);
  const activate = [...document.querySelectorAll<HTMLButtonElement>('button[aria-pressed]')]
    .find(b => b.textContent?.includes(saved.name)); assert.ok(activate); click(activate);
  assert.equal(activate.getAttribute('aria-pressed'), 'true');
  assert.equal(useViewerStore.getState().activeLensId, saved.id, 'real lens launch; GPU output is outside this witness');
});
