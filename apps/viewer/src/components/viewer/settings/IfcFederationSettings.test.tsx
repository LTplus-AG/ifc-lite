/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { afterEach, it } from 'node:test';
import { act } from 'react';
import { cleanup, click, render } from '@/test/render.js';
import { parseSpatialIfc } from '@/test/ifc-spatial-fixture.js';
import { fixtureModel, fixtureModels } from '@/test/store-fixture.js';
import { openSettings } from '@/lib/settings/open-settings';
import { useViewerStore } from '@/store';
import { SettingsDialogHost } from './SettingsDialog.js';
import { ModelMetadataPanel } from '../properties/ModelMetadataPanel.js';
import { loadIfcSharedVerticalDatum, IFC_SHARED_VERTICAL_DATUM_STORAGE_KEY as KEY } from '@/store/slices/ifcGeorefAssumptionSettings.js';
import { finalizeFederatedSpatialPlacement } from '@/hooks/ingest/federatedSpatialFinalize.js';
import { extractModelSpatialPlacement, findReferenceSpatialModel } from '@/hooks/ingest/federationAlign.js';
import type { GeometryResult } from '@ifc-lite/geometry';

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
  const dataStore = await parseSpatialIfc({ eastings: 0, northings: 0, orthogonalHeight: 0 });
  const geometry: GeometryResult = {
    meshes: [{ expressId: 1, positions: new Float32Array([2, 3, 4]), normals: new Float32Array([0, 1, 0]),
      indices: new Uint32Array(), color: [1, 1, 1, 1] }], totalVertices: 1, totalTriangles: 0,
    coordinateInfo: { originShift: { x: 0, y: 0, z: 0 }, hasLargeCoordinates: false,
      originalBounds: { min: { x: 2, y: 3, z: 4 }, max: { x: 2, y: 3, z: 4 } },
      shiftedBounds: { min: { x: 2, y: 3, z: 4 }, max: { x: 2, y: 3, z: 4 } } },
  };
  const placement = extractModelSpatialPlacement(dataStore, geometry.coordinateInfo);
  assert.ok(placement);
  assert.equal(placement.spatialReference.vertical, undefined);
  const anchor = { ...fixtureModel('anchor'), ifcDataStore: dataStore, geometryResult: structuredClone(geometry) };
  act(() => useViewerStore.setState({ ...fixtureModels(anchor) }));
  assert.equal(findReferenceSpatialModel()?.modelId, anchor.id, 'the real parsed anchor is selected');
  const placed = await finalizeFederatedSpatialPlacement({
    dataStore, geometry, modelId: 'revision', fileName: 'revision.ifc',
    isCurrent: () => true, setProgress: () => undefined,
  });
  assert.equal(placed?.federationAlignmentStatus, 'identity');
  assert.equal(placed?.ifcSharedVerticalDatumAssumed, true);
  assert.deepEqual([...geometry.meshes[0].positions], [2, 3, 4]);
  click(control);
  assert.equal(loadIfcSharedVerticalDatum(), false, 'the UI can revoke the standing choice');
});

it('distinguishes missing and unresolved assumption notices and omits them for failures (#8042/R58-F2)', () => {
  for (const marker of [true, 'unresolved'] as const) {
    const assumed = {
      ...fixtureModel('revision'),
      // This synthetic model has no source bytes; metadata rendering needs a valid load timestamp.
      fileSize: 0,
      loadedAt: 0,
      ifcSharedVerticalDatumAssumed: marker,
      federationAlignmentStatus: 'identity' as const,
    };
    act(() => useViewerStore.setState({ ...fixtureModels(assumed) }));
    const ui = render(<ModelMetadataPanel model={assumed} />);
    assert.match(ui.textContent ?? '', /Assumed height system/);
    assert.match(ui.textContent ?? '', /source declarations are unchanged/);
    if (marker === 'unresolved') {
      assert.match(ui.textContent ?? '', /authored vertical datum could not be resolved/);
      assert.doesNotMatch(ui.textContent ?? '', /datum is missing/);
    } else {
      assert.match(ui.textContent ?? '', /datum is missing/);
    }
    cleanup();
    const failed = { ...assumed, federationAlignmentStatus: 'failed' as const };
    act(() => useViewerStore.setState({ ...fixtureModels(failed) }));
    const failureUi = render(<ModelMetadataPanel model={failed} />);
    assert.doesNotMatch(failureUi.textContent ?? '', /Assumed height system/);
    cleanup();
  }
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
