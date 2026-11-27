/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Post-load measurements of the huge-geometry harness: settled memory, the
 * scripted camera paths and interaction latencies (pick, hide, isolate,
 * section plane). Every step is bounded; a failing step records its error and
 * the run continues, so one broken interaction never hides the others.
 */

import { userAgentMemory } from './retained-qual-browser.mjs';
import { bounded } from './huge-geometry-browser.mjs';
import { AFTER_FRAME, ARM_PICK, CAMERA_PATH, ELEMENT_IDS, READ_PICK, SCENE_STATS, STORE_ACTION, WASM_BYTES } from './huge-geometry-page.mjs';
import { frameSummary } from './huge-geometry-report.mjs';

export const CAMERA_PATHS = Object.freeze(['orbit', 'zoom', 'fly']);
const PICK_POINTS = [[0.5, 0.5], [0.4, 0.45], [0.6, 0.55], [0.45, 0.6], [0.55, 0.4]];

async function step(errors, name, fn) {
  try { return await fn(); } catch (err) {
    errors.push({ step: name, error: String(err?.message ?? err).slice(0, 600) });
    return null;
  }
}

/**
 * Settle, collect garbage (unless `skipGc`: a forced full GC near V8's heap
 * limit can itself kill the tab), then read memory and scene stats.
 */
export async function settledMemory(page, cdp, sampler, errors, { skipGc = false } = {}) {
  await page.waitForTimeout(2000);
  if (!skipGc) await step(errors, 'gc', () => bounded(cdp.send('HeapProfiler.collectGarbage'), 60000, 'gc'));
  await page.waitForTimeout(1000);
  const scene = await step(errors, 'scene-stats', () => bounded(page.evaluate(SCENE_STATS), 30000, 'scene stats'));
  const wasm = await step(errors, 'wasm-bytes', () => bounded(page.evaluate(WASM_BYTES), 10000, 'wasm bytes'));
  const uaMemory = await step(errors, 'ua-memory', () => bounded(userAgentMemory(page), 90000, 'measureUserAgentSpecificMemory'));
  const proc = sampler.peek();
  return { scene, wasmMainThread: wasm, uaMemory, settled: proc };
}

async function home(page) {
  await bounded(page.evaluate(() => globalThis.__ifc_lite_viewer_store__.getState().cameraCallbacks.home?.()), 30000, 'home');
  await page.waitForFunction(() => !globalThis.__ifc_lite_viewer_store__.getState().cameraCallbacks.isCameraTweening?.(), null, { timeout: 30000 });
  await page.waitForTimeout(300);
}

/** Each camera path from the home pose, `frames` frames each. */
export async function cameraPaths(page, frames, errors, { onPath } = {}) {
  const out = {};
  for (const kind of CAMERA_PATHS) {
    out[kind] = await step(errors, `camera-${kind}`, async () => {
      await home(page);
      onPath?.(kind);
      const records = await bounded(page.evaluate(CAMERA_PATH, { kind, frames }), Math.max(120000, frames * 2000), `camera ${kind}`);
      return frameSummary(records);
    });
  }
  return out;
}

async function afterFrame(page) {
  return bounded(page.evaluate(AFTER_FRAME, { capMs: 60000 }), 90000, 'next frame');
}

async function timedAction(page, action, args, { requireFrame = true } = {}) {
  const r = await bounded(page.evaluate(STORE_ACTION, { action, args }), 120000, action);
  const f = await afterFrame(page);
  if (requireFrame && f.doneMs == null) throw new Error(f.doneError ?? 'no rendered frame completed');
  return { syncMs: r.syncMs, presentMs: f.presentMs, doneMs: f.doneMs, doneError: f.doneError };
}

/** Pick latency: click, selection change, highlighted frame done; then hide/isolate/section. */
export async function interactions(page, errors) {
  const out = { picks: [], hideOne: null, showAfterHide: null, isolate: null, showAfterIsolate: null, sectionOn: null, sectionOff: null };
  await step(errors, 'home', () => home(page));
  const box = await step(errors, 'canvas-box', () => bounded(page.locator('canvas').first().boundingBox(), 30000, 'canvas box'));
  if (!box) return out;
  for (const [fx, fy] of PICK_POINTS) {
    const pick = await step(errors, 'pick', async () => {
      await bounded(page.evaluate(ARM_PICK), 30000, 'arm pick');
      await bounded(page.mouse.click(box.x + box.width * fx, box.y + box.height * fy), 30000, 'pick click');
      await page.waitForFunction(() => globalThis.__hgPick?.selectedAt !== null, null, { timeout: 15000 }).catch(() => null);
      const r = await bounded(page.evaluate(READ_PICK), 30000, 'read pick');
      if (!r.hit) return r;
      const f = await afterFrame(page);
      return { ...r, frameDoneMs: f.doneMs, frameDoneError: f.doneError };
    });
    if (pick) out.picks.push(pick);
    await step(errors, 'clear-selection', () => bounded(page.evaluate(() => globalThis.__ifc_lite_viewer_store__.getState().clearSelection?.()), 30000, 'clear selection'));
  }
  const hitId = out.picks.find((p) => p.hit)?.id;
  const sample = await step(errors, 'element-ids', () => bounded(page.evaluate(ELEMENT_IDS, { fraction: 0.1, limit: 200000 }), 60000, 'element ids'));
  const one = hitId ?? sample?.ids?.[0];
  if (one !== undefined) {
    out.hideOne = await step(errors, 'hide-one', () => timedAction(page, 'hideEntities', [[one]]));
    out.showAfterHide = await step(errors, 'show-all', () => timedAction(page, 'showAll', [], { requireFrame: false }));
  }
  if (sample?.ids?.length) {
    out.isolate = await step(errors, 'isolate', async () => ({ ids: sample.ids.length, ofIds: sample.total, ...(await timedAction(page, 'isolateEntities', [sample.ids])) }));
    out.showAfterIsolate = await step(errors, 'show-all', () => timedAction(page, 'showAll', [], { requireFrame: false }));
  }
  out.sectionOn = await step(errors, 'section-on', () => timedAction(page, 'setSectionPlaneEnabled', [true]));
  out.sectionOff = await step(errors, 'section-off', () => timedAction(page, 'setSectionPlaneEnabled', [false]));
  return out;
}
