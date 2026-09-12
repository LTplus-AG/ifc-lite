/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Page-level helpers for the relay acceptance (#4446). State is read through
 * the Zustand singleton the app registers at
 * `globalThis.__ifc_lite_viewer_store__` (store/index.ts) — the same hook the
 * viewer smoke E2E uses — and the room's contents through the live
 * `collabSession.doc` on that store. Nothing here is a product surface added
 * for the test.
 */

import { expect, type BrowserContext, type Page } from '@playwright/test';

const STORE_KEY = '__ifc_lite_viewer_store__';

/** The counts the issue reports for a room: structural entries and geometry records. */
export interface RoomCounts {
  /** `doc.getMap('entities').size` — the "structural entries". */
  entities: number;
  /** `doc.getMap('geometry').size` — content-addressed mesh blobs (the "geometry entries"). */
  geometryRecords: number;
  /** Geometry records whose `params.textureBlobHash` is set — textures that travel as separate blobs. */
  texturedRecords: number;
  /** (entity, geomId) references — what a joiner hydrates, one mesh each. */
  geometryRefs: number;
  modelSlots: number;
}

/** Byte fingerprints of one mesh, comparable across owner and guest. */
export interface MeshFingerprint {
  triangles: number;
  vertices: number;
  positions: string;
  uvs: string | null;
  /** FNV-1a of the decoded RGBA pixels, plus dimensions. */
  texture: { width: number; height: number; rgbaFnv1a: string } | null;
}

/**
 * Point a fresh context at the relay before any app script runs: the collab
 * flag and the server URL both have a per-browser `localStorage` override
 * (`apps/viewer/src/lib/collab/config.ts`), so the ordinary `vite preview`
 * build on :3000 becomes a collab-enabled viewer without a rebuild.
 */
export async function enableCollab(context: BrowserContext, wsUrl: string): Promise<void> {
  await context.addInitScript((url: string) => {
    try {
      localStorage.setItem('ifc-lite:collab:enabled', 'true');
      localStorage.setItem('ifc-lite:collab:server-url', url);
      // The default is the ribbon; the tab strip is session-local, so opening
      // File is part of every flow below anyway. Pin it so the spec is not
      // sensitive to a persisted classic-strip preference on this profile.
      localStorage.removeItem('ifc-lite-toolbar-style');
    } catch {
      // Init scripts also run in about:blank / opaque-origin frames, where
      // storage is denied; the viewer's own document is what matters.
    }
  }, wsUrl);
}

/**
 * Collect what a context's pages say about the room — `[collab]`-tagged
 * console lines, page errors and WebSocket closures (code + reason, which
 * Playwright's own `websocket` event does not expose) — for the evidence JSON.
 */
export async function collectCollabLog(context: BrowserContext, sink: string[]): Promise<void> {
  await context.addInitScript(() => {
    const Native = WebSocket;
    (window as unknown as { WebSocket: unknown }).WebSocket = class extends Native {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        this.addEventListener('close', (e) => {
          const { code, reason, wasClean } = e as CloseEvent;
          console.log(`[collab-ws] close code=${code} reason=${JSON.stringify(reason)} clean=${wasClean}`);
        });
      }
    };
  });
  context.on('page', (page) => {
    page.on('console', (m) => {
      if (m.type() === 'error' || /\[collab/.test(m.text())) sink.push(`${m.type()}: ${m.text().slice(0, 400)}`);
    });
    page.on('pageerror', (err) => sink.push(`pageerror: ${String(err).slice(0, 400)}`));
    page.on('response', (res) => {
      if (res.status() >= 400) sink.push(`http ${res.status()}: ${res.url().slice(0, 200)}`);
    });
  });
}

/** Open the viewer at `url` and wait until the file input exists. */
export async function openViewer(context: BrowserContext, url: string): Promise<Page> {
  const page = await context.newPage();
  await page.goto(url);
  await page.waitForSelector('input[type="file"]', { state: 'attached', timeout: 60_000 });
  return page;
}

/** Evaluate `pick` (a JS expression over `state`) against the live store. */
export async function storeState<T>(page: Page, pick: string): Promise<T> {
  return page.evaluate(
    ({ key, pickExpr }) => {
      const store = (globalThis as unknown as Record<string, { getState(): unknown } | undefined>)[key];
      if (!store) throw new Error(`viewer store singleton ${key} not found`);
      // eslint-disable-next-line no-new-func
      return new Function('state', `return (${pickExpr});`)(store.getState());
    },
    { key: STORE_KEY, pickExpr: pick },
  ) as Promise<T>;
}

/** Poll `pick` until it is truthy (or `until` says so); returns the last value. */
export async function waitForStore<T>(
  page: Page,
  pick: string,
  until: (v: T) => boolean,
  timeoutMs: number,
  label = pick,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: T | undefined;
  while (Date.now() < deadline) {
    last = await storeState<T>(page, pick);
    if (until(last)) return last;
    await page.waitForTimeout(150);
  }
  throw new Error(`${label} did not settle within ${timeoutMs}ms; last: ${JSON.stringify(last)}`);
}

/**
 * Record every `collabSeedPhase` transition with a timestamp through the
 * store's own `subscribe` (polling would miss the sub-100 ms phases).
 */
export async function traceSeedPhases(page: Page): Promise<void> {
  await page.evaluate((key) => {
    const store = (globalThis as unknown as Record<string, { getState(): { collabSeedPhase: string }; subscribe(fn: (s: { collabSeedPhase: string }) => void): void } | undefined>)[key];
    if (!store) throw new Error(`viewer store singleton ${key} not found`);
    const trace: Array<{ phase: string; at: number }> = [{ phase: store.getState().collabSeedPhase, at: performance.now() }];
    (globalThis as Record<string, unknown>).__collabSeedPhaseTrace = trace;
    store.subscribe((s) => {
      if (s.collabSeedPhase !== trace[trace.length - 1].phase) trace.push({ phase: s.collabSeedPhase, at: performance.now() });
    });
  }, STORE_KEY);
}

/** The phases recorded by `traceSeedPhases`, with the time spent in each (ms). */
export async function seedPhaseTrace(page: Page): Promise<Array<{ phase: string; ms: number | null }>> {
  return page.evaluate(() => {
    const trace = ((globalThis as Record<string, unknown>).__collabSeedPhaseTrace ?? []) as Array<{ phase: string; at: number }>;
    return trace.map((t, i) => ({ phase: t.phase, ms: i + 1 < trace.length ? Math.round(trace[i + 1].at - t.at) : null }));
  });
}

/** Load a model file through the ordinary file input and wait for its geometry and data store. */
export async function loadModel(page: Page, filePath: string, timeoutMs = 180_000): Promise<string> {
  await page.locator('input[type="file"]').first().setInputFiles(filePath);
  const modelId = await waitForStore<string | null>(
    page,
    `(() => { for (const [id, m] of state.models) { if (m.loadState === 'complete' && m.ifcDataStore && m.geometryResult && m.geometryResult.meshes.length > 0) return id; } return null; })()`,
    (v) => v !== null,
    timeoutMs,
    'model load',
  );
  return modelId!;
}

/** Click the ribbon's File tab when the ribbon is on (a no-op for the classic strip). */
export async function openFileTab(page: Page): Promise<void> {
  const tab = page.getByRole('tab', { name: 'File' });
  if (await tab.count()) await tab.first().click();
}

/** Read the room's counts off the live Y.Doc on this page's session. */
export async function roomCounts(page: Page): Promise<RoomCounts> {
  return storeState<RoomCounts>(
    page,
    `(() => {
      const doc = state.collabSession && state.collabSession.doc;
      if (!doc) throw new Error('no collabSession on this page');
      const geometry = doc.getMap('geometry');
      let texturedRecords = 0;
      for (const node of geometry.values()) {
        const params = node.get('params');
        if (params && params.get('textureBlobHash')) texturedRecords++;
      }
      let geometryRefs = 0;
      for (const entity of doc.getMap('entities').values()) {
        const ref = entity.get('geometryRef');
        const ids = ref && ref.get ? ref.get('geomIds') : ref && ref.geomIds;
        if (ids) geometryRefs += ids.length;
      }
      return { entities: doc.getMap('entities').size, geometryRecords: geometry.size, texturedRecords, geometryRefs, modelSlots: doc.getMap('models').size };
    })()`,
  );
}

/**
 * Fingerprint every textured mesh of `modelId`. The owner holds the IFCZIP's
 * decoded `ImageBitmap` (drawn to a canvas to read pixels — the same way the
 * seed reads them), a joiner holds the room's RGBA `texture`; both hash to
 * the same value when the pixels are byte-identical.
 */
export async function texturedMeshFingerprints(page: Page, modelId: string): Promise<MeshFingerprint[]> {
  return page.evaluate(
    async ({ key, id }) => {
      const store = (globalThis as unknown as Record<string, { getState(): unknown } | undefined>)[key];
      if (!store) throw new Error(`viewer store singleton ${key} not found`);
      const state = store.getState() as { models: Map<string, { geometryResult?: { meshes: Array<Record<string, unknown>> } }> };
      const model = state.models.get(id);
      if (!model?.geometryResult) throw new Error(`model ${id} has no geometry`);
      const fnv = (bytes: Uint8Array) => {
        let h = 0x811c9dc5;
        for (let i = 0; i < bytes.length; i++) {
          h ^= bytes[i];
          h = Math.imul(h, 0x01000193) >>> 0;
        }
        return h.toString(16).padStart(8, '0');
      };
      const bytesOf = (arr: Float32Array) => new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
      const out: Array<{ triangles: number; vertices: number; positions: string; uvs: string | null; texture: { width: number; height: number; rgbaFnv1a: string } | null }> = [];
      for (const mesh of model.geometryResult.meshes) {
        const texture = mesh.texture as { width: number; height: number; rgba: Uint8Array } | undefined;
        const bitmap = mesh.textureBitmap as ImageBitmap | undefined;
        if (!texture && !bitmap) continue;
        let pixels: { width: number; height: number; rgbaFnv1a: string };
        if (texture) {
          pixels = { width: texture.width, height: texture.height, rgbaFnv1a: fnv(texture.rgba) };
        } else {
          const canvas = new OffscreenCanvas(bitmap!.width, bitmap!.height);
          const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
          ctx.drawImage(bitmap!, 0, 0);
          const data = ctx.getImageData(0, 0, bitmap!.width, bitmap!.height).data;
          pixels = { width: bitmap!.width, height: bitmap!.height, rgbaFnv1a: fnv(new Uint8Array(data.buffer, data.byteOffset, data.byteLength)) };
        }
        const positions = mesh.positions as Float32Array;
        const uvs = mesh.uvs as Float32Array | undefined;
        out.push({
          triangles: (mesh.indices as Uint32Array).length / 3,
          vertices: positions.length / 3,
          positions: fnv(bytesOf(positions)),
          uvs: uvs ? fnv(bytesOf(uvs)) : null,
          texture: pixels,
        });
      }
      return out;
    },
    { key: STORE_KEY, id: modelId },
  );
}

/** Screenshot the render canvas (evidence) — tolerant of a GPU-less headless run. */
export async function shootCanvas(page: Page, path: string): Promise<void> {
  const canvas = page.locator('canvas').first();
  await expect(canvas).toBeVisible();
  await page.waitForTimeout(1200);
  await page.screenshot({ path, fullPage: false });
}
