/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #8566: a Gaussian capture model in the mounted hierarchy and properties UI.
 * The interim showcase showed a capture as "IFC Model / IFC4" with IFC entity
 * statistics, and a lone capture had no row to inspect, hide, fit or remove.
 * IFC models must keep their existing panels and rows.
 */

import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { render, cleanup, click } from '@/test/render.js';
import { useViewerStore, type FederatedModel } from '@/store';
import { fixtureModel, fixtureModels } from '@/test/store-fixture.js';
import { SourceHostProvider } from '@/services/sources/SourceHostProvider';
import { HierarchyPanel } from './HierarchyPanel.js';
import { ModelMetadataPanel } from './properties/ModelMetadataPanel.js';

// The Models list is virtualized; happy-dom reports no layout (HierarchyPanel.removeModel.test.tsx).
Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, value: 600 });
Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, value: 400 });
Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, value: 600 });
Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, value: 400 });

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

function captureModel(id: string, name: string, count = 914_000): FederatedModel {
  return {
    ...fixtureModel(id, { entities: [] }),
    name, fileSize: 226_795_353, loadedAt: Date.UTC(2026, 10, 2), schemaVersion: 'IFC4',
    gaussianSplat: {
      handle: Object.freeze({ id: 7, modelIndex: 0 }), format: 'gaussian-ply', count, shDegree: 3,
      sourceCenterBounds: { min: [-1, -1, -1], max: [1, 1, 1] }, placement: IDENTITY,
      placementOrigin: 'source', calibration: 'uncalibrated', attribution: 'Seem Kirke by roedsgaard, CC BY 4.0',
    },
  } as FederatedModel;
}

const label = (container: HTMLElement, text: string) => container.querySelector<HTMLButtonElement>(`button[aria-label="${text}"]`);

describe('Gaussian capture models in the mounted UI (#8566)', () => {
  beforeEach(() => {
    useViewerStore.setState({ ...fixtureModels(captureModel('capture', 'church.ply')), selectedModelId: null,
      mutationViews: new Map(), georefMutations: new Map() });
  });
  afterEach(() => cleanup());

  it('a lone capture has one row to inspect, hide, fit and remove it', () => {
    const container = render(<SourceHostProvider><HierarchyPanel /></SourceHostProvider>);
    const row = container.querySelector('[data-testid="capture-model-row"]');
    assert.ok(row, 'the capture row renders for models.size === 1');
    assert.match(row.textContent ?? '', /church\.ply/);
    assert.match(row.textContent ?? '', /914,000 splats · uncalibrated/);

    click(label(container, 'Show capture details')!);
    assert.equal(useViewerStore.getState().selectedModelId, 'capture', 'inspect selects the model for the properties panel');
    click(label(container, 'Hide capture')!);
    assert.equal(useViewerStore.getState().models.get('capture')?.visible, false);
    click(label(container, 'Show capture')!);
    assert.equal(useViewerStore.getState().models.get('capture')?.visible, true);
    assert.ok(label(container, 'Fit capture in view'), 'fit is offered');
    click(label(container, 'Remove capture')!);
    assert.equal(useViewerStore.getState().models.has('capture'), false, 'remove removes the model');
  });

  it('a capture beside IFC keeps the multi-model rows; a lone IFC model keeps its tree', () => {
    useViewerStore.setState(fixtureModels(fixtureModel('ifc', { entities: [{ expressId: 1, type: 'IfcWall', name: 'Wall' }] }),
      captureModel('capture', 'church.ply')));
    let container = render(<SourceHostProvider><HierarchyPanel /></SourceHostProvider>);
    assert.ok(label(container, 'Remove model church.ply'), 'the capture has the federated model header row');
    assert.ok(label(container, 'Remove model ifc'));
    assert.equal(container.querySelector('[data-testid="capture-model-row"]'), null);
    cleanup();
    useViewerStore.setState(fixtureModels(fixtureModel('ifc', { entities: [{ expressId: 1, type: 'IfcWall', name: 'Wall' }] })));
    container = render(<SourceHostProvider><HierarchyPanel /></SourceHostProvider>);
    assert.equal(container.querySelector('[data-testid="capture-model-row"]'), null, 'IFC models never get the capture row');
  });

  it('capture metadata states what is known and its limits, never IFC schema or statistics', () => {
    const container = render(<ModelMetadataPanel model={useViewerStore.getState().models.get('capture')!} />);
    const text = container.textContent ?? '';
    for (const expected of ['Gaussian capture', 'Gaussian PLY', '914,000', 'Source coordinates in viewer frame',
      'Uncalibrated: no units, alignment or measurement', 'Seem Kirke by roedsgaard, CC BY 4.0']) {
      assert.ok(text.includes(expected), `shows ${expected}`);
    }
    assert.ok(!text.includes('internal preview'), 'a released capture is not labelled a preview (#8568)');
    // #8568: every disclosed launch limitation, in the panel's limitations section.
    const limitations = [...container.querySelectorAll('[data-limitation]')].map((node) => [node.getAttribute('data-limitation'), node.textContent]);
    assert.deepEqual(limitations, [
      ['composition', 'Composited over IFC glass and X-ray approximately.'],
      ['clipping', 'Section planes and boxes cull whole Gaussians by centre; no section caps.'],
      ['uncalibrated', 'Uncalibrated: shown in source units, with no metric scale or survey alignment.'],
      ['picking', 'Not pickable: select the capture in the model list.'],
      ['measurement', 'No measurement or snapping on captures.'],
      ['export', 'Capture data is not included in exports (IFC, glTF, USD, KMZ, PDF and others). BCF snapshots can show visible captures.'],
    ]);
    for (const absent of ['IFC Model', 'IFC4', 'Total Entities', 'Building Storeys', 'Max Express ID']) {
      assert.ok(!text.includes(absent), `does not claim ${absent}`);
    }
  });

  it('up-axis control shows the applied default for unplaced and explicitly placed captures (#8752)', () => {
    const original = captureModel('source', 'source.ply');
    const source = { ...original, gaussianSplat: { ...original.gaussianSplat!, sourcePlacement: IDENTITY } };
    let container = render(<ModelMetadataPanel model={source} />);
    assert.equal(container.querySelector<HTMLSelectElement>('select')?.value, 'z');
    cleanup();
    const explicit = { ...source, gaussianSplat: {
      ...source.gaussianSplat!, placementOrigin: 'explicit' as const, placement: IDENTITY,
    } };
    container = render(<ModelMetadataPanel model={explicit} />);
    assert.equal(container.querySelector<HTMLSelectElement>('select')?.value, 'y');
  });

  it('an IFC model keeps its IFC metadata panel', () => {
    const ifc = { ...fixtureModel('ifc', { entities: [{ expressId: 1, type: 'IfcWall', name: 'Wall' }] }),
      name: 'house.ifc', fileSize: 1024, loadedAt: Date.UTC(2026, 10, 2), schemaVersion: 'IFC4' } as FederatedModel;
    const container = render(<ModelMetadataPanel model={ifc} />);
    assert.match(container.textContent ?? '', /IFC Model/);
    assert.equal(container.querySelector('[data-testid="gaussian-capture-metadata"]'), null);
  });
});
