/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * GPU stage of the flag-on qualification (`flag-qualify.mjs gpu`): one model
 * (or a federated set) loaded in a fresh Chrome on the host's real GPU, once
 * flags-off and once with the flag set forced on (a flagged copy of the same
 * build), through the same script of views and interactions. Each step saves
 * a renderer readback; the two arms are then compared step by step.
 *
 * Determinism: every capture is taken at a fixed camera (home, zoomed-out or
 * a preset view) with the mouse off the canvas, after the renderer has gone
 * idle, and read back three times (the last two must match). Untimed: load
 * times and memory are single diagnostic samples, never evidence.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { bounded, launchGpu, loadModel } from './huge-geometry-browser.mjs';
import { ARM_PICK, ELEMENT_IDS, READ_PICK } from './huge-geometry-page.mjs';
import { startViewerServer } from './viewer-load-probe.mjs';

/**
 * Init script: hold the WebGPU device the viewer gets, so a step can lose it
 * the way a driver reset does (`lost` resolves with reason `unknown`, then the
 * device is destroyed). Later devices come back normally, so the viewer's
 * recovery path runs. Self-contained (serialised by Playwright). The e2e
 * helper `tests/e2e/gpu-device-loss.ts` loses the device on its own and makes
 * recovery fail instead (the toast path); keep the two in step.
 */
export const DEVICE_LOSS_HOOK = () => {
  const adapter = globalThis.GPUAdapter?.prototype;
  if (!adapter || adapter.__qualifyWrapped) return;
  adapter.__qualifyWrapped = true;
  const requestDevice = adapter.requestDevice;
  adapter.requestDevice = async function (...args) {
    const device = await requestDevice.apply(this, args);
    let settle;
    const lost = new Promise((resolve) => { settle = resolve; });
    void device.lost.then((info) => settle(info));
    Object.defineProperty(device, 'lost', { configurable: true, get: () => lost });
    globalThis.__qualifyDevices = (globalThis.__qualifyDevices ?? 0) + 1;
    globalThis.__qualifyLoseDevice = () => {
      settle({ reason: 'unknown', message: 'flag-qualify: simulated device loss' });
      device.destroy();
      return true;
    };
    return device;
  };
};

/**
 * Init script: keep what the viewer saves instead of downloading it. Every
 * save goes through one anchor click (`lib/export/download.ts`
 * `clickDownloadAnchor`; a save that bypassed it would not be seen); the blob
 * is hashed in the page, which also works on a CDP-attached remote Chrome.
 */
export const DOWNLOAD_HOOK = () => {
  const proto = globalThis.HTMLAnchorElement?.prototype;
  if (!proto || proto.__qualifyWrapped) return;
  proto.__qualifyWrapped = true;
  const click = proto.click;
  globalThis.__qualifyDownloads = [];
  proto.click = function () {
    if (!this.download || !this.href.startsWith('blob:')) return click.call(this);
    const entry = { name: this.download, bytes: null, sha256: null, error: null };
    globalThis.__qualifyDownloads.push(entry);
    void fetch(this.href).then((r) => r.arrayBuffer()).then(async (buffer) => {
      const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', buffer));
      entry.sha256 = [...digest].map((b) => b.toString(16).padStart(2, '0')).join('');
      entry.bytes = buffer.byteLength;
    }).catch((err) => { entry.error = String(err); });
  };
};

async function idle(page, { stillPolls = 6, maxPolls = 240 } = {}) {
  let last = -1, still = 0;
  for (let i = 0; i < maxPolls && still < stillPolls; i++) {
    const t = await page.evaluate(() => globalThis.__ifc_lite_render_frame__?.()?.timestamp ?? 0);
    still = t === last ? still + 1 : 0; last = t;
    await page.waitForTimeout(250);
  }
  return still >= stillPolls;
}

async function settleCamera(page) {
  await page.waitForFunction(() => !globalThis.__ifc_lite_viewer_store__.getState().cameraCallbacks.isCameraTweening?.(), null, { timeout: 30000 });
}

/** Two readbacks at an idle renderer (stable when they match); the PNG of the second. */
async function capture(page) {
  await page.mouse.move(2, 2);
  const isIdle = await idle(page);
  const read = () => bounded(page.evaluate(() => globalThis.__ifc_lite_capture_color_frame__?.() ?? null), 30000, 'colour readback');
  const first = await read();
  await page.waitForTimeout(300);
  const second = await read();
  if (!second) throw new Error('no colour readback hook (__ifc_lite_capture_color_frame__)');
  return { idle: isIdle, stable: first === second, png: Buffer.from(second.split(',')[1], 'base64') };
}

const camera = (name, ...args) => (page) => page.evaluate(([n, a]) => globalThis.__ifc_lite_viewer_store__.getState().cameraCallbacks[n]?.(...a), [name, args]);
const action = (name, ...args) => (page) => page.evaluate(([n, a]) => {
  const s = globalThis.__ifc_lite_viewer_store__.getState();
  if (typeof s[n] !== 'function') throw new Error(`store has no ${n}`);
  return s[n](...a);
}, [name, args]);

async function home(page) {
  await camera('home')(page);
  await settleCamera(page);
}

/** Up to `limit` element global ids, sampled from the sorted ids: the same set on every load. */
const elementIds = (page, fraction, limit) => bounded(page.evaluate(ELEMENT_IDS, { fraction, limit, sorted: true }), 60000, 'element ids');

async function pick(page, at) {
  const box = await page.locator('canvas').first().boundingBox();
  await page.evaluate(ARM_PICK);
  await page.mouse.click(box.x + box.width * at[0], box.y + box.height * at[1]);
  await page.waitForFunction(() => globalThis.__hgPick?.selectedAt !== null, null, { timeout: 15000 }).catch(() => null);
  return page.evaluate(READ_PICK);
}

async function exportGlb(page) {
  const before = await page.evaluate(() => globalThis.__qualifyDownloads.length);
  await page.getByRole('button', { name: /Commands… Ctrl\+K/ }).click({ force: true });
  const palette = page.getByRole('dialog', { name: 'Command palette' });
  await palette.getByPlaceholder('What do you need?').fill('Export GLB');
  await palette.getByRole('option', { name: /Export GLB/ }).first().click();
  const dialog = page.getByRole('dialog', { name: 'Export GLB File' });
  await dialog.getByRole('button', { name: 'Export', exact: true }).click();
  await page.waitForFunction((n) => { const d = globalThis.__qualifyDownloads[n]; return d && (d.sha256 || d.error); }, before, { timeout: 120000 });
  const saved = await page.evaluate((n) => globalThis.__qualifyDownloads[n], before);
  await page.keyboard.press('Escape').catch(() => {});
  if (saved.error) throw new Error(`export blob: ${saved.error}`);
  return saved;
}

async function loseDevice(page) {
  const before = await page.evaluate(() => globalThis.__qualifyDevices ?? 0);
  const lostAt = await page.evaluate(() => (globalThis.__qualifyLoseDevice?.() ? performance.now() : null));
  if (lostAt === null) throw new Error('device-loss hook not installed');
  const t = Date.now();
  await page.waitForFunction((n) => (globalThis.__qualifyDevices ?? 0) > n, before, { timeout: 60000 });
  // Recovered = a frame drawn on the new device and a settled scene (settled alone can read true before the re-upload).
  await page.waitForFunction((at) => (globalThis.__ifc_lite_render_frame__?.()?.timestamp ?? 0) > at
    && globalThis.__ifc_lite_scene_settled__?.() === true, lostAt, { timeout: 180000 });
  return { recoveredMs: Date.now() - t, devices: await page.evaluate(() => globalThis.__qualifyDevices) };
}

/**
 * The script both arms run. Each step returns facts to compare (`facts`) and
 * may capture a frame (`frame: true`); a failing step records its error and
 * the script continues.
 */
export const STEPS = [
  { id: 'home', area: 'render', frame: true, run: home },
  { id: 'far', area: 'LOD', frame: true, run: async (page) => { await home(page); for (let i = 0; i < 4; i++) await camera('zoomOut')(page); await settleCamera(page); } },
  { id: 'top', area: 'render', frame: true, run: async (page) => { await camera('setPresetView', 'top')(page); await settleCamera(page); } },
  { id: 'pick', area: 'pick', frame: true, run: async (page) => {
    await home(page);
    const picks = [];
    for (const at of [[0.5, 0.5], [0.42, 0.55], [0.58, 0.45]]) picks.push((await pick(page, at)).id ?? null);
    return { facts: { picked: picks } };
  } },
  { id: 'hide', area: 'hide/isolate', frame: true, run: async (page) => {
    await action('clearSelection')(page);
    const sample = await elementIds(page, 0.3, 50000);
    await action('hideEntities', sample.ids)(page);
    return { facts: { hidden: sample.ids.length } };
  } },
  { id: 'isolate', area: 'hide/isolate', frame: true, run: async (page) => {
    await action('showAll')(page);
    const sample = await elementIds(page, 0.1, 20000);
    await action('isolateEntities', sample.ids)(page);
    return { facts: { isolated: sample.ids.length } };
  } },
  { id: 'section', area: 'section', frame: true, run: async (page) => {
    await action('showAll')(page);
    await home(page);
    await action('setSectionPlaneEnabled', true)(page);
  } },
  { id: 'colour', area: 'colour override', frame: true, run: async (page) => {
    await action('setSectionPlaneEnabled', false)(page);
    const sample = await elementIds(page, 0.2, 20000);
    await page.evaluate((ids) => globalThis.__ifc_lite_viewer_store__.getState().setPendingColorUpdates(new Map(ids.map((id, i) => [id, [i % 3 === 0 ? 1 : 0.1, i % 3 === 1 ? 1 : 0.1, i % 3 === 2 ? 1 : 0.1, 1]]))), sample.ids);
    await page.waitForFunction(() => globalThis.__ifc_lite_viewer_store__.getState().pendingColorUpdates === null, null, { timeout: 30000 }).catch(() => null);
    return { facts: { coloured: sample.ids.length } };
  } },
  { id: 'section-colour', area: 'section', frame: true, run: async (page) => { await action('setSectionPlaneEnabled', true)(page); } },
  { id: 'export', area: 'export', frame: false, run: async (page) => {
    await action('setSectionPlaneEnabled', false)(page);
    const glb = await exportGlb(page);
    return { facts: { glbBytes: glb.bytes, glbSha256: glb.sha256 } };
  } },
  { id: 'device-loss', area: 'device loss', frame: true, run: async (page) => {
    const recovery = await loseDevice(page);
    await home(page);
    return { facts: { recovered: true }, info: recovery };
  } },
];

/** Run one arm over one model entry; returns the arm record and writes its frames under `dir`. */
export async function runArm({ dist, model, arm, dir, timeoutMs }) {
  mkdirSync(dir, { recursive: true });
  const record = { arm, model: model.name, files: model.files, steps: {}, load: null, memory: null, forced: null, errors: [] };
  let server = null, session = null;
  try {
    const started = await startViewerServer(() => dist);
    server = started.server;
    session = await launchGpu({ extraInit: [DEVICE_LOSS_HOOK, DOWNLOAD_HOOK] });
    const baseUrl = started.baseUrl;
    const load = await loadModel(session, baseUrl, model.files, { timeoutMs });
    record.load = { ok: load.ok, failure: load.failure ?? null, wallMs: load.wallMs, adapter: load.adapter,
      firstFrameMs: load.timings?.firstFrameMs ?? null, interactiveMs: load.timings?.interactiveMs ?? null };
    if (!load.ok) return record;
    const { page, context } = session;
    record.forced = await page.evaluate(() => globalThis.__IFC_LITE_QUALIFY_FLAGS__ ?? null);
    await page.waitForFunction(() => globalThis.__ifc_lite_scene_settled__?.() === true, null, { timeout: 300000 });
    const cdp = await context.newCDPSession(page);
    await cdp.send('Performance.enable').catch(() => null);
    const heap = await cdp.send('Performance.getMetrics').then((m) => m.metrics.find((x) => x.name === 'JSHeapUsedSize')?.value ?? null).catch(() => null);
    const stats = await page.evaluate(() => globalThis.__ifc_lite_render_stats__?.() ?? null);
    record.memory = { jsHeapMiB: heap === null ? null : heap / 2 ** 20, gpuBytes: stats?.gpu?.total ?? null, cpuBytes: stats?.cpuBytes?.total ?? stats?.cpuBytes ?? null,
      drawCalls: stats?.frame?.drawCalls ?? null, batchesAtLod1: stats?.frame?.batchesAtLod1 ?? null };
    for (const step of STEPS) {
      const out = { ok: false, area: step.area, facts: null, frame: null, error: null };
      try {
        const result = (await bounded(step.run(page), 240000, step.id)) ?? {};
        out.facts = result.facts ?? null;
        out.info = result.info ?? null;
        if (step.frame) {
          const shot = await capture(page);
          const path = join(dir, `${arm}-${model.name}-${step.id}.png`);
          writeFileSync(path, shot.png);
          out.frame = { path, idle: shot.idle, stable: shot.stable };
          out.stats = await page.evaluate(() => globalThis.__ifc_lite_render_frame__?.() ?? null);
        }
        out.ok = true;
      } catch (err) {
        out.error = String(err?.message ?? err).slice(0, 600);
      }
      record.steps[step.id] = out;
    }
    record.console = session.events.console.filter((l) => /\[(error|warning)\]|draw stream|device lost|Device lost/i.test(l)).slice(-80);
    record.pageErrors = session.events.pageErrors.slice(0, 20);
  } catch (err) {
    record.errors.push(String(err?.message ?? err).slice(0, 600));
  } finally {
    await session?.close();
    server?.close();
  }
  return record;
}
