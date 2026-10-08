/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { afterEach, it } from 'node:test';
import { act } from 'react';
import { IfcParser } from '@ifc-lite/parser';
import { MutablePropertyView } from '@ifc-lite/mutations';
import type { GeometryResult } from '@ifc-lite/geometry';
import { cleanup, render, waitFor } from '@/test/render';
import { fixtureModel, fixtureModels } from '@/test/store-fixture';
import { useViewerStore } from '@/store';
import { usePlacementGeorefContext } from '@/lib/geo/placement-georef-runtime';
import { ViewportContainer } from '../ViewportContainer';

const source = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('ViewDefinition [ReferenceView]'),'2;1');
FILE_NAME('placement.ifc','2026-10-07T00:00:00',(),(),'test','test','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0000000000000000000000',$,'Placement',$,$,$,$,(#3),#2);
#2=IFCUNITASSIGNMENT((#7));
#3=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-5,#4,$);
#4=IFCAXIS2PLACEMENT3D(#5,$,$);
#5=IFCCARTESIANPOINT((0.,0.,0.));
#6=IFCMAPCONVERSION(#3,#8,500000.,5500000.,10.,1.,0.,1.);
#7=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#8=IFCPROJECTEDCRS('EPSG:32632',$,$,$,$,$,#7);
ENDSEC;
END-ISO-10303-21;`;
const bounds = { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 } };
const geometry: GeometryResult = { meshes: [], totalTriangles: 0, totalVertices: 0,
  coordinateInfo: { originShift: { x: 0, y: 0, z: 0 }, originalBounds: bounds,
    shiftedBounds: bounds, hasLargeCoordinates: false } };
const original = useViewerStore.getState();
const originalGpu = Object.getOwnPropertyDescriptor(navigator, 'gpu');
afterEach(() => {
  cleanup();
  useViewerStore.setState(original, true);
  if (originalGpu) Object.defineProperty(navigator, 'gpu', originalGpu);
  else Reflect.deleteProperty(navigator, 'gpu');
});

// Observe the real viewport's effective georeference, including its placement
// preview merge, rather than only reading the state the controller just set.
function EffectiveReadout() {
  const context = usePlacementGeorefContext();
  return <output>{context ? JSON.stringify({ crs: context.projectedCRS?.name,
    eastings: context.mapConversion.eastings, northings: context.mapConversion.northings }) : 'absent'}</output>;
}

async function mountProjectedPreview(secondCRS?: string) {
  const bytes = new TextEncoder().encode(source);
  const dataStore = await new IfcParser().parseColumnar(bytes.buffer, {});
  const models = [{ ...fixtureModel('m'), ifcDataStore: dataStore, geometryResult: geometry }];
  if (secondCRS) {
    const secondSource = source.replace('EPSG:32632', secondCRS)
      .replace('500000.,5500000.,10.', '5.,52.,10.');
    const secondBytes = new TextEncoder().encode(secondSource);
    const secondStore = await new IfcParser().parseColumnar(secondBytes.buffer, {});
    models.push({ ...fixtureModel('other'), ifcDataStore: secondStore, geometryResult: geometry });
  }
  useViewerStore.setState({
    ...fixtureModels(...models),
    ifcDataStore: null, geometryResult: geometry, cesiumEnabled: false, solarEnabled: false,
    cesiumPlacementEditMode: true, cesiumPlacementDraftModelId: 'm',
    cesiumPlacementDraft: { eastings: 500001, northings: 5500000,
      orthogonalHeight: 10, xAxisAbscissa: 1, xAxisOrdinate: 0 },
    georefMutations: new Map(), mutationViews: new Map([['m', new MutablePropertyView(null, 'm')]]),
    editEnabled: true, collabRoomId: null, anchorModelIdOverride: 'm', repositionOpen: false,
  });
  Object.defineProperty(navigator, 'gpu', { configurable: true,
    value: { requestAdapter: async () => ({ features: new Set(), limits: {} }) } });
  render(<ViewportContainer />);
  const readout = render(<EffectiveReadout />);
  await waitFor(() => readout.textContent === JSON.stringify({ crs: 'EPSG:32632', eastings: 500001, northings: 5500000 }),
    'projected dirty draft reaches the real viewport preview');
  return readout;
}

it('clears projected preview immediately after a geographic CRS transition without persisting it (#7060)', async () => {
  const readout = await mountProjectedPreview();
  act(() => {
    useViewerStore.getState().setGeorefFields('m', 'projectedCRS', [{ field: 'name', value: 'EPSG:4326' }]);
    useViewerStore.getState().setGeorefFields('m', 'mapConversion', [
      { field: 'eastings', value: 5 }, { field: 'northings', value: 52 },
    ]);
  });
  const committedSource = useViewerStore.getState().getGeorefMutations('m');
  const angularOutput = JSON.stringify({ crs: 'EPSG:4326', eastings: 5, northings: 52 });
  assert.equal(readout.textContent, angularOutput,
    'pending geographic classification must not overlay metre coordinates onto angles');
  await waitFor(() => readout.textContent === angularOutput && !useViewerStore.getState().cesiumPlacementEditMode,
    'the angular source must replace the stale projected preview');
  assert.equal(useViewerStore.getState().getGeorefMutations('m'), committedSource,
    'aborting a transient preview preserves the source edits');
  assert.equal(useViewerStore.getState().cesiumPlacementEditMode, false);
  // The global toolbar can try to activate editing even with a geographic
  // anchor. The mounted controller closes it without replacing the source.
  act(() => useViewerStore.getState().setCesiumPlacementEditMode(true));
  await waitFor(() => !useViewerStore.getState().cesiumPlacementEditMode,
    'geographic toolbar activation is aborted');
  assert.equal(readout.textContent, angularOutput);
  assert.equal(useViewerStore.getState().getGeorefMutations('m'), committedSource);
});


it('hides a projected draft while another projected CRS is pending, then restores it (#7060)', async () => {
  const readout = await mountProjectedPreview();
  const draft = useViewerStore.getState().cesiumPlacementDraft;
  act(() => useViewerStore.getState().setGeorefFields('m', 'projectedCRS', [{ field: 'name', value: 'EPSG:32631' }]));
  assert.equal(readout.textContent, JSON.stringify({ crs: 'EPSG:32631', eastings: 500000, northings: 5500000 }),
    'pending projected classification exposes the authored anchor');
  assert.equal(useViewerStore.getState().cesiumPlacementDraft, draft, 'pending classification does not discard the draft');
  await waitFor(() => readout.textContent === JSON.stringify({ crs: 'EPSG:32631', eastings: 500001, northings: 5500000 }),
    'a confirmed projected CRS restores the existing preview');
  assert.equal(useViewerStore.getState().cesiumPlacementDraft, draft);
});


it('pinning a geographic model aborts the global projected draft and does not revive it (#7060)', async () => {
  const readout = await mountProjectedPreview('EPSG:4326');
  const sourceEdits = useViewerStore.getState().georefMutations;
  act(() => useViewerStore.getState().setAnchorModelIdOverride('other'));
  await waitFor(() => readout.textContent === JSON.stringify({ crs: 'EPSG:4326', eastings: 5, northings: 52 })
    && !useViewerStore.getState().cesiumPlacementEditMode, 'geographic pinned anchor aborts the global session');
  act(() => useViewerStore.getState().setAnchorModelIdOverride('m'));
  await waitFor(() => readout.textContent === JSON.stringify({ crs: 'EPSG:32632', eastings: 500000, northings: 5500000 }),
    'returning to the projected anchor exposes its authored coordinates');
  assert.equal(useViewerStore.getState().cesiumPlacementEditMode, false);
  assert.equal(useViewerStore.getState().georefMutations, sourceEdits, 'anchor pinning does not persist source changes');
});

it('pinning another projected model preserves the global editor and starts its own draft (#7060)', async () => {
  const readout = await mountProjectedPreview('EPSG:32631');
  act(() => useViewerStore.getState().setAnchorModelIdOverride('other'));
  await waitFor(() => readout.textContent === JSON.stringify({ crs: 'EPSG:32631', eastings: 5, northings: 52 })
    && useViewerStore.getState().cesiumPlacementDraftModelId === 'other', 'projected pinned anchor starts its own session');
  assert.equal(useViewerStore.getState().cesiumPlacementEditMode, true);
  act(() => useViewerStore.getState().setAnchorModelIdOverride('m'));
  await waitFor(() => readout.textContent === JSON.stringify({ crs: 'EPSG:32632', eastings: 500000, northings: 5500000 }),
    'returning to the first projected model uses a fresh authored draft');
  assert.equal(useViewerStore.getState().cesiumPlacementEditMode, true);
});


it('removing the last CRS aborts editing even after the gizmo unmounts (#7060)', async () => {
  const readout = await mountProjectedPreview();
  act(() => useViewerStore.getState().setGeorefFields('m', 'projectedCRS', [{ field: 'name', value: '' }]));
  await waitFor(() => readout.textContent === 'absent' && !useViewerStore.getState().cesiumPlacementEditMode,
    'missing source aborts the global session without a mounted gizmo');
  act(() => useViewerStore.getState().setGeorefFields('m', 'projectedCRS', [{ field: 'name', value: 'EPSG:32632' }]));
  await waitFor(() => readout.textContent === JSON.stringify({ crs: 'EPSG:32632', eastings: 500000, northings: 5500000 }),
    'restoring the CRS exposes the authored anchor, without its abandoned draft');
  assert.equal(useViewerStore.getState().cesiumPlacementEditMode, false);
  assert.equal(useViewerStore.getState().getGeorefMutations('m')?.mapConversion, undefined,
    'removing and restoring the CRS never persists the transient coordinate draft');
});
