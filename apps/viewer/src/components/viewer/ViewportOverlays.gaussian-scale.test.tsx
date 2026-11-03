/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { render, cleanup } from '@/test/render.js';
import { fixtureModel, fixtureModels } from '@/test/store-fixture.js';
import { useViewerStore, type FederatedModel } from '@/store';
import { ViewportOverlays } from './ViewportOverlays.js';

function ifc(): FederatedModel {
  const model = fixtureModel('ifc');
  model.ifcDataStore!.schemaVersion = 'IFC4';
  return model;
}
function capture(): FederatedModel {
  // As the real capture shell (loadGaussianCapture finalizes with IFC4): only the gaussianSplat guard may exclude it.
  const base = fixtureModel('capture', { entities: [] });
  base.ifcDataStore!.schemaVersion = 'IFC4';
  return { ...base, gaussianSplat: {
    handle: { id: 1, modelIndex: 0 }, format: 'gaussian-ply', count: 1, shDegree: 0,
    sourceCenterBounds: { min: [0, 0, 0], max: [1, 1, 1] },
    placement: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
    placementOrigin: 'explicit', calibration: 'uncalibrated',
  } };
}
function mount() { return render(<ViewportOverlays hideViewCube hideAxis />); }
const metric = (ui: HTMLElement) => ui.querySelector('[data-testid="viewport-metric-scale"]');
const note = (ui: HTMLElement) => ui.querySelector('[data-testid="viewport-capture-scale-note"]');

describe('Gaussian capture scale disclosure (#8566)', () => {
  beforeEach(() => useViewerStore.setState({ ...fixtureModels(), isMobile: false, error: null, loading: false }));
  afterEach(cleanup);

  it('never shows metres for a lone capture, including explicitly placed captures and zoom updates', () => {
    useViewerStore.setState(fixtureModels(capture()));
    const ui = mount();
    assert.equal(metric(ui), null);
    assert.match(note(ui)?.textContent ?? '', /no metric scale/);
    act(() => useViewerStore.getState().onScaleChange?.(6.5));
    assert.equal(metric(ui), null);
  });

  it('does not treat a raw point cloud alongside a capture as metric IFC (#8566)', () => {
    const scanBase = fixtureModel('scan');
    scanBase.ifcDataStore!.schemaVersion = 'IFC4'; // as the real point-cloud ingest store: only pointCloudHandleId may exclude it
    const scan = { ...scanBase, pointCloudHandleId: 42 };
    useViewerStore.setState(fixtureModels(scan, capture()));
    const ui = mount();
    assert.equal(metric(ui), null);
    assert.match(note(ui)?.textContent ?? '', /no metric scale/);
    act(() => useViewerStore.getState().onScaleChange?.(6.5));
    assert.equal(metric(ui), null);
    act(() => useViewerStore.setState(fixtureModels(scan, capture(), ifc())));
    assert.ok(metric(ui), 'a real IFC model enables its metric scale');
    assert.match(note(ui)?.textContent ?? '', /Scale applies to IFC geometry/);
  });

  it('preserves the IFC scale and updates it through the real camera callback', () => {
    useViewerStore.setState(fixtureModels(ifc()));
    const ui = mount();
    act(() => useViewerStore.getState().onScaleChange?.(6.5));
    assert.equal(metric(ui)?.textContent, '6.5m');
    assert.equal(note(ui), null);
  });

  it('labels mixed scenes and responds to hiding either model without remounting', () => {
    useViewerStore.setState(fixtureModels(ifc(), capture()));
    const ui = mount();
    assert.ok(metric(ui));
    assert.match(note(ui)?.textContent ?? '', /Scale applies to IFC geometry/);
    act(() => useViewerStore.getState().setModelVisibility('ifc', false));
    assert.equal(metric(ui), null, 'a hidden IFC model does not justify a capture scale');
    assert.match(note(ui)?.textContent ?? '', /no metric scale/);
    act(() => useViewerStore.getState().setModelVisibility('ifc', true));
    act(() => useViewerStore.getState().setModelVisibility('capture', false));
    assert.ok(metric(ui));
    assert.equal(note(ui), null);
  });
});
