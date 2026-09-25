/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #5833: one model, one format, one filename, whichever surface exported it.
 * Each case drives the real surface and reads the name off the download anchor.
 * On main these came out as `model.glb` (mobile), `model-data.json`,
 * `entities.csv`, `screenshot.png`, and the GLB dialog's own extension regex
 * dropped the ` (2)` copy suffix `stripExtension` keeps (#4444).
 */

import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { GeometryProcessor, type GeometryResult, type MeshData } from '@ifc-lite/geometry';
import { render, cleanup, click, advance } from '@/test/render';
import { downloadedNames, clearDownloads } from '@/test/download-capture';
import { fixtureModel } from '@/test/store-fixture';
import { useViewerStore } from '@/store';
import { setGlobalRendererRef } from '@/hooks/useBCF';
import { parseFixtureModel } from './anonymized-export/anonymized-export-fixture.test-support';
import { GLBExportDialog } from './GLBExportDialog';
import { useExportCommands } from './toolbar/useExportCommands';

/** A second copy of a file, named the way a room recipient's copy is (#4444). */
const MODEL_NAME = 'Haus.ifc (2)';

const zero = { x: 0, y: 0, z: 0 };
const mesh: MeshData = {
  expressId: 1, positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
  normals: new Float32Array(9), indices: new Uint32Array([0, 1, 2]), color: [1, 1, 1, 1],
};
const geometry: GeometryResult = {
  meshes: [mesh], totalTriangles: 1, totalVertices: 3,
  coordinateInfo: { originalBounds: { min: zero, max: zero }, shiftedBounds: { min: zero, max: zero }, originShift: zero, hasLargeCoordinates: false },
};

async function seedModel(): Promise<void> {
  const ifcDataStore = await parseFixtureModel();
  const model = { ...fixtureModel('m'), name: MODEL_NAME, ifcDataStore, geometryResult: geometry };
  useViewerStore.setState({
    models: new Map([['m', model]]), activeModelId: 'm', ifcDataStore, geometryResult: geometry, mergeLayers: false,
  });
}

function button(label: string): HTMLElement {
  const el = [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === label);
  assert.ok(el, `button "${label}" must render`);
  return el;
}

let api: ReturnType<typeof useExportCommands> | null = null;
function ExportCommandsHarness() {
  api = useExportCommands();
  return null;
}
function commands(): ReturnType<typeof useExportCommands> {
  assert.ok(api, 'the harness must have rendered');
  return api;
}

describe('every model export is filed under the model name (#5833)', () => {
  beforeEach(async () => {
    clearDownloads();
    await seedModel();
    mock.method(GeometryProcessor.prototype, 'init', async () => undefined);
    mock.method(GeometryProcessor.prototype, 'dispose', () => undefined);
  });
  afterEach(() => {
    cleanup();
    mock.restoreAll();
    api = null;
    setGlobalRendererRef({ current: null });
  });

  it('GLB dialog keeps the copy suffix', async () => {
    mock.method(GeometryProcessor.prototype, 'exportGlbFromMeshes', () => new Uint8Array([1]));
    mock.method(GeometryProcessor.prototype, 'exportGlb', () => new Uint8Array([1]));
    render(<GLBExportDialog />);
    click(button('Export GLB')); await advance(1);
    click(button('Export')); await advance(20);
    assert.deepEqual(downloadedNames(), ['Haus -2.glb']);
  });

  it('JSON, CSV and screenshot carry the active model name', async () => {
    mock.method(GeometryProcessor.prototype, 'exportCsv', () => new TextEncoder().encode('a,b\n'));
    const canvas = document.createElement('canvas');
    canvas.dataset.viewport = 'main';
    canvas.toDataURL = () => 'data:image/png;base64,AA==';
    document.body.appendChild(canvas);
    try {
      render(<ExportCommandsHarness />);
      commands().handleExportJSON();
      await commands().handleExportCSV('entities');
      await commands().handleExportCSV('spatial');
      commands().handleScreenshot();
      assert.deepEqual(downloadedNames(), [
        'Haus -2_data.json',
        'Haus -2_entities.csv',
        'Haus -2_spatial-hierarchy.csv',
        'Haus -2_screenshot.png',
      ]);
    } finally {
      canvas.remove();
    }
  });
});
