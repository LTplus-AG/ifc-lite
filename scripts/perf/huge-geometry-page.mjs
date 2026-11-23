/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * In-page code of the huge-geometry harness (scripts/perf/huge-geometry.md).
 * Everything here is serialised into the page by Playwright, so no function
 * may reference module scope. No viewer code knows these exist: they only use
 * the viewer's existing debug globals (`__ifc_lite_viewer_store__`,
 * `__ifc_lite_render_stats__`) and wrap WebGPU prototypes.
 */

/**
 * Init script (before the viewer boots). `__hgProbe` counts, per rAF frame:
 * callback ms, presents (`getCurrentTexture`, a rendered frame), queue submits,
 * render-pass draws and the triangles they submit (indexCount or vertexCount
 * times instanceCount over 3; indirect draws are counted but their triangles
 * are not knowable here). Frames are kept only while `recording` is true.
 * Also records the main thread's wasm memories (instantiate hooks).
 */
export const HARNESS_INIT = () => {
  if (globalThis.__hgProbe) return;
  const p = { recording: false, frames: [], cur: { draws: 0, tris: 0, indirect: 0, submits: 0, presents: 0 }, lastPresent: 0, lastSubmit: 0,
    queue: null, wasm: [], after: null };
  // Arm a frame watch at an action's own time `from` (in page, so no harness round trip is counted): the first present
  // after it, the submit that follows, and that submit's GPU completion; all reported relative to `ref`.
  p.armFrame = (from, ref = from) => { p.after = { from, ref, present: null, done: null }; };
  globalThis.__hgProbe = p;
  const raf = globalThis.requestAnimationFrame.bind(globalThis);
  let pending = null;
  globalThis.requestAnimationFrame = (cb) => raf((ts) => {
    if (!pending || pending.ts !== ts) {
      if (pending && p.recording) p.frames.push(pending);
      pending = { ts, cbMs: 0, draws: 0, tris: 0, indirect: 0, submits: 0, presents: 0, cpuMs: null, drawCalls: null, culled: null };
    }
    const t0 = performance.now();
    try { cb(ts); } finally {
      pending.cbMs += performance.now() - t0;
      for (const k of ['draws', 'tris', 'indirect', 'submits', 'presents']) { pending[k] += p.cur[k]; p.cur[k] = 0; }
      const fs = globalThis.__ifc_lite_render_frame__?.() ?? null;
      if (fs && fs.timestamp >= ts) {
        pending.cpuMs = fs.cpuMs; pending.drawCalls = fs.drawCalls;
        pending.culled = fs.batchesFrustumCulled + fs.batchesContributionCulled + fs.instancedFrustumCulled + fs.instancedContributionCulled;
        pending.batches = fs.batchesDrawn; pending.instanced = fs.instancedDrawn;
      }
    }
  });
  const wrap = (proto, name, fn) => {
    if (!proto || typeof proto[name] !== 'function') return;
    const orig = proto[name];
    proto[name] = function (...args) { fn(this, args); return orig.apply(this, args); };
  };
  const pass = globalThis.GPURenderPassEncoder?.prototype;
  wrap(pass, 'draw', (_, a) => { p.cur.draws++; p.cur.tris += ((a[0] ?? 0) * (a[1] ?? 1)) / 3; });
  wrap(pass, 'drawIndexed', (_, a) => { p.cur.draws++; p.cur.tris += ((a[0] ?? 0) * (a[1] ?? 1)) / 3; });
  wrap(pass, 'drawIndirect', () => { p.cur.draws++; p.cur.indirect++; });
  wrap(pass, 'drawIndexedIndirect', () => { p.cur.draws++; p.cur.indirect++; });
  wrap(globalThis.GPUQueue?.prototype, 'submit', (q) => {
    p.cur.submits++; p.queue = q; p.lastSubmit = performance.now();
    const a = p.after;
    // The hook runs before the real submit: ask for completion in a microtask, once this frame's work is queued.
    if (a && a.present !== null && !a.done) a.done = new Promise((r) => queueMicrotask(r)).then(() => q.onSubmittedWorkDone()).then(() => ({ at: performance.now() }), (err) => ({ error: String(err) }));
  });
  wrap(globalThis.GPUCanvasContext?.prototype, 'getCurrentTexture', () => {
    p.cur.presents++; p.lastPresent = performance.now();
    if (p.after && p.after.present === null && p.lastPresent > p.after.from) p.after.present = p.lastPresent;
  });
  const keep = (result) => {
    const exp = result?.instance?.exports ?? result?.exports;
    for (const v of Object.values(exp ?? {})) if (v instanceof WebAssembly.Memory && !p.wasm.includes(v)) p.wasm.push(v);
    return result;
  };
  for (const name of ['instantiate', 'instantiateStreaming']) {
    const orig = WebAssembly[name];
    if (typeof orig === 'function') WebAssembly[name] = (...args) => orig.apply(WebAssembly, args).then(keep);
  }
};

/** In page: main-thread wasm bytes and memory count. */
export const WASM_BYTES = () => {
  const p = globalThis.__hgProbe;
  return p ? { bytes: p.wasm.reduce((s, m) => s + m.buffer.byteLength, 0), memories: p.wasm.length } : null;
};

/** In page: renderer resident bytes, scene triangle totals and frame stats. */
export const SCENE_STATS = () => {
  const s = globalThis.__ifc_lite_viewer_store__?.getState();
  const models = [...(s?.models?.values?.() ?? [])];
  const results = models.length ? models.map((m) => m.geometryResult) : [s?.geometryResult];
  const sum = (k) => results.reduce((acc, g) => acc + (g?.[k] ?? 0), 0);
  const rs = globalThis.__ifc_lite_render_stats__?.() ?? null;
  return { triangles: sum('totalTriangles'), vertices: sum('totalVertices'), meshes: results.reduce((a, g) => a + (g?.meshes?.length ?? 0), 0),
    models: models.length, adapter: rs?.adapter ?? null, frame: rs?.frame ?? null, gpuBytes: rs?.gpu ?? null, cpuBytes: rs?.cpuBytes ?? null };
};

/**
 * In page: drive the camera through `kind` for `frames` rAF frames from the
 * home pose, one exact pose per frame (applyViewpoint, no tween), and return
 * the probe's frame records. Paths are built from the home viewpoint, so they
 * scale with the model:
 *   orbit  one full turn around the home target at the home distance;
 *   zoom   along the home view ray from 4x to 0.05x the home distance;
 *   fly    a straight eye-height pass through the model's middle, from
 *          beyond one side to beyond the other, looking ahead.
 */
export const CAMERA_PATH = async ({ kind, frames }) => {
  const s = globalThis.__ifc_lite_viewer_store__.getState();
  const cam = s.cameraCallbacks;
  const p = globalThis.__hgProbe;
  if (!cam?.getViewpoint || !cam?.applyViewpoint) throw new Error('camera callbacks unavailable');
  const home = cam.getViewpoint();
  const T = home.target, P = home.position;
  const d = [P.x - T.x, P.y - T.y, P.z - T.z];
  const dist = Math.hypot(...d);
  const zUp = Math.abs(home.up.z) >= Math.abs(home.up.y);
  const H = zUp ? 2 : 1; // the vertical axis index
  const horiz = [0, 1, 2].filter((a) => a !== H);
  const pose = (pos, tgt) => ({ ...home, position: { x: pos[0], y: pos[1], z: pos[2] }, target: { x: tgt[0], y: tgt[1], z: tgt[2] } });
  const tv = [T.x, T.y, T.z];
  const at = (i) => {
    const u = i / Math.max(1, frames - 1);
    if (kind === 'orbit') {
      const a0 = Math.atan2(d[horiz[1]], d[horiz[0]]), r = Math.hypot(d[horiz[0]], d[horiz[1]]), a = a0 + u * 2 * Math.PI;
      const pos = [...tv]; pos[horiz[0]] += r * Math.cos(a); pos[horiz[1]] += r * Math.sin(a); pos[H] += d[H];
      return pose(pos, tv);
    }
    if (kind === 'zoom') {
      const k = 4 * Math.pow(0.05 / 4, u);
      return pose(tv.map((c, j) => c + d[j] * k), tv);
    }
    if (kind === 'fly') {
      const dir = [0, 0, 0]; dir[horiz[0]] = -d[horiz[0]]; dir[horiz[1]] = -d[horiz[1]];
      const len = Math.hypot(...dir) || 1;
      const unit = dir.map((c) => c / len);
      const span = dist * 1.2;
      const pos = tv.map((c, j) => c + unit[j] * span * (u * 2 - 1)); pos[H] = tv[H];
      return pose(pos, pos.map((c, j) => c + unit[j] * dist * 0.25));
    }
    throw new Error(`unknown camera path ${kind}`);
  };
  p.frames = [];
  await new Promise((resolve) => requestAnimationFrame(resolve));
  p.recording = true;
  for (let i = 0; i < frames; i++) {
    cam.applyViewpoint(at(i), false);
    await new Promise((resolve) => requestAnimationFrame(resolve));
  }
  await new Promise((resolve) => requestAnimationFrame(resolve));
  p.recording = false;
  cam.applyViewpoint(home, false);
  const out = p.frames; p.frames = [];
  return out;
};

/**
 * In page: resolves `{ presentMs, doneMs }` of the watch `__hgProbe.armFrame`
 * set at the action: the first rendered frame after it, and the GPU queue
 * reporting that frame's work done, relative to the watch's `ref`. Null
 * fields when nothing rendered within `capMs`.
 */
export const AFTER_FRAME = async ({ capMs }) => {
  const a = globalThis.__hgProbe.after;
  if (!a) return { presentMs: null, doneMs: null };
  const end = performance.now() + capMs;
  while (!a.done) {
    if (performance.now() > end) return { presentMs: a.present === null ? null : a.present - a.ref, doneMs: null };
    await new Promise((resolve) => setTimeout(resolve, 4));
  }
  // The GPU gets its own `capMs` from here, so a late present still has time to finish.
  let timer;
  const done = await Promise.race([a.done, new Promise((resolve) => { timer = setTimeout(() => resolve({ error: `GPU work not done within ${capMs} ms` }), capMs); })]);
  clearTimeout(timer);
  return { presentMs: a.present - a.ref, doneMs: done.at === undefined ? null : done.at - a.ref, ...(done.error ? { doneError: done.error } : {}) };
};

/** In page: arm a pick measurement; the harness then clicks. Returns nothing. */
export const ARM_PICK = () => {
  const s = globalThis.__ifc_lite_viewer_store__;
  const st = { down: null, selectedAt: null, selected: null, before: s.getState().selectedEntityId ?? null };
  if (globalThis.__hgProbe) globalThis.__hgProbe.after = null; // no stale watch from an earlier action
  globalThis.__hgPick?.unsub?.();
  st.unsub = s.subscribe((x) => {
    const id = x.selectedEntityId ?? null;
    if (st.selectedAt === null && st.down !== null && id !== st.before) {
      st.selectedAt = performance.now(); st.selected = id;
      // Frame watch from the selection change (earlier presents cannot show it), reported from pointerdown.
      globalThis.__hgProbe?.armFrame(st.selectedAt, st.down);
    }
  });
  const canvas = document.querySelector('canvas');
  canvas.addEventListener('pointerdown', () => { st.down ??= performance.now(); }, { capture: true, once: true });
  globalThis.__hgPick = st;
};

/** In page: the armed pick's outcome after the click. */
export const READ_PICK = () => {
  const st = globalThis.__hgPick;
  st?.unsub?.();
  if (!st || st.down === null) return { hit: false, ms: null, id: null, reason: 'pointerdown not observed' };
  return { hit: st.selectedAt !== null, ms: st.selectedAt === null ? null : st.selectedAt - st.down, id: st.selected, downAt: st.down };
};

/**
 * In page: candidate element ids for hide/isolate: up to `limit` distinct ids
 * of geometry the scene holds (global ids), sampled evenly.
 */
export const ELEMENT_IDS = ({ fraction, limit }) => {
  const s = globalThis.__ifc_lite_viewer_store__.getState();
  const models = [...(s.models?.values?.() ?? [])];
  const results = models.length ? models.map((m) => m.geometryResult) : [s.geometryResult];
  const ids = new Set();
  for (const g of results) for (const m of g?.meshes ?? []) ids.add(m.expressId);
  const all = [...ids];
  const want = Math.min(limit, Math.max(1, Math.round(all.length * fraction)));
  const step = Math.max(1, Math.floor(all.length / want));
  const out = [];
  for (let i = 0; i < all.length && out.length < want; i += step) out.push(all[i]);
  return { total: all.length, ids: out };
};

/** In page: run one store action by name and return the action's start time and sync cost. */
export const STORE_ACTION = ({ action, args }) => {
  const s = globalThis.__ifc_lite_viewer_store__.getState();
  if (typeof s[action] !== 'function') throw new Error(`store action ${action} unavailable`);
  const t = performance.now();
  globalThis.__hgProbe?.armFrame(t);
  s[action](...(args ?? []));
  return { tAction: t, syncMs: performance.now() - t };
};
