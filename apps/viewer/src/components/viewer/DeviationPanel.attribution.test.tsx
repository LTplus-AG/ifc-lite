/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #6887: the Deviation CSV names a scan's row after the scan's own model, in
 * any federation order, at `models.size` 1 and N, and after a removal.
 *
 * The scan is a real LAS streamed through `ingestPointCloud` into a real
 * `PointCloudRenderer` and registered as `loadFile` registers it
 * (`test/scan-federation.ts`). The readback the panel receives carries exactly
 * the per-asset identity `readDeviationDistances` would read off those nodes.
 * Before the fix the scan row of an IFC-first federation was attributed to
 * the IFC model, with GlobalId, Name and IfcClass empty.
 */

import '@/test/setup-dom.js';
import { afterEach, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { LasStreamingSource } from '@ifc-lite/pointcloud';
import type { DeviationDistances, PointCloudRenderer, Renderer } from '@ifc-lite/renderer';
import { cleanup, click, render, waitFor } from '@/test/render.js';
import { setGlobalRendererRef } from '@/hooks/useBCF';
import { useViewerStore } from '@/store';
import { modelIndices } from '@/lib/model-placement/model-indices';
import { removePointCloudScanCache } from '@/hooks/ingest/pointCloudScanCache';
import { unregisterPointCloudAlignment } from '@/hooks/ingest/pointCloudAlignment';
import { addIfcModel, loadScan, readbackIdentities, scanTestRenderer } from '@/test/scan-federation';
import { DeviationPanel } from './DeviationPanel.js';

const handles: number[] = [];
afterEach(() => {
  cleanup();
  setGlobalRendererRef({ current: null });
  for (const id of handles.splice(0)) { removePointCloudScanCache(id); unregisterPointCloudAlignment(id); }
  useViewerStore.getState().clearAllModels();
  useViewerStore.getState().setPointCloudDeviationComputed(false);
  useViewerStore.getState().setPointCloudColorMode('rgb');
  modelIndices(new Map());
});

/** A 4-point LAS 1.2 (format 0, scale 1) at integer coordinates. */
function lasBlob(): Blob {
  const pts = [[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1]];
  const view = new DataView(new ArrayBuffer(227 + pts.length * 20));
  view.setUint32(0, 0x4653414c, true);
  view.setUint8(24, 1);
  view.setUint8(25, 2);
  view.setUint16(94, 227, true);
  view.setUint32(96, 227, true);
  view.setUint16(105, 20, true);
  view.setUint32(107, pts.length, true);
  for (const at of [131, 139, 147]) view.setFloat64(at, 1, true);
  for (const at of [179, 195, 211]) view.setFloat64(at, 1, true);
  pts.forEach((p, i) => p.forEach((v, axis) => view.setInt32(227 + i * 20 + axis * 4, v, true)));
  return new Blob([view.buffer]);
}

async function addScan(renderer: Renderer, id: string) {
  const { handle } = await loadScan(renderer, id, {
    format: 'las', blob: lasBlob(),
    createSource: (o) => new LasStreamingSource(o.blob, { downsample: { stride: o.stride ?? 1 }, originOffset: o.originOffset }),
  });
  handles.push(handle.id);
}

/** The panel's renderer: compute succeeds, and the readback carries the uploaded assets' identities. */
function useDeviationRenderer(points: PointCloudRenderer) {
  const distances: DeviationDistances = { values: new Float32Array(0), assets: [] };
  for (const identity of readbackIdentities(points)) {
    const values = new Float32Array([0.004, -0.002, 0.03]);
    distances.assets.push({ ...identity, offset: distances.values.length, count: values.length });
    distances.values = Float32Array.from([...distances.values, ...values]);
  }
  setGlobalRendererRef({
    current: {
      async computeDeviations() {
        return { bvhTriangles: 12, bvhNodes: 1, chunksProcessed: 1, pointsProcessed: distances.values.length, bounds: null, suggestedHalfRange: 0.05 };
      },
      async readDeviationDistances() { return distances; },
    } as unknown as Renderer,
  });
}

/** Compute, export, and return the CSV's rows as column → cell records. */
async function exportCsv(): Promise<Array<Record<string, string>>> {
  const container = render(<DeviationPanel triangleCount={12} />);
  const button = (label: string) => [...container.querySelectorAll('button')].find((b) => b.textContent === label);
  click(container.querySelector('button') as HTMLButtonElement);
  await waitFor(() => button('Export CSV') !== undefined, 'readback held');
  const originalCreate = URL.createObjectURL;
  const originalClick = HTMLAnchorElement.prototype.click;
  const blobs: Blob[] = [];
  URL.createObjectURL = ((b: Blob) => { blobs.push(b); return 'blob:deviation-attribution'; }) as typeof URL.createObjectURL;
  HTMLAnchorElement.prototype.click = () => {};
  try {
    await act(async () => { click(button('Export CSV')!); });
    await waitFor(() => blobs.length === 1, 'CSV downloaded');
  } finally {
    URL.createObjectURL = originalCreate;
    HTMLAnchorElement.prototype.click = originalClick;
  }
  const [header, ...lines] = (await blobs[0].text()).trimEnd().split('\n');
  const columns = header.split(',');
  return lines.map((line) => Object.fromEntries(line.split(',').map((cell, i) => [columns[i], cell])));
}

/** The one scan's row: a single asset has no pooled summary row. */
function scanRow(rows: Array<Record<string, string>>) {
  assert.equal(rows.length, 1);
  return rows[0];
}

const WALL = { expressId: 7, type: 'IfcWall', name: 'Wall', globalId: '2O2Fr$t4X7Zf8NOew3FLOH' };

it('DeviationPanel #6887 names an IFC-first federation\'s scan row after the scan model', async () => {
  const { renderer, points } = scanTestRenderer();
  addIfcModel('building', [WALL]);
  await addScan(renderer, 'survey');
  useDeviationRenderer(points);

  const row = scanRow(await exportCsv());
  const ref = useViewerStore.getState().resolveGlobalIdFromModels(readbackIdentities(points)[0].expressId)!;
  assert.equal(row.Model, 'survey.las');
  assert.equal(row.GlobalId, `pointcloud-${ref.expressId}`);
  assert.equal(row.Name, 'survey.las');
  assert.equal(row.IfcClass, 'IfcGeographicElement');
});

it('DeviationPanel #6887 names a scan-first federation\'s scan row after the scan model', async () => {
  const { renderer, points } = scanTestRenderer();
  await addScan(renderer, 'survey');
  addIfcModel('building', [WALL]);
  useDeviationRenderer(points);

  const row = scanRow(await exportCsv());
  assert.equal(row.Model, 'survey.las');
  assert.match(row.GlobalId, /^pointcloud-\d+$/);
  assert.equal(row.Name, 'survey.las');
  assert.equal(row.IfcClass, 'IfcGeographicElement');
});

it('DeviationPanel #6887 fills GlobalId, Name and IfcClass for a lone scan (models.size 1)', async () => {
  const { renderer, points } = scanTestRenderer();
  await addScan(renderer, 'survey');
  useDeviationRenderer(points);

  const row = scanRow(await exportCsv());
  assert.equal('Model' in row, false, 'a single model has no Model column');
  assert.match(row.GlobalId, /^pointcloud-\d+$/);
  assert.equal(row.Name, 'survey.las');
  assert.equal(row.IfcClass, 'IfcGeographicElement');
});

it('DeviationPanel #6887 keeps two scans apart around an IFC model, and after the first model is removed', async () => {
  const { renderer, points } = scanTestRenderer();
  await addScan(renderer, 'north');
  addIfcModel('building', [WALL]);
  await addScan(renderer, 'south');

  useDeviationRenderer(points);
  const before = await exportCsv();
  assert.deepEqual(before.filter((r) => r.IfcClass).map((r) => r.Model).sort(), ['north.las', 'south.las']);
  cleanup();

  // Removing the first model frees its scan; the survivors keep their ids and indices.
  const northHandle = useViewerStore.getState().models.get('north')!.pointCloudHandleId!;
  useViewerStore.getState().removeModel('north');
  points.removeAsset({ id: northHandle });
  useViewerStore.getState().setPointCloudDeviationComputed(false);
  useDeviationRenderer(points);
  const after = await exportCsv();
  assert.equal(after.length, 1);
  assert.equal(after[0].Model, 'south.las');
  assert.match(after[0].GlobalId, /^pointcloud-\d+$/);
});
