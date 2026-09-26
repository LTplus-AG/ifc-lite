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
import type { BimContext } from '@ifc-lite/sdk';
import { BimReactContext } from '@/sdk/BimProvider';
import { render, cleanup, click, advance, press } from '@/test/render';
import { downloadedNames, clearDownloads } from '@/test/download-capture';
import { fixtureModel } from '@/test/store-fixture';
import { useViewerStore } from '@/store';
import { posthog } from '@/lib/analytics';
import { setGlobalRendererRef } from '@/hooks/useBCF';
import { parseFixtureModel } from './anonymized-export/anonymized-export-fixture.test-support';
import { GLBExportDialog } from './GLBExportDialog';
import { MobileToolbar } from './MobileToolbar';
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
function ExportCommandsHarness({ surface }: { surface: 'classic' | 'ribbon' | 'palette' }) {
  api = useExportCommands(surface);
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
    const completed: Record<string, unknown>[] = [];
    mock.method(posthog, 'capture', (event: string, properties: Record<string, unknown>) => {
      if (event === 'export_completed') completed.push(properties);
    });
    mock.method(GeometryProcessor.prototype, 'exportGlbFromMeshes', () => new Uint8Array([1]));
    mock.method(GeometryProcessor.prototype, 'exportGlb', () => new Uint8Array([1]));
    for (const [index, surface] of (['classic', 'ribbon', 'palette'] as const).entries()) {
      render(<GLBExportDialog surface={surface} />);
      click(button('Export GLB')); await advance(1);
      click(button('Export')); await advance(20);
      assert.deepEqual(downloadedNames(), Array(index + 1).fill('Haus -2.glb'));
      assert.equal(completed.length, index + 1, '#5844: one completion per dialog GLB download');
      assert.equal(completed[index].surface, surface);
      cleanup();
    }
  });

  it('mobile GLB is named like the dialog, not model.glb', async () => {
    const completed: Record<string, unknown>[] = [];
    mock.method(posthog, 'capture', (event: string, properties: Record<string, unknown>) => {
      if (event === 'export_completed') completed.push(properties);
    });
    mock.method(GeometryProcessor.prototype, 'exportGlbFromMeshes', () => new Uint8Array([1]));
    render(<BimReactContext.Provider value={{} as BimContext}><MobileToolbar /></BimReactContext.Provider>);
    press(document.querySelector('[aria-haspopup="menu"]')!, 'ArrowDown'); await advance(10);
    const action = [...document.querySelectorAll('[role="menuitem"]')].find((item) => item.textContent?.trim() === 'Export GLB');
    assert.ok(action); click(action); await advance(25);
    assert.deepEqual(downloadedNames(), ['Haus -2.glb']);
    assert.equal(completed.length, 1, '#5844: one completion for the mobile GLB download');
    assert.equal(completed[0].surface, 'mobile');
  });

  it('JSON, CSV and screenshot carry the active model name', async () => {
    mock.method(GeometryProcessor.prototype, 'exportCsv', () => new TextEncoder().encode('a,b\n'));
    const completed: Record<string, unknown>[] = [];
    mock.method(posthog, 'capture', (event: string, properties: Record<string, unknown>) => {
      if (event === 'export_completed') completed.push(properties);
    });
    const canvas = document.createElement('canvas');
    canvas.dataset.viewport = 'main';
    canvas.toDataURL = () => 'data:image/png;base64,AA==';
    document.body.appendChild(canvas);
    try {
      for (const surface of ['classic', 'ribbon', 'palette'] as const) {
        const before = downloadedNames().length;
        const eventsBefore = completed.length;
        render(<ExportCommandsHarness surface={surface} />);
        commands().handleExportJSON();
        await commands().handleExportCSV('entities');
        await commands().handleExportCSV('properties');
        await commands().handleExportCSV('quantities');
        await commands().handleExportCSV('spatial');
        commands().handleScreenshot();
        assert.deepEqual(downloadedNames().slice(before), [
          'Haus -2_data.json',
          'Haus -2_entities.csv',
          'Haus -2_properties.csv',
          'Haus -2_quantities.csv',
          'Haus -2_spatial-hierarchy.csv',
          'Haus -2_screenshot.png',
        ]);
        assert.deepEqual(completed.slice(eventsBefore).map(({ format, surface: eventSurface }) => ({ format, surface: eventSurface })), [
          { format: 'json', surface },
          { format: 'csv', surface },
          { format: 'csv', surface },
          { format: 'csv', surface },
          { format: 'csv', surface },
          { format: 'png', surface },
        ], '#5844: one completion per data download with the initiating surface');
        cleanup();
      }
    } finally {
      canvas.remove();
    }
  });
});
