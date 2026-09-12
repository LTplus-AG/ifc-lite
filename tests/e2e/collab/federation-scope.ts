/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Page-level helpers specific to the federation-scope acceptance (#4444):
 * two copies of one file in one room, told apart only by their slot. Built on
 * the shared relay harness (`relay.ts`, `preview.ts`, `viewer-page.ts`); the
 * viewer store is read through `globalThis.__ifc_lite_viewer_store__` like
 * the other E2E specs, and every user action goes through the product UI
 * (file inputs, Appearance workspace, Elements ribbon, canvas clicks, Export
 * dialog) — the store is only read, plus the two selection setters a click in
 * the hierarchy would call.
 */

import { expect, type Page } from '@playwright/test';
import { deflateSync } from 'node:zlib';
import type { ViewerState } from '../../../apps/viewer/src/store';

declare global {
  var __ifc_lite_viewer_store__: { getState(): ViewerState };
}

export const LOAD_TIMEOUT_MS = 180_000;

// ── a solid-colour PNG as an appearance source ──────────────────────────────

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    let c = (crc ^ byte) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typed = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed));
  return Buffer.concat([length, typed, crc]);
}

/**
 * `size`×`size` pixels of one colour, 8-bit RGB: uploaded through the
 * Appearance workspace's own file picker, and the oracle a guest's decoded
 * texture blob must read back.
 */
export function solidPng(rgb: readonly [number, number, number], size = 8): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour
  const stride = size * 3 + 1;
  const raw = Buffer.alloc(stride * size);
  for (let y = 0; y < size; y++) {
    raw[y * stride] = 0; // filter: none
    for (let x = 0; x < size; x++) raw.set(rgb, y * stride + 1 + x * 3);
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// ── loading and the room ────────────────────────────────────────────────────

/** Every model has finished loading and carries meshes. */
export async function waitForLoadedModels(page: Page, count: number): Promise<void> {
  await page.waitForFunction(
    (n) => {
      const s = globalThis.__ifc_lite_viewer_store__.getState();
      return (
        !s.loading &&
        !s.geometryStreamingActive &&
        s.models.size === n &&
        [...s.models.values()].every(
          (m) => (m.geometryResult?.meshes.length ?? 0) > 0 && (!m.loadState || m.loadState === 'complete'),
        )
      );
    },
    count,
    { timeout: LOAD_TIMEOUT_MS },
  );
}

/** Load a file through the viewer's own file inputs: the first is Open, the second Add Model. */
export async function loadFile(page: Page, file: string, expectedCount: number): Promise<void> {
  await page.locator('input[type=file]').nth(expectedCount === 1 ? 0 : 1).setInputFiles(file);
  await waitForLoadedModels(page, expectedCount);
}

/**
 * A recipient's room has every slot registered as a model and hydrated: the
 * mesh count of each room model is positive and unchanged across `settleMs`.
 * Best-effort hydration has no completion event, so quiescence is the signal.
 */
export async function waitForRoomModels(page: Page, count: number, settleMs = 3000): Promise<void> {
  await page.waitForFunction(
    (n) => {
      const s = globalThis.__ifc_lite_viewer_store__.getState();
      return s.collabRoomId !== null && s.collabRoomModels.size === n && s.models.size === n;
    },
    count,
    { timeout: LOAD_TIMEOUT_MS },
  );
  const counts = () =>
    page.evaluate(() =>
      [...globalThis.__ifc_lite_viewer_store__.getState().models.values()].map((m) => m.geometryResult?.meshes.length ?? 0),
    );
  const deadline = Date.now() + LOAD_TIMEOUT_MS;
  let previous = await counts();
  while (Date.now() < deadline) {
    await page.waitForTimeout(settleMs);
    const next = await counts();
    if (next.every((c) => c > 0) && next.join() === previous.join()) return;
    previous = next;
  }
  throw new Error(`room models did not settle: ${previous.join(',')}`);
}

export interface RoomStats {
  slots: string[];
  entitiesPerSlot: Record<string, number>;
  refsPerSlot: Record<string, number>;
  geometryRecords: number;
  seedMarker: unknown;
}

/** The room's document per slot, read through the page's live session. */
export function roomStats(page: Page): Promise<RoomStats> {
  return page.evaluate(() => {
    const doc = globalThis.__ifc_lite_viewer_store__.getState().collabSession!.doc;
    const slots = [...doc.getMap('models').keys()].sort();
    const entitiesPerSlot: Record<string, number> = {};
    const refsPerSlot: Record<string, number> = {};
    for (const [path, entity] of doc.getMap('entities').entries()) {
      const slot = /^\/(m\d+)\//.exec(path)?.[1] ?? '(unqualified)';
      entitiesPerSlot[slot] = (entitiesPerSlot[slot] ?? 0) + 1;
      const ref = (entity as { get(key: string): unknown }).get('geometryRef') as { get(key: string): unknown } | undefined;
      const ids = ref?.get('geomIds');
      refsPerSlot[slot] = (refsPerSlot[slot] ?? 0) + (Array.isArray(ids) ? ids.length : 0);
    }
    return { slots, entitiesPerSlot, refsPerSlot, geometryRecords: doc.getMap('geometry').size, seedMarker: doc.getMap('meta').get('geometrySeed') };
  });
}

// ── the member both copies paint ────────────────────────────────────────────

/** The member's global viewer id in `modelId`, found by the one identity that survives the room (its GlobalId). */
export function memberIn(page: Page, modelId: string, guid: string) {
  return page.evaluate(
    ({ modelId, guid }) => {
      const s = globalThis.__ifc_lite_viewer_store__.getState();
      const m = s.models.get(modelId)!;
      const store = m.ifcDataStore!;
      for (let local = 0; local <= m.maxExpressId; local++) {
        const g = store.entities.getGlobalId(local);
        // Bare (owner's STEP store), legacy room (`/<guid>`) or slot-qualified (`/m1/<guid>`).
        if (g === guid || g === `/${guid}` || (/^\/m\d+\//.test(g ?? '') && g!.endsWith(`/${guid}`))) {
          const global = m.idOffset + local;
          const meshes = m.geometryResult!.meshes.filter((x) => x.expressId === global);
          // The colour the member renders with: its decoded texture sampled at
          // its first vertex's UV (the image may sit in a shared atlas page, so
          // pixel (0,0) is not the member's).
          const textured = meshes.find((x) => x.texture && x.uvs);
          let texturePixel: number[] | null = null;
          if (textured?.texture && textured.uvs) {
            const { width, height, rgba } = textured.texture;
            const u = textured.uvs[0] - Math.floor(textured.uvs[0]);
            const v = textured.uvs[1] - Math.floor(textured.uvs[1]);
            const px = Math.min(width - 1, Math.floor(u * width));
            const py = Math.min(height - 1, Math.floor(v * height));
            texturePixel = Array.from(rgba.slice((py * width + px) * 4, (py * width + px) * 4 + 3));
          }
          // The room's texture blob for this member (recipient side; an owner's store is not keyed by room path).
          const doc = s.collabSession?.doc;
          const geomIds = (doc?.getMap('entities').get(g!) as { get(k: string): unknown } | undefined)?.get('geometryRef') as { get(k: string): unknown } | undefined;
          const ids = geomIds?.get('geomIds');
          const first = Array.isArray(ids) ? (doc!.getMap('geometry').get(ids[0]) as { get(k: string): unknown } | undefined) : undefined;
          const params = first?.get('params') as { get(k: string): unknown } | undefined;
          return {
            modelId, local, global, storedGlobalId: g, meshCount: meshes.length,
            textureSize: textured?.texture ? [textured.texture.width, textured.texture.height] : null,
            texturePixel,
            textureBlobHash: (params?.get('textureBlobHash') as string | undefined) ?? null,
            textureRef: meshes.map((x) => x.textureRef?.url ?? null).find((u) => u) ?? null,
          };
        }
      }
      throw new Error(`${guid} not in ${modelId}`);
    },
    { modelId, guid },
  );
}

/** Apply a solid-colour image appearance to `global` (a member of `modelId`) through the Appearance workspace. */
export async function paintMember(page: Page, modelId: string, global: number, name: string, rgb: [number, number, number]): Promise<void> {
  const ws = page.getByLabel('Appearance workspace');
  await page.evaluate(({ modelId, global }) => {
    const s = globalThis.__ifc_lite_viewer_store__.getState();
    s.setActiveModel(modelId);
    s.setSelectedEntityIds([global]);
    s.setSelectedEntityId(global);
  }, { modelId, global });
  await ws.getByLabel('Appearance model').selectOption(modelId);
  await ws.getByLabel('Upload appearance source').setInputFiles({ name, mimeType: 'image/png', buffer: solidPng(rgb) });
  await ws.getByLabel('Appearance scope').selectOption('selection');
  // The member is a mapped occurrence: the workspace converts it to a mesh (#4404).
  await ws.getByLabel('Convert supported objects to mesh').check();
  await ws.getByLabel('Texture mapping').selectOption('box');
  await ws.getByLabel('Tile X (m)').fill('0.5');
  // The workspace's live status line (role flips to alert on a planner refusal).
  const status = ws.locator('[aria-live="polite"]:is([role="status"], [role="alert"])');
  await expect(status).toContainText('Preview ready', { timeout: 120_000 });
  await ws.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect(status).toContainText('Appearance applied', { timeout: 120_000 });
}

/**
 * Click the member through the canvas; returns what the pick resolved to. The
 * other copy is hidden (its identical geometry sits at the same place), the
 * member framed, and the click lands on the projected centre of one of its own
 * triangles. The member is a rafter inside the roof slab, so as a user would,
 * whatever the click hits instead is hidden (Elements → Hide selection) and
 * the click repeated, until the member itself is selected.
 */
export async function pickMember(page: Page, modelId: string, otherModelId: string, global: number, onHit?: () => Promise<void>) {
  await page.evaluate(({ modelId, otherModelId, global }) => {
    const s = globalThis.__ifc_lite_viewer_store__.getState();
    s.setModelVisibility(otherModelId, false);
    s.setModelVisibility(modelId, true);
    s.setSelectedEntityId(null);
    s.cameraCallbacks.frameEntities?.([global]);
  }, { modelId, otherModelId, global });
  await page.waitForTimeout(700);
  const canvas = await page.locator('canvas').first().boundingBox();
  expect(canvas).not.toBeNull();
  const points = await page.evaluate(({ modelId, global, width, height }) => {
    const s = globalThis.__ifc_lite_viewer_store__.getState();
    const project = s.cameraCallbacks.projectToScreen!;
    const out: Array<{ x: number; y: number }> = [];
    for (const mesh of s.models.get(modelId)!.geometryResult!.meshes) {
      if (mesh.expressId !== global) continue;
      const o = mesh.origin ?? [0, 0, 0];
      const p = mesh.positions;
      for (let i = 0; i + 2 < mesh.indices.length; i += 3) {
        const c = [0, 1, 2].map((k) => (p[mesh.indices[i] * 3 + k] + p[mesh.indices[i + 1] * 3 + k] + p[mesh.indices[i + 2] * 3 + k]) / 3 + o[k]);
        const q = project({ x: c[0], y: c[1], z: c[2] });
        if (q && q.x >= 0 && q.y >= 0 && q.x <= width && q.y <= height) out.push(q);
      }
    }
    return out;
  }, { modelId, global, width: canvas!.width, height: canvas!.height });
  expect(points.length).toBeGreaterThan(0);
  const selection = () =>
    page.evaluate(() => {
      const s = globalThis.__ifc_lite_viewer_store__.getState();
      return { selected: s.selectedEntityId, lookup: s.selectedEntityId === null ? null : s.resolveGlobalIdFromModels(s.selectedEntityId) };
    });
  let resolved = await selection();
  const hidden: number[] = [];
  let clicks = 0;
  for (let round = 0; round < 6 && resolved.selected !== global; round++) {
    // A click on the already-selected element toggles it off, so remember
    // what the round hit rather than trusting the last state alone.
    let occluder: number | null = null;
    for (const q of points) {
      await page.mouse.click(canvas!.x + q.x, canvas!.y + q.y);
      clicks += 1;
      // The pick resolves asynchronously (GPU readback); give it a moment.
      await page.waitForFunction(() => globalThis.__ifc_lite_viewer_store__.getState().selectedEntityId !== null, null, { timeout: 1500 }).catch(() => undefined);
      resolved = await selection();
      if (resolved.selected === global) break;
      if (resolved.selected !== null) occluder = resolved.selected;
    }
    if (resolved.selected === global) {
      await onHit?.();
      break;
    }
    if (occluder === null) break;
    // Something in front: hide it and try again.
    hidden.push(occluder);
    await page.evaluate((id) => {
      const s = globalThis.__ifc_lite_viewer_store__.getState();
      s.setSelectedEntityIds([id]);
      s.setSelectedEntityId(id);
    }, occluder);
    await page.getByRole('tab', { name: 'Elements' }).click();
    await page.getByRole('button', { name: 'Hide selection' }).click();
    await page.waitForTimeout(300);
  }
  await page.evaluate((otherModelId) => globalThis.__ifc_lite_viewer_store__.getState().setModelVisibility(otherModelId, true), otherModelId);
  if (hidden.length > 0) {
    await page.getByRole('tab', { name: 'Elements' }).click();
    await page.getByRole('button', { name: 'Show all (reset filters)' }).click();
  }
  return { ...resolved, clicks, hiddenOccluders: hidden };
}

// ── export ──────────────────────────────────────────────────────────────────

export interface ExportedIfcx {
  filename: string;
  file: { data: { path: string; children?: Record<string, string>; attributes?: Record<string, unknown> }[] };
}

/** Export one room model to `.ifcx` through the Export dialog; returns the parsed download. */
export async function exportRoomModel(page: Page, modelName: string): Promise<ExportedIfcx> {
  await page.getByRole('tab', { name: 'File' }).click();
  await page.getByRole('button', { name: 'Export IFC (with changes)' }).click();
  const dialog = page.getByRole('dialog', { name: 'Export IFC File' });
  // Radix selects: the trigger shows the current value, so find each by what it shows.
  await dialog.getByRole('combobox').filter({ hasText: /AC20-FZK-Haus|Select model/ }).click();
  // Options read "<name> (<schema>)" — a room model is IFC5.
  await page.getByRole('option', { name: `${modelName} (IFC5)`, exact: true }).click();
  // The schema follows the model: a room model is IFC5, so the output is .ifcx.
  await expect(dialog.getByRole('combobox').filter({ hasText: /^IFC5 \(Alpha\)/ })).toBeVisible();
  await expect(dialog.getByText('.ifcx')).toBeVisible();
  const download = page.waitForEvent('download');
  await dialog.getByRole('button', { name: 'Export', exact: true }).click();
  const file = await download;
  const chunks: Buffer[] = [];
  for await (const chunk of await file.createReadStream()) chunks.push(chunk as Buffer);
  const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as ExportedIfcx['file'];
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  return { filename: file.suggestedFilename(), file: parsed };
}
