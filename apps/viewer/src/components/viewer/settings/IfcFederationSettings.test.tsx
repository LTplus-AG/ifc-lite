/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { afterEach, it } from 'node:test';
import { act } from 'react';
import { cleanup, click, render } from '@/test/render.js';
import { fixtureModel, fixtureModels } from '@/test/store-fixture.js';
import { openSettings } from '@/lib/settings/open-settings';
import { useViewerStore } from '@/store';
import { SettingsDialogHost } from './SettingsDialog.js';
import { ModelMetadataPanel } from '../properties/ModelMetadataPanel.js';
import { loadIfcSharedVerticalDatum, IFC_SHARED_VERTICAL_DATUM_STORAGE_KEY as KEY } from '@/store/slices/ifcGeorefAssumptionSettings.js';
import { finalizeFederatedSpatialPlacement } from '@/hooks/ingest/federatedSpatialFinalize.js';
import type { ModelSpatialReference, GeometryResult } from '@ifc-lite/geometry';

const initialState = useViewerStore.getState();
afterEach(() => {
  cleanup();
  useViewerStore.setState(initialState, true);
  localStorage.removeItem(KEY);
});

it('offers an off-by-default explicit IFC choice and uses a click to place geometry (#8042)', async () => {
  localStorage.removeItem(KEY);
  act(() => useViewerStore.setState({ ifcSharedVerticalDatum: loadIfcSharedVerticalDatum() }));
  render(<SettingsDialogHost />);
  act(() => openSettings('general'));
  const label = [...document.querySelectorAll('label')].find((el) => el.textContent === 'Assume IFC models share a height system');
  assert.ok(label);
  const control = document.getElementById(label.htmlFor);
  assert.ok(control);
  assert.equal(control.getAttribute('aria-checked'), 'false');
  assert.match(document.body.textContent ?? '', /Different declared datums are still refused/);
  assert.match(document.body.textContent ?? '', /Reload or re-align/);
  click(control);
  assert.equal(control.getAttribute('aria-checked'), 'true');
  assert.equal(loadIfcSharedVerticalDatum(), true, 'the UI persists an explicit opt-in');

  // Invoke the real finalizer after the UI choice; ignored onCheckedChange or
  // ignored settings at the ingest boundary must break this assertion.
  const spatialReference: ModelSpatialReference = {
    source: { axes: ['east', 'up', 'south'], horizontalUnitToMetres: 1, verticalUnitToMetres: 1 },
    horizontal: { id: 'EPSG:32760' }, confidence: 'declared', sourceMetadata: { format: 'ifc' },
    localToProjected: { kind: 'local-projected-affine', eastings: 0, northings: 0, orthogonalHeight: 0,
      xAxisAbscissa: 1, xAxisOrdinate: 0, scaleX: 1, scaleY: 1, scaleZ: 1 },
  };
  const geometry: GeometryResult = {
    meshes: [{ expressId: 1, positions: new Float32Array([2, 3, 4]), normals: new Float32Array([0, 1, 0]),
      indices: new Uint32Array(), color: [1, 1, 1, 1] }], totalVertices: 1, totalTriangles: 0,
    coordinateInfo: { originShift: { x: 0, y: 0, z: 0 }, hasLargeCoordinates: false,
      originalBounds: { min: { x: 2, y: 3, z: 4 }, max: { x: 2, y: 3, z: 4 } },
      shiftedBounds: { min: { x: 2, y: 3, z: 4 }, max: { x: 2, y: 3, z: 4 } } },
  };
  const anchor = { ...fixtureModel('anchor'), spatialReference, geometryResult: structuredClone(geometry) };
  act(() => useViewerStore.setState({ ...fixtureModels(anchor) }));
  const placed = await finalizeFederatedSpatialPlacement({
    dataStore: fixtureModel('revision').ifcDataStore!, geometry,
    modelId: 'revision', fileName: 'revision.ifc', spatialReference,
    isCurrent: () => true, setProgress: () => undefined,
  });
  assert.equal(placed?.federationAlignmentStatus, 'identity');
  assert.equal(placed?.ifcSharedVerticalDatumAssumed, true);
  assert.deepEqual([...geometry.meshes[0].positions], [2, 3, 4]);
  click(control);
  assert.equal(loadIfcSharedVerticalDatum(), false, 'the UI can revoke the standing choice');
});

it('labels actual assumed placements in model metadata and omits the notice for failures (#8042)', () => {
  const assumed = { ...fixtureModel('revision'), ifcSharedVerticalDatumAssumed: true as const, federationAlignmentStatus: 'identity' as const };
  act(() => useViewerStore.setState({ ...fixtureModels(assumed) }));
  const ui = render(<ModelMetadataPanel model={assumed} />);
  assert.match(ui.textContent ?? '', /Assumed height system/);
  assert.match(ui.textContent ?? '', /source declarations are unchanged/);
  cleanup();
  const failed = { ...assumed, federationAlignmentStatus: 'failed' as const };
  act(() => useViewerStore.setState({ ...fixtureModels(failed) }));
  const failureUi = render(<ModelMetadataPanel model={failed} />);
  assert.doesNotMatch(failureUi.textContent ?? '', /Assumed height system/);
});

it('keeps malformed saved values off and the explicit choice across model resets (#8042)', () => {
  for (const value of ['1', 'TRUE', '"true"', '{}', '', 'false']) {
    localStorage.setItem(KEY, value);
    assert.equal(loadIfcSharedVerticalDatum(), false);
  }
  act(() => useViewerStore.getState().setIfcSharedVerticalDatum(true));
  act(() => useViewerStore.getState().resetViewerState());
  assert.equal(loadIfcSharedVerticalDatum(), true);
  assert.equal(useViewerStore.getState().ifcSharedVerticalDatum, true);
  assert.deepEqual(useViewerStore.getState().landXmlGeorefAssumptionSettings, initialState.landXmlGeorefAssumptionSettings);
});
