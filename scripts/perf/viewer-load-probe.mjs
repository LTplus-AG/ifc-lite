/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Page-side load probing shared by `scenoptic-bench.mjs` and
 * `load-scoreboard.mjs`, so both stop the load timer at the same point.
 *
 * Readiness follows the README's cold-load validation notes: geometry-complete
 * is not interactive. A load counts as fully interactive only when the stream
 * is complete, the GPU queue has drained and the scene finalized, metadata is
 * ready (`parser.complete`, or `cache.storeReady` on a cache hit), and the
 * store has left its loading state with every model `complete`. The store
 * transition is captured by a subscription installed before the input event,
 * so short loads are not quantized by the 100 ms readiness poll.
 */

import { createServer } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize, sep } from 'node:path';

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.wasm': 'application/wasm', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.woff2': 'font/woff2' };

/** Cross-origin-isolated static server whose root can change between samples. Resolves to `{ server, baseUrl }`. */
export async function startViewerServer(rootOf, log = () => {}) {
  const server = createServer((req, res) => {
    const root = rootOf();
    let pathname = decodeURIComponent((req.url ?? '/').split('?')[0]);
    if (pathname.endsWith('/')) pathname += 'index.html';
    let file = normalize(join(root, pathname));
    if (!file.startsWith(root + sep)) { res.writeHead(403).end(); return; }
    if (!existsSync(file) || statSync(file).isDirectory()) {
      if (extname(pathname)) { log('404', pathname); res.writeHead(404).end(); return; }
      file = join(root, 'index.html'); // SPA route
    }
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-store',
      'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'credentialless' });
    createReadStream(file).pipe(res);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, baseUrl: `http://127.0.0.1:${server.address().port}` };
}

/** Init script: count presented frames (a rendered frame acquires the swap-chain texture). */
export const COUNT_FRAMES = () => {
  const proto = globalThis.GPUCanvasContext?.prototype;
  if (proto && !proto.__benchWrapped) {
    const orig = proto.getCurrentTexture;
    proto.getCurrentTexture = function () { globalThis.__benchFrames = (globalThis.__benchFrames ?? 0) + 1; return orig.call(this); };
    proto.__benchWrapped = true;
  }
};

/** Chrome can exit with its last page, so open the next one first. */
export async function replacePage(context, page) {
  await context.newPage();
  await page.close();
}

/** Navigate the context's page to `url` and wait for the store and the file input. */
export async function openViewerPage(context, url, { onFailure } = {}) {
  const page = context.pages()[0] ?? await context.newPage();
  await page.goto(url);
  const step = async (what, fn) => { try { await fn(); } catch (err) {
    await onFailure?.(page, what);
    throw new Error(`${what}: ${err.message}`);
  } };
  await step('store', () => page.waitForFunction(() => Boolean(globalThis.__ifc_lite_viewer_store__), null, { timeout: 60000 }));
  await step('file-input', () => page.locator('#file-input-open').waitFor({ state: 'attached', timeout: 60000 }));
  return page;
}

/** In page: start the clock and subscribe to the store's settle transition. Returns t0. */
function armLoadClock(count) {
  const store = globalThis.__ifc_lite_viewer_store__;
  globalThis.__benchSettle?.unsub?.();
  const isSettled = (s) => {
    const models = [...(s.models?.values?.() ?? [])];
    return !s.loading && models.length >= count && models.every((m) => m.loadState === 'complete' || m.loadState === undefined);
  };
  const st = { at: null, prev: isSettled(store.getState()), unsub: null };
  st.unsub = store.subscribe((s) => {
    const ok = isSettled(s);
    if (ok && !st.prev) st.at = performance.now();
    if (!ok) st.at = null;
    st.prev = ok;
  });
  globalThis.__benchSettle = st;
  return (globalThis.__benchT0 = performance.now());
}

/** In page: null until every model is fully interactive, then timings relative to the input event. */
function interactiveProbe(count) {
  const trace = globalThis.__IFC_LITE_LOAD_TRACE__;
  const s = globalThis.__ifc_lite_viewer_store__?.getState();
  if (!trace || !s) return null;
  const t = globalThis.__benchT0;
  const loads = trace.loads().filter((l) => l.start >= t - 50);
  if (loads.length < count) return null;
  const end = (l, name) => l.spans.find((sp) => sp.name === name && sp.end !== null)?.end ?? null;
  // Full geometry = stream complete AND the GPU queue drained and finalized: the
  // `geometry.streamComplete` milestone fires before the upload drain and regroup.
  const DRAIN = /^(stream\.queueDrain|scene\.finalize.*|camera\.refit)$/;
  const geomDone = loads.map((l) => {
    const stream = end(l, 'geometry.streamComplete');
    if (stream === null || l.spans.some((sp) => DRAIN.test(sp.name) && sp.end === null)) return null;
    // A streamed load finalizes its fragments; a federated add uploads final batches directly.
    const streamed = l.spans.some((sp) => sp.name === 'stream.queue');
    if (streamed ? !l.spans.some((sp) => sp.name === 'scene.finalize' && sp.end !== null) : l.end === null) return null;
    return Math.max(stream, ...l.spans.filter((sp) => DRAIN.test(sp.name)).map((sp) => sp.end));
  });
  const meta = loads.map((l) => end(l, 'parser.complete') ?? end(l, 'cache.storeReady'));
  const models = [...(s.models?.values?.() ?? [])];
  const settled = !s.loading && models.length >= count && models.every((m) => m.loadState === 'complete' || m.loadState === undefined);
  if (geomDone.some((v) => v === null) || meta.some((v) => v === null) || !settled) return null;
  const now = performance.now();
  const settledAt = globalThis.__benchSettle?.at ?? null;
  const firstVisible = loads.map((l) => end(l, 'geometry.firstVisible')).filter((v) => v !== null);
  const geometryMs = Math.max(...geomDone) - t;
  const propsMs = Math.max(...meta) - t;
  // The store event when captured; the poll time otherwise (flagged, quantized).
  const storeSettledMs = (settledAt ?? now) - t;
  return {
    firstFrameMs: firstVisible.length ? Math.min(...firstVisible) - t : null,
    // Everything on screen: a snapshot's first paint, else the finalize swap (geometryMs).
    completeFrameMs: Math.max(...loads.map((l, i) => (end(l, 'scene.snapshotAdopted') !== null ? end(l, 'geometry.firstVisible') : null) ?? geomDone[i])) - t,
    snapshotAdopted: loads.map((l) => end(l, 'scene.snapshotAdopted') !== null),
    geometryMs,
    propsMs,
    storeSettledMs,
    settleQuantized: settledAt === null,
    interactiveMs: Math.max(geometryMs, propsMs, storeSettledMs),
    settledMs: now - t,
    loadPaths: loads.map((l) => l.attrs?.loadPath ?? l.attrs?.path ?? null),
    cacheTiers: loads.map((l) => l.attrs?.cacheTier ?? null),
    cacheHit: loads.map((l) => l.spans.some((sp) => sp.name === 'cache.lookup' && sp.attrs?.hit === true) || l.attrs?.loadPath === 'cache'),
    spans: loads.map((l) => l.spans.filter((sp) => sp.end !== null && sp.end - sp.start > 50)
      .map((sp) => ({ name: sp.name, startMs: Math.round(sp.start - t), ms: Math.round(sp.end - sp.start) }))),
    // Every finished span, compact: [name, thread, startMs, durationMs, milestone, id, parentId], relative to the input event.
    trace: loads.map((l) => ({ attrs: l.attrs ?? {}, startMs: l.start - t, endMs: l.end === null ? null : l.end - t,
      spans: l.spans.filter((sp) => sp.end !== null)
        .map((sp) => [sp.name, sp.thread, +(sp.start - t).toFixed(2), +(sp.end - sp.start).toFixed(2), sp.milestone ? 1 : 0, sp.id, sp.parentId]) })),
  };
}

/**
 * Open `files` through the viewer's file input and wait until every model is
 * fully interactive. Timings are relative to the input event on the page clock.
 */
export async function openAndWaitInteractive(page, files, { timeoutMs = 45 * 60 * 1000 } = {}) {
  const t0 = await page.evaluate(armLoadClock, files.length);
  await page.locator('#file-input-open').setInputFiles(files);
  const handle = await page.waitForFunction(interactiveProbe, files.length, { timeout: timeoutMs, polling: 100 });
  const value = await handle.jsonValue();
  await page.evaluate(() => globalThis.__benchSettle?.unsub?.());
  return { ...value, t0 };
}

/** After the timer: output counts and an order-independent mesh signature per model. */
export async function readOutputFingerprint(page) {
  return page.evaluate(() => {
    const s = globalThis.__ifc_lite_viewer_store__?.getState();
    const models = [...(s?.models?.values?.() ?? [])];
    const fnv = (values) => {
      let h = 0x811c9dc5;
      for (const v of values) { h ^= v & 0xff; h = Math.imul(h, 0x01000193); h ^= (v >>> 8) & 0xff; h = Math.imul(h, 0x01000193);
        h ^= (v >>> 16) & 0xff; h = Math.imul(h, 0x01000193); h ^= v >>> 24; h = Math.imul(h, 0x01000193); }
      return h >>> 0;
    };
    return models.map((m) => {
      const g = m.geometryResult;
      const meshes = g?.meshes ?? [];
      let triangles = 0, vertices = 0, sig = 0;
      for (const mesh of meshes) {
        const t = (mesh.indices?.length ?? 0) / 3, v = (mesh.positions?.length ?? 0) / 3;
        triangles += t; vertices += v;
        sig = (sig + fnv([mesh.expressId >>> 0, v >>> 0, t >>> 0])) >>> 0; // sum: independent of arrival order
      }
      return { name: m.name, meshes: meshes.length, triangles, vertices, reportedTriangles: g?.totalTriangles ?? null,
        reportedVertices: g?.totalVertices ?? null, entities: m.ifcDataStore?.entityCount ?? null, meshSignature: sig.toString(16) };
    });
  });
}

/** The cold load writes the IndexedDB cache beside the critical path; the warm open needs it complete. */
export async function waitCacheWrites(page, timeoutMs = 10 * 60 * 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const pending = await page.evaluate(() => globalThis.__IFC_LITE_LOAD_TRACE__.loads()
      .filter((l) => l.start >= globalThis.__benchT0 - 50)
      .some((l) => l.spans.some((sp) => sp.name.startsWith('cache.write') && sp.end === null)));
    if (!pending) return true;
    await page.waitForTimeout(500);
  }
  return false;
}

/** Closing the page could interrupt the snapshot write, and the next open would then measure the ordinary path. */
export async function waitSceneSnapshots(page, timeoutMs = 60 * 1000) {
  await page.waitForFunction(() => new Promise((done) => {
    const open = indexedDB.open('ifc-lite-cache');
    open.onerror = () => done(false);
    open.onsuccess = () => {
      const all = open.result.transaction('models').objectStore('models').getAll();
      all.onerror = () => done(false);
      all.onsuccess = () => { open.result.close(); done(all.result.length > 0 && all.result.every((entry) => entry.sceneSnapshot)); };
    };
  }), null, { timeout: timeoutMs, polling: 500 });
}
