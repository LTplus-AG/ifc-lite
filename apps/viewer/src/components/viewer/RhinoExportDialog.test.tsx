/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The Rhino (.3dm) dialog end to end, minus the two wasm engines: the real
 * client and the real worker job run in-process (`rhino-export-worker-fake`),
 * so the bytes, options, progress and warnings cross a cloned message
 * boundary exactly as they would to a worker.
 */

import '@/test/setup-dom.js';
import { downloadedNames, clearDownloads } from '@/test/download-capture.js';
import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { posthog } from '@/lib/analytics';
import { useViewerStore } from '@/store/index.js';
import type { FederatedModel } from '@/store/types.js';
import type { RhinoExportJobDeps } from '@/lib/export/rhino-export-job.js';
import { installFakeRhinoWorker, type FakeRhinoWorkerHandle } from '@/test/rhino-export-worker-fake.js';
import { RhinoExportDialog } from './RhinoExportDialog.js';

const FILE_BYTES = [1, 2, 3];

function makeModel(name = 'model-1.ifc'): FederatedModel {
  return {
    id: 'model-1',
    name,
    ifcDataStore: null,
    geometryResult: null,
    visible: true,
    collapsed: false,
    schemaVersion: 'IFC4',
    loadedAt: 1,
    fileSize: 3,
    sourceFile: new File([new Uint8Array(FILE_BYTES)], name),
    idOffset: 0,
    maxExpressId: 10,
  };
}

const mounted: Array<{ root: Root; container: HTMLElement }> = [];
function unmountAll(): void {
  for (const { root, container } of mounted.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
}

async function openDialog(): Promise<void> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(<RhinoExportDialog surface="ribbon" />));
  mounted.push({ root, container });
  const trigger = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes('Export Rhino (.3dm)'));
  assert.ok(trigger, 'trigger button must render');
  await act(async () => trigger.click());
}

function dialogButton(text: string): HTMLButtonElement | undefined {
  return [...document.body.querySelectorAll('button')].find((b) => b.textContent?.trim() === text);
}

/** Click Export and let the cloned worker messages drain. */
async function runExport(waitForCompletion = true): Promise<void> {
  const button = dialogButton('Export');
  assert.ok(button, 'the dialog Export button must render once opened');
  await act(async () => button.click());
  // File reads and worker delivery take separate timer turns. Flush React
  // after each turn before observing progress, including a paused export.
  const ready = () => waitForCompletion
    ? (fake?.terminated() ?? 0) > 0
    : document.querySelector('[data-rhino-export-progress="objects"]') !== null;
  for (let attempt = 0; attempt < 200 && !ready(); attempt++) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
  }
  assert.ok(ready(), 'the worker reaches the expected export state');
}

const MANIFEST = JSON.stringify({ warnings: ['length unit scale 0.5 is not a Rhino unit; wrote Meters'], objects: [{}, {}] });
const okDeps: RhinoExportJobDeps = {
  buildScene: async () => ({ manifest: MANIFEST, blob: new Uint8Array() }),
  writeScene: async (_s, { onProgress }) => { onProgress(0, 2); onProgress(1, 2); onProgress(2, 2); return { bytes: new Uint8Array(2048), warnings: ['length unit scale 0.5 is not a Rhino unit; wrote Meters'], objectCount: 2 }; },
};

let fake: FakeRhinoWorkerHandle | null = null;

describe('RhinoExportDialog', () => {
  beforeEach(() => {
    unmountAll();
    clearDownloads();
    useViewerStore.setState({
      models: new Map([['model-1', makeModel()]]),
      hiddenEntities: new Set(),
      isolatedEntities: null,
    });
  });
  afterEach(() => {
    fake?.restore();
    fake = null;
    unmountAll();
  });

  it('exports the source bytes with the default options in the worker, downloads .3dm, and lists the warnings', async () => {
    fake = installFakeRhinoWorker(okDeps);
    const completions: Record<string, unknown>[] = [];
    const analytics = mock.method(posthog, 'capture', (event: string, properties: Record<string, unknown>) => {
      if (event === 'export_completed') completions.push(properties);
    });
    try {
      await openDialog();
      assert.ok(document.body.textContent?.includes('model-1.3dm'), 'filename preview names the .3dm');
      await runExport();

      assert.equal(fake.requests.length, 1, 'one worker request');
      const request = fake.requests[0];
      assert.deepEqual([...request.content], FILE_BYTES, 'the model bytes cross to the worker');
      assert.equal(request.version, 8, 'Rhino 8 archive by default');
      assert.deepEqual(request.options, {
        units: 'source', coordinates: 'local', layerScheme: 'spatial-class',
        instancing: true, properties: 'all', includeSpaces: true,
      });
      assert.equal(fake.terminated(), 1, 'the worker is terminated after the run');

      assert.deepEqual(downloadedNames(), ['model-1.3dm']);
      assert.equal(completions.length, 1);
      assert.equal(completions[0].format, '3dm');
      assert.equal(completions[0].surface, 'ribbon');

      const text = document.body.textContent ?? '';
      assert.ok(text.includes('Exported Rhino .3dm (2 KB)'), text);
      assert.ok(text.includes('length unit scale 0.5 is not a Rhino unit; wrote Meters'), 'the manifest warning is listed');
      assert.equal(document.querySelector('[data-rhino-export-progress]'), null, 'progress clears when done');
    } finally {
      analytics.mock.restore();
    }
  });

  it('"Only visible elements" sends the viewer visibility as local ids', async () => {
    fake = installFakeRhinoWorker(okDeps);
    const { typeVisibility } = useViewerStore.getState();
    useViewerStore.setState({
      typeVisibility: { ...typeVisibility, spaces: true },
      hiddenEntities: new Set([4]),
      isolatedEntities: new Set([4, 5]),
    });
    await openDialog();
    const toggle = document.body.querySelector<HTMLButtonElement>('button[aria-label="Only visible elements"]');
    assert.ok(toggle, 'the visible-only switch renders');
    await act(async () => toggle.click());
    await runExport();

    const { options } = fake.requests[0];
    assert.deepEqual(options.hidden, [4]);
    assert.deepEqual([...(options.isolated ?? [])].sort(), [4, 5]);
    // Class toggles are already folded into `hidden` by the store's visibility resolver.
    assert.equal(options.hiddenTypes, undefined, 'one visibility channel: no separate class list');
  });

  it('a model with no render geometry reads as that, not as the engine code', async () => {
    fake = installFakeRhinoWorker({
      ...okDeps,
      buildScene: async () => {
        throw new Error('NO_RENDER_GEOMETRY: export produced no render geometry (empty model or all meshes filtered out)');
      },
    });
    const completions: unknown[] = [];
    const analytics = mock.method(posthog, 'capture', (event: string, properties: unknown) => {
      if (event === 'export_completed') completions.push(properties);
    });
    try {
      await openDialog();
      await runExport();
      const text = document.body.textContent ?? '';
      assert.ok(text.includes('The Rhino export has nothing to write'), text);
      assert.ok(!text.includes('NO_RENDER_GEOMETRY'), 'the engine code is not shown');
      assert.equal(completions.length, 0, 'a refused export is not a completed download');
      assert.deepEqual(downloadedNames(), []);
    } finally {
      analytics.mock.restore();
    }
  });

  it('shows per-object progress, and Stop terminates the worker without downloading', async () => {
    let release: () => void = () => {};
    fake = installFakeRhinoWorker({
      buildScene: async () => ({ manifest: MANIFEST, blob: new Uint8Array() }),
      writeScene: async (_s, { onProgress }) => {
        onProgress(0, 2); onProgress(1, 2);
        await new Promise<void>((resolve) => { release = resolve; });
        return { bytes: new Uint8Array(1), warnings: ['length unit scale 0.5 is not a Rhino unit; wrote Meters'], objectCount: 2 };
      },
    });
    await openDialog();
    await runExport(false);
    const row = document.querySelector('[data-rhino-export-progress]');
    assert.equal(row?.getAttribute('data-rhino-export-progress'), 'objects');
    assert.ok(row?.textContent?.includes('Writing objects: 1 of 2'), row?.textContent ?? '');
    assert.equal(dialogButton('Cancel')?.disabled, true, 'Cancel is disabled mid-export (#5605)');

    const stop = dialogButton('Stop');
    assert.ok(stop, 'Stop renders while exporting');
    await act(async () => {
      stop.click();
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    release();
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });

    assert.equal(fake.terminated(), 1, 'Stop terminates the worker');
    assert.deepEqual(downloadedNames(), [], 'a stopped export downloads nothing');
    assert.ok(document.body.textContent?.includes('Rhino export stopped'));
    assert.equal(document.querySelector('[data-rhino-export-progress]'), null);
  });

  it('offers only .ifc / .ifczip models, like USD', async () => {
    useViewerStore.setState({ models: new Map([['model-1', makeModel('model.ifcx')]]) });
    await openDialog();
    assert.ok(document.body.textContent?.includes('No source available'));
    assert.equal(dialogButton('Export')?.disabled, true);
  });
});
