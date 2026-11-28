/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Spike check for draw-stream `hlodIds` (id-aware HLOD proxies): UNTIMED
 * pixel comparison, run under `~/build-workers/ifc-gpu-check`. No frame
 * times are recorded or reported.
 *
 * Three arms load the same model in a fresh GPU Chrome each:
 *   truth  draw stream off: every frame is leaf geometry (the reference);
 *   legacy stream + HLOD, hlodIds=0: hide/isolate/paint force refinement;
 *   ids    stream + HLOD, hlodIds=1: proxies discard hidden ids and paint by id.
 * Per arm and scene (base, isolate, hide, paint, isolate-none) it records the
 * draw-stream frame stats (proxies drawn, proxy triangles) and a canvas
 * screenshot, then scores each HLOD arm against truth: coverage IoU against
 * the empty-isolation background, the share of pixels differing by more than
 * 40/255, and the count of override-coloured pixels.
 *
 *   node scripts/perf/hlod-ids-check.mjs --model FILE.ifc --out DIR [--hlod-px 2] [--zoom 1]
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { ROOT, launchGpu, loadModel } from './huge-geometry-browser.mjs';
import { startViewerServer } from './viewer-load-probe.mjs';

const { values: args } = parseArgs({ options: {
  model: { type: 'string' }, out: { type: 'string' }, 'hlod-px': { type: 'string', default: '2' }, zoom: { type: 'string', default: '1' },
  arms: { type: 'string', default: 'truth,legacy,ids' },
} });
if (!args.model || !args.out) { console.error('usage: --model FILE.ifc --out DIR [--hlod-px N] [--zoom K]'); process.exit(2); }
const out = resolve(args.out); mkdirSync(out, { recursive: true });
const PAINT = [1, 0, 1, 1];
const stream = (ids) => `m6.stream=1&m6.arena=1&m6.hlod=1&m6.hlodIds=${ids}&m6.settleMs=100&m6.hlodPx=${args['hlod-px']}`;
const ARMS = { truth: 'm6.stream=0', legacy: stream(0), ids: stream(1) };

/** Re-apply the current pose: asks the on-demand viewer for a frame. */
const KICK = () => { const cam = globalThis.__ifc_lite_viewer_store__.getState().cameraCallbacks; cam.applyViewpoint(cam.getViewpoint(), false); };
const frames = (page, n) => page.evaluate((k) => new Promise((done) => { let i = 0; const f = () => (++i >= k ? done() : requestAnimationFrame(f)); requestAnimationFrame(f); }), n);
const streamStats = (page) => page.evaluate(() => globalThis.__ifc_lite_render_frame__?.()?.stream ?? null);

/** Wait until every proxy is built (or 120 s), with frames flowing so the stream syncs. */
async function waitProxies(page) {
  const until = Date.now() + 120000;
  for (;;) {
    await page.evaluate(KICK);
    await frames(page, 4);
    const s = await streamStats(page);
    if (!s || (s.proxyNodes > 0 && s.proxyReady >= s.proxyNodes) || Date.now() > until) return s;
    await new Promise((r) => setTimeout(r, 250));
  }
}

/** Pose: home viewpoint, distance scaled by `zoom` (same in every arm). */
async function pose(page, zoom) {
  await page.waitForFunction(() => typeof globalThis.__ifc_lite_viewer_store__?.getState().cameraCallbacks?.getViewpoint === 'function', null, { timeout: 60000 });
  await page.evaluate((k) => {
    const cam = globalThis.__ifc_lite_viewer_store__.getState().cameraCallbacks;
    const v = cam.getViewpoint(); // the load's home pose const T = v.target, P = v.position;
    cam.applyViewpoint({ ...v, position: { x: T.x + (P.x - T.x) * k, y: T.y + (P.y - T.y) * k, z: T.z + (P.z - T.z) * k } }, false);
  }, zoom);
}

async function scene(page, name, apply) {
  await page.evaluate(apply.fn, apply.arg);
  // nudge a render, let the stream resync (epoch change) and draw
  for (let i = 0; i < 6; i++) { await page.evaluate(KICK); await frames(page, 5); }
  await new Promise((r) => setTimeout(r, 400));
  await frames(page, 10);
  const stats = await streamStats(page);
  const png = await page.locator('canvas').first().screenshot();
  return { name, stats, png: png.toString('base64') };
}

const IDS = () => {
  const s = globalThis.__ifc_lite_viewer_store__.getState();
  const models = [...(s.models?.values?.() ?? [])];
  const results = models.length ? models.map((m) => m.geometryResult) : [s.geometryResult];
  const ids = new Set(); for (const g of results) for (const m of g?.meshes ?? []) ids.add(m.expressId);
  const all = [...ids].sort((a, b) => a - b);
  return { total: all.length, isolate: all.slice(0, Math.max(1, Math.round(all.length * 0.1))), hide: all.filter((_, i) => i % 3 === 0), paint: all.filter((_, i) => i % 5 === 0) };
};

const SCENES = (sets) => [
  ['base', { fn: () => globalThis.__ifc_lite_viewer_store__.getState().showAll(), arg: null }],
  ['isolate', { fn: (ids) => { const s = globalThis.__ifc_lite_viewer_store__.getState(); s.showAll(); s.isolateEntities(ids); }, arg: sets.isolate }],
  ['hide', { fn: (ids) => { const s = globalThis.__ifc_lite_viewer_store__.getState(); s.showAll(); s.hideEntities(ids); }, arg: sets.hide }],
  ['paint', { fn: ([ids, c]) => { const s = globalThis.__ifc_lite_viewer_store__.getState(); s.showAll(); s.setPendingColorUpdates(new Map(ids.map((id) => [id, c]))); }, arg: [sets.paint, PAINT] }],
  ['isolate-none', { fn: () => { const s = globalThis.__ifc_lite_viewer_store__.getState(); s.setPendingColorUpdates(new Map()); s.showAll(); s.isolateEntities([]); }, arg: null }],
];

/** In page: decode PNGs and score `a` against `t` with background `bg`. */
const SCORE = async ({ a, t, bg, paint }) => {
  const decode = async (b64) => {
    const bmp = await createImageBitmap(new Blob([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], { type: 'image/png' }));
    const c = new OffscreenCanvas(bmp.width, bmp.height); const x = c.getContext('2d'); x.drawImage(bmp, 0, 0);
    return x.getImageData(0, 0, bmp.width, bmp.height).data;
  };
  const [A, T, B] = await Promise.all([decode(a), decode(t), decode(bg)]);
  const n = Math.min(A.length, T.length, B.length) / 4;
  const off = (P, Q, i, tol) => Math.max(Math.abs(P[i] - Q[i]), Math.abs(P[i + 1] - Q[i + 1]), Math.abs(P[i + 2] - Q[i + 2])) > tol;
  const isPaint = (P, i) => Math.abs(P[i] - paint[0] * 255) < 60 && P[i + 1] < 90 && Math.abs(P[i + 2] - paint[2] * 255) < 60;
  let inter = 0, uni = 0, ca = 0, ct = 0, diff = 0, ghost = 0, holes = 0, pa = 0, pt = 0;
  for (let p = 0; p < n; p++) {
    const i = 4 * p; const ia = off(A, B, i, 12), it = off(T, B, i, 12);
    if (ia) ca++; if (it) ct++; if (ia && it) inter++; if (ia || it) uni++;
    if (ia && !it) ghost++; if (it && !ia) holes++;
    if (off(A, T, i, 40)) diff++;
    if (isPaint(A, i)) pa++; if (isPaint(T, i)) pt++;
  }
  return { pixels: n, coverA: ca, coverTruth: ct, iou: uni ? inter / uni : 1, ghostPx: ghost, holePx: holes, diffFrac: diff / n, paintA: pa, paintTruth: pt };
};

const { server, baseUrl } = await startViewerServer(() => join(ROOT, 'apps/viewer/dist'));
const results = {};
try {
  for (const arm of args.arms.split(',')) {
    const session = await launchGpu();
    try {
      const load = await loadModel(session, baseUrl, [resolve(args.model)], { timeoutMs: 10 * 60000, url: `${baseUrl}/?perfTrace=1&${ARMS[arm]}` });
      // The settle check is a timing gate; the geometry is loaded, so a pixel check may go on (recorded).
      const unsettled = !load.ok && /scene never settled/.test(load.failure?.detail ?? '');
      if (!load.ok && !unsettled) throw new Error(`${arm}: load failed ${JSON.stringify(load.failure)}`);
      if (unsettled) console.warn(`${arm}: ${load.failure.detail}; continuing`);
      const { page } = session;
      await pose(page, Number(args.zoom));
      const ready = arm === 'truth' ? null : await waitProxies(page);
      const sets = await page.evaluate(IDS);
      const shots = [];
      for (const [name, apply] of SCENES(sets)) shots.push(await scene(page, name, apply));
      results[arm] = { adapter: load.adapter, unsettled, ready, ids: { total: sets.total, isolate: sets.isolate.length, hide: sets.hide.length, paint: sets.paint.length }, shots };
      for (const s of shots) writeFileSync(join(out, `${arm}-${s.name}.png`), Buffer.from(s.png, 'base64'));
      if (arm !== 'truth' && results.truth) {
        const t = Object.fromEntries(results.truth.shots.map((s) => [s.name, s.png]));
        for (const s of shots) s.score = await page.evaluate(SCORE, { a: s.png, t: t[s.name], bg: t['isolate-none'], paint: PAINT });
      }
    } finally { await session.close(); }
  }
} finally { server.close(); }

const report = Object.fromEntries(Object.entries(results).map(([arm, r]) => [arm, { adapter: r.adapter, ready: r.ready, ids: r.ids,
  scenes: r.shots.map((s) => ({ name: s.name, proxiesDrawn: s.stats?.proxiesDrawn ?? null, proxyTris: s.stats?.proxyTris ?? null, tris: s.stats?.tris ?? null,
    draws: s.stats?.draws ?? null, score: s.score ?? null })) }]));
writeFileSync(join(out, 'report.json'), JSON.stringify({ untimed: true, model: args.model, hlodPx: args['hlod-px'], zoom: args.zoom, report }, null, 2));
console.log(JSON.stringify(report, null, 2));
