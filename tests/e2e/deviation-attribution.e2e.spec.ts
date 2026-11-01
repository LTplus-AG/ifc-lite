/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #6887 through the real viewer build: an IFC model and LAS scans loaded
 * through the canonical Open/Add path (`useIfcLoader.loadFile` ->
 * `ingestPointCloud`, decoded in the worker), deviation computed on the GPU,
 * and the Deviation CSV downloaded. Each scan's row must name the scan's own
 * model and carry its GlobalId, Name and IfcClass, in either federation order.
 * Before #6887 the row of a scan that was not model 0 named model 0 and left
 * GlobalId, Name and IfcClass empty.
 */

import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import type { ViewerState } from '../../apps/viewer/src/store';
import { DEVICE_LOST_STATE_ERROR, skipForGpuDeviceLoss, watchGpuDeviceLoss, type GpuDeviceLossWatch } from './gpu-device-loss';

declare global {
  var __ifc_lite_viewer_store__: { getState(): ViewerState };
}

const IFC = { name: 'building.ifc', mimeType: 'application/octet-stream', buffer: readFileSync('apps/viewer/public/samples/building-architecture.ifc') };

/** A 64-point LAS 1.2 (format 0, 1 cm scale) on a 25 cm grid; `z` in centimetres. */
function lasFile(name: string, z = 100) {
  const n = 64, header = 227, record = 20;
  const buffer = Buffer.alloc(header + n * record);
  buffer.write('LASF', 0, 'ascii');
  buffer.writeUInt8(1, 24); buffer.writeUInt8(2, 25);
  buffer.writeUInt16LE(header, 94); buffer.writeUInt32LE(header, 96);
  buffer.writeUInt16LE(record, 105); buffer.writeUInt32LE(n, 107);
  for (const at of [131, 139, 147]) buffer.writeDoubleLE(0.01, at);
  const coords = Array.from({ length: n }, (_, i) => [(i % 8) * 25, Math.floor(i / 8) * 25, z]);
  for (let axis = 0; axis < 3; axis++) {
    buffer.writeDoubleLE(Math.max(...coords.map((c) => c[axis])) / 100, 179 + axis * 16);
    buffer.writeDoubleLE(Math.min(...coords.map((c) => c[axis])) / 100, 187 + axis * 16);
  }
  coords.forEach((c, i) => c.forEach((v, axis) => buffer.writeInt32LE(v, header + i * record + axis * 4)));
  return { name, mimeType: 'application/octet-stream', buffer };
}

async function load(page: Page, gpu: GpuDeviceLossWatch, file: { name: string; mimeType: string; buffer: Buffer }, count: number) {
  await page.locator(count === 1 ? '#file-input-open' : '#file-input-add').setInputFiles(file);
  const outcome = await gpu.raceLoss(`load ${file.name}`, () => page.waitForFunction(({ n, deviceLost }) => {
    const state = globalThis.__ifc_lite_viewer_store__?.getState();
    if (!state) return false;
    if (new RegExp(deviceLost).test(String(state.error ?? ''))) return 'device-lost';
    const models = [...state.models.values()];
    if (models.some((m) => m.loadState === 'error')) return `error: ${models.map((m) => m.loadError).join(', ')}`;
    // The settled shape model-reposition.e2e waits for: a scan is settled once
    // its stream is registered, an IFC once it has meshes.
    return !state.loading && !state.geometryStreamingActive && models.length === n
      && models.every((m) => m.pointCloudHandleId !== undefined || (m.geometryResult?.meshes.length ?? 0) > 0) ? 'ok' : false;
  }, { n: count, deviceLost: DEVICE_LOST_STATE_ERROR.source }, { timeout: 120_000 }).then((h) => h.jsonValue())).catch(async (error) => {
    // raceLoss skips the instant the console reports the loss; this covers a loss only the toast shows.
    const found = await gpu.lost(500);
    if (found !== null) skipForGpuDeviceLoss(`load ${file.name}`, found);
    throw error;
  });
  if (outcome === 'device-lost') skipForGpuDeviceLoss(`load ${file.name}`, String(outcome));
  expect(outcome, `load ${file.name}`).toBe('ok');
}

/** Compute deviation in the point-cloud panel and return the downloaded CSV as row records. */
async function deviationCsv(page: Page): Promise<Array<Record<string, string>>> {
  await page.evaluate(() => globalThis.__ifc_lite_viewer_store__.getState().openWorkspacePanel('pointclouds', 'programmatic'));
  await page.getByRole('button', { name: 'Compute deviation', exact: true }).click();
  const exportButton = page.getByRole('button', { name: 'Export CSV', exact: true });
  await expect(exportButton).toBeEnabled({ timeout: 60_000 });
  const [download] = await Promise.all([page.waitForEvent('download'), exportButton.click()]);
  const text = readFileSync((await download.path())!, 'utf8');
  const [header, ...lines] = text.replace(/^﻿/, '').trimEnd().split(/\r?\n/);
  const columns = header.split(',');
  return lines.map((line) => Object.fromEntries(line.split(',').map((cell, i) => [columns[i], cell])));
}

function scanRow(rows: Array<Record<string, string>>, name: string) {
  const matching = rows.filter((row) => row.Name === name);
  expect(matching, `one row named ${name} in ${JSON.stringify(rows)}`).toHaveLength(1);
  return matching[0];
}

test('Deviation CSV names each scan row after its own model, IFC first (#6887)', async ({ page }, info) => {
  const gpu = await watchGpuDeviceLoss(page);
  await page.goto('/');
  await load(page, gpu, IFC, 1);
  await load(page, gpu, lasFile('survey.las'), 2);
  await load(page, gpu, lasFile('second.las', 150), 3);
  await gpu.skipIfLost('IFC + scans load');

  const rows = await gpu.requireLiveGpu('deviation compute and CSV', () => gpu.raceLoss('deviation compute and CSV', () => deviationCsv(page)));
  await info.attach('deviation CSV, IFC first', { body: JSON.stringify(rows, null, 2), contentType: 'application/json' });
  for (const name of ['survey.las', 'second.las']) {
    const row = scanRow(rows, name);
    expect(row.Model).toBe(name);
    expect(row.GlobalId).toMatch(/^pointcloud-\d+$/);
    expect(row.IfcClass).toBe('IfcGeographicElement');
  }
  await page.screenshot({ path: info.outputPath('deviation-attribution-ifc-first.png') });
});

test('Deviation CSV names the scan row after the scan model, scan first (#6887)', async ({ page }, info) => {
  const gpu = await watchGpuDeviceLoss(page);
  await page.goto('/');
  await load(page, gpu, lasFile('survey.las'), 1);
  await load(page, gpu, IFC, 2);
  await gpu.skipIfLost('scan + IFC load');

  const rows = await gpu.requireLiveGpu('deviation compute and CSV', () => gpu.raceLoss('deviation compute and CSV', () => deviationCsv(page)));
  await info.attach('deviation CSV, scan first', { body: JSON.stringify(rows, null, 2), contentType: 'application/json' });
  const row = scanRow(rows, 'survey.las');
  expect(row.Model).toBe('survey.las');
  expect(row.GlobalId).toMatch(/^pointcloud-\d+$/);
  expect(row.IfcClass).toBe('IfcGeographicElement');
});
