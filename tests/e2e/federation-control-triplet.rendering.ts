/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Real viewport evidence helpers for the federation control triplet. */
import { expect, type Page } from '@playwright/test';
import { inflateSync } from 'node:zlib';
import type { ViewerState } from '../../apps/viewer/src/store';

declare global {
  var __ifc_lite_viewer_store__: { getState(): ViewerState };
  var __ifc_lite_rendered_point_cloud__: ((handleId: number) => {
    pointCount: number;
    points: Point3[];
  } | null) | undefined;
}

type Point3 = readonly [number, number, number];
type ControlPoint = { id: string; local: Point3 };
type RenderPoint = (point: Point3) => { x: number; y: number; z: number };

interface DecodedPng { width: number; height: number; rgba: Uint8Array }
interface PixelDifference { regionPixels: number; changedPixels: number }

export interface RenderedModelEvidence {
  modelId: string;
  regionPixels: number | null;
  changedPixels: number | null;
  backgroundChangedPixels: number | null;
}

export interface OrdinarySelection {
  selectedEntityId: number | null;
  selectedEntity: { modelId: string; expressId: number } | null;
  selectedLandXmlSource: { modelId: string; sourceId: string } | null;
  selectedModelId: string | null;
}

/** Decode Chrome's 8-bit non-interlaced RGB/RGBA screenshots without a dependency. */
function decodePng(png: Uint8Array): DecodedPng {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  let offset = 8, width = 0, height = 0, channels = 0;
  const idat: Uint8Array[] = [];
  while (offset < png.length) {
    const length = view.getUint32(offset), type = String.fromCharCode(...png.subarray(offset + 4, offset + 8));
    const data = png.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = view.getUint32(offset + 8); height = view.getUint32(offset + 12);
      if (png[offset + 16] !== 8 || png[offset + 20] !== 0) throw new Error('Expected an 8-bit non-interlaced canvas PNG.');
      channels = png[offset + 17] === 6 ? 4 : png[offset + 17] === 2 ? 3 : 0;
      if (channels === 0) throw new Error('Expected an RGB or RGBA canvas PNG.');
    } else if (type === 'IDAT') idat.push(data);
    offset += length + 12;
    if (type === 'IEND') break;
  }
  if (width === 0 || height === 0 || idat.length === 0) throw new Error('Canvas screenshot is not a complete PNG.');
  const stride = width * channels, raw = inflateSync(Buffer.concat(idat)), rgba = new Uint8Array(width * height * 4);
  const previous = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!, source = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    if (filter > 4) throw new Error(`Unsupported PNG scanline filter ${filter}.`);
    const line = new Uint8Array(stride);
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? line[i - channels]! : 0, b = previous[i]!, c = i >= channels ? previous[i - channels]! : 0;
      const predictor = filter === 1 ? a : filter === 2 ? b : filter === 3 ? (a + b) >> 1 : filter === 4 ? paeth(a, b, c) : 0;
      line[i] = (source[i]! + predictor) & 255;
    }
    for (let x = 0; x < width; x++) {
      const from = x * channels, to = (y * width + x) * 4;
      rgba[to] = line[from]!; rgba[to + 1] = line[from + 1]!; rgba[to + 2] = line[from + 2]!; rgba[to + 3] = channels === 4 ? line[from + 3]! : 255;
    }
    previous.set(line);
  }
  return { width, height, rgba };
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/** Framing centres the fitted model; ignore dynamic viewport-edge pixels. */
function centralPixelDifference(first: DecodedPng, second: DecodedPng): PixelDifference {
  if (first.width !== second.width || first.height !== second.height) throw new Error('Canvas screenshot dimensions changed during a comparison.');
  const left = Math.floor(first.width * 0.15), right = Math.ceil(first.width * 0.85);
  const top = Math.floor(first.height * 0.15), bottom = Math.ceil(first.height * 0.85);
  let changedPixels = 0;
  for (let y = top; y < bottom; y++) for (let x = left; x < right; x++) {
    const offset = (y * first.width + x) * 4;
    const difference = Math.abs(first.rgba[offset]! - second.rgba[offset]!)
      + Math.abs(first.rgba[offset + 1]! - second.rgba[offset + 1]!)
      + Math.abs(first.rgba[offset + 2]! - second.rgba[offset + 2]!)
      + Math.abs(first.rgba[offset + 3]! - second.rgba[offset + 3]!);
    if (difference >= 24) changedPixels++;
  }
  return { regionPixels: (right - left) * (bottom - top), changedPixels };
}

export async function snapshotRenderedPointCloud(page: Page, handleId: number, timeout: number): Promise<{ pointCount: number; points: Point3[] }> {
  await page.waitForFunction((handle) => {
    const snapshot = globalThis.__ifc_lite_rendered_point_cloud__?.(handle);
    return snapshot !== null && snapshot !== undefined && snapshot.points.length > 0;
  }, handleId, { timeout });
  return page.evaluate((handle) => {
    const snapshot = globalThis.__ifc_lite_rendered_point_cloud__?.(handle);
    if (!snapshot) throw new Error(`rendered point-cloud snapshot unavailable for handle ${handle}`);
    return snapshot;
  }, handleId);
}

async function showOnlyModelAndFrame(page: Page, modelId: string): Promise<void> {
  await page.evaluate((id) => {
    const state = globalThis.__ifc_lite_viewer_store__.getState();
    state.clearEntitySelection();
    state.setModelsVisibility([...state.models.keys()], false);
    state.setModelVisibility(id, true);
    state.openReposition([id]);
  }, modelId);
  await page.waitForFunction((id) => {
    const models = globalThis.__ifc_lite_viewer_store__.getState().models;
    return [...models].filter(([, model]) => model.visible).map(([modelId]) => modelId).join(',') === id;
  }, modelId);
  await page.getByRole('button', { name: 'Frame moving', exact: true }).click();
  await page.waitForTimeout(500); // fitting is animated; wait for a painted frame
  await page.keyboard.press('Escape');
}

export async function assertIsolatedRenderedContent(page: Page, modelId: string, gpuStrict: boolean): Promise<RenderedModelEvidence> {
  await showOnlyModelAndFrame(page, modelId);
  if (!gpuStrict) {
    console.log(`[e2e] E2E_GPU_STRICT=0 — skipping ${modelId} isolated pixel assertion (software WebGPU)`);
    return { modelId, regionPixels: null, changedPixels: null, backgroundChangedPixels: null };
  }
  const canvas = page.locator('canvas[data-viewport="main"]');
  await expect(canvas, 'viewer canvas').toBeVisible();
  const renderedPng = await canvas.screenshot();
  const rendered = decodePng(renderedPng);
  await page.evaluate(() => {
    const state = globalThis.__ifc_lite_viewer_store__.getState();
    state.setModelsVisibility([...state.models.keys()], false);
  });
  await page.waitForTimeout(250);
  const blankPng = await canvas.screenshot();
  const blank = decodePng(blankPng);
  // A second blank establishes the canvas' animation/noise floor. Frame moving
  // puts the model in this central region, unlike independently changing edges.
  await page.waitForTimeout(250);
  const blankRepeat = decodePng(await canvas.screenshot());
  const signal = centralPixelDifference(rendered, blank), background = centralPixelDifference(blank, blankRepeat);
  const minimumSignal = Math.max(64, background.changedPixels * 3);
  expect(signal.changedPixels,
    `${modelId}: ${signal.changedPixels}/${signal.regionPixels} fitted-region pixels differ from blank (background ${background.changedPixels}; PNG ${renderedPng.length}B -> ${blankPng.length}B)`)
    .toBeGreaterThan(minimumSignal);
  return { modelId, regionPixels: signal.regionPixels, changedPixels: signal.changedPixels, backgroundChangedPixels: background.changedPixels };
}

export async function ordinaryGpuSelectControl(
  page: Page, modelId: string, control: ControlPoint, toRender: RenderPoint, gpuStrict: boolean,
): Promise<OrdinarySelection> {
  await showOnlyModelAndFrame(page, modelId);
  if (!gpuStrict) {
    console.log(`[e2e] E2E_GPU_STRICT=0 — skipping ${modelId} ordinary GPU selection assertion (software WebGPU)`);
    return page.evaluate(selectionSnapshot);
  }
  const projected = await page.evaluate((point) => globalThis.__ifc_lite_viewer_store__.getState()
    .cameraCallbacks.projectToScreen!(point), toRender(control.local));
  expect(projected, `${control.id}: isolated ${modelId} control projects into the viewer`).not.toBeNull();
  const canvas = await page.locator('canvas[data-viewport="main"]').boundingBox();
  expect(canvas, 'viewer canvas').not.toBeNull();
  const clickTarget = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.tagName ?? null, {
    x: canvas!.x + projected!.x,
    y: canvas!.y + projected!.y,
  });
  expect(clickTarget, `${control.id}: ${modelId} projected control is not covered by a viewport panel`).toBe('CANVAS');
  const revision = await page.evaluate(() => globalThis.__ifc_lite_viewer_store__.getState().selectionRevision);
  await page.mouse.click(canvas!.x + projected!.x, canvas!.y + projected!.y);
  await expect.poll(
    () => page.evaluate(() => globalThis.__ifc_lite_viewer_store__.getState().selectionRevision),
    { message: `${control.id}: ${modelId} ordinary GPU pick completes` },
  ).toBeGreaterThan(revision);
  return page.evaluate(selectionSnapshot);
}

function selectionSnapshot(): OrdinarySelection {
  const state = globalThis.__ifc_lite_viewer_store__.getState();
  return { selectedEntityId: state.selectedEntityId, selectedEntity: state.selectedEntity,
    selectedLandXmlSource: state.selectedLandXmlSource, selectedModelId: state.selectedModelId };
}
