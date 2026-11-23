/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * In-page code of the cinematic showcase recorder (huge-geometry-cinema.mjs).
 * Serialised into the page by Playwright, so nothing here may reference module
 * scope. Uses only the viewer's existing debug globals
 * (`__ifc_lite_viewer_store__`) and the harness probe (`__hgProbe`,
 * huge-geometry-page.mjs); no viewer code knows about it.
 */

/**
 * Canvas fills the frame: the viewport container (the outermost ancestor of
 * the canvas with the canvas's own box, so the ViewCube and other viewport
 * overlays come along) is lifted to a fixed full-window layer above the
 * viewer chrome. The viewer's resize observer then renders at full size.
 * Toasts are hidden for the recording (the privacy notice would cover the
 * frame). Returns the lifted element's tag and the canvas size.
 */
export const FULLFRAME = () => {
  if (!document.getElementById('hg-fullframe-css')) {
    const css = document.createElement('style');
    css.id = 'hg-fullframe-css';
    css.textContent = '[data-hg-fullframe]{position:fixed!important;inset:0!important;left:0!important;top:0!important;width:100vw!important;height:100vh!important;'
      + 'max-width:none!important;max-height:none!important;margin:0!important;z-index:2147480000!important;border-radius:0!important}'
      + '[data-sonner-toaster],[data-sonner-toast]{display:none!important}';
    document.head.appendChild(css);
  }
  const canvas = [...document.querySelectorAll('canvas')].sort((a, b) => b.width * b.height - a.width * a.height)[0];
  if (!canvas) return null;
  const r0 = canvas.getBoundingClientRect();
  let el = canvas;
  for (let p = canvas.parentElement; p && p !== document.body; p = p.parentElement) {
    const r = p.getBoundingClientRect();
    if (Math.abs(r.width - r0.width) < 6 && Math.abs(r.height - r0.height) < 6) el = p; else break;
  }
  // An ancestor with a transform, filter or containment would trap position:fixed; neutralise those.
  for (let p = el.parentElement; p && p !== document.documentElement; p = p.parentElement) {
    const cs = getComputedStyle(p);
    if (cs.transform !== 'none' || cs.filter !== 'none' || /paint|layout|strict|content/.test(cs.contain) || cs.willChange.includes('transform')) {
      p.style.setProperty('transform', 'none', 'important'); p.style.setProperty('filter', 'none', 'important');
      p.style.setProperty('contain', 'none', 'important'); p.style.setProperty('will-change', 'auto', 'important');
    }
  }
  el.setAttribute('data-hg-fullframe', ''); // the privacy notice is hidden by HIDE_PRIVACY_NOTICE (huge-geometry-video.mjs)
  return { tag: el.tagName, cls: String(el.className).slice(0, 80) };
};

/** Canvas box and size after FULLFRAME (to verify the frame is filled). */
export const CANVAS_BOX = () => {
  const canvas = [...document.querySelectorAll('canvas')].sort((a, b) => b.width * b.height - a.width * a.height)[0];
  if (!canvas) return null;
  const r = canvas.getBoundingClientRect();
  return { x: r.x, y: r.y, width: r.width, height: r.height, pixelWidth: canvas.width, pixelHeight: canvas.height, window: [innerWidth, innerHeight] };
};

/**
 * The HUD (top left) and the caption (lower third), drawn into the page DOM
 * so the screencast burns them in. They re-render every 200 ms from
 * `__hgCine` (set by the recorder) and the probe's live frames.
 */
export const CINE_HUD = () => {
  if (document.getElementById('hg-cine')) return;
  const css = document.createElement('style');
  css.textContent = '#hg-cine{position:fixed;left:14px;top:58px;z-index:2147483647;pointer-events:none;background:rgba(9,12,18,.74);color:#e9ecef;'
    + 'font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;padding:7px 10px 6px;border-radius:8px;white-space:pre;border:1px solid rgba(255,255,255,.09)}'
    + '#hg-cine .h{color:#ffd43b;font-weight:700}#hg-cine .bad{color:#ff8787;font-weight:700}#hg-cine .ok{color:#8ce99a}#hg-cine .d{color:#9aa4ae;font-size:10.5px}'
    + '#hg-cap{position:fixed;left:50%;bottom:30px;transform:translateX(-50%);z-index:2147483647;pointer-events:none;background:rgba(9,12,18,.8);color:#fff;'
    + 'font:600 19px/1.3 system-ui,-apple-system,Segoe UI,sans-serif;padding:8px 20px;border-radius:999px;border:1px solid rgba(255,255,255,.14);transition:opacity .3s;white-space:nowrap}';
  document.head.appendChild(css);
  const hud = document.createElement('div'); hud.id = 'hg-cine';
  const cap = document.createElement('div'); cap.id = 'hg-cap'; cap.style.opacity = '0';
  document.body.append(hud, cap);
  const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : null; };
  const render = () => {
    const st = globalThis.__hgCine ?? {};
    const p = globalThis.__hgProbe;
    const rows = [];
    const line = (text, cls) => { const d = document.createElement('div'); if (cls) d.className = cls; d.textContent = text; rows.push(d); };
    line(st.head ?? '', 'h');
    if (st.tag) line(st.tag, st.tone === 'bad' ? 'bad' : '');
    for (const l of st.lines ?? []) line(l);
    const fr = p?.recording ? p.frames.slice(-40) : [];
    if (fr.length > 3) {
      const d = []; for (let i = 1; i < fr.length; i++) d.push(fr[i].ts - fr[i - 1].ts);
      const ms = median(d), last = fr.at(-1);
      const draws = last.drawCalls ?? last.draws;
      line(`frame ${ms.toFixed(1)} ms · ${(1000 / ms).toFixed(0)} fps · ${draws} draws · ${(last.tris / 1e6).toFixed(2)} M tris/frame`, ms > 50 ? 'bad' : ms > 20 ? '' : 'ok');
    } else if (st.idle) line(st.idle);
    if (st.mem) line(st.mem);
    line(st.foot ?? 'diagnostic timings, not evidence', 'd');
    hud.replaceChildren(...rows);
    cap.textContent = st.caption ?? '';
    cap.style.opacity = st.caption ? '1' : '0';
    cap.style.color = st.captionTone === 'bad' ? '#ff8787' : st.captionTone === 'good' ? '#8ce99a' : '#fff';
  };
  render();
  setInterval(render, 200);
};

/**
 * Drive the camera through one shot by time: `samples` is a flat array of
 * viewer-space poses (eye xyz, target xyz) evenly spaced over the shot,
 * interpolated at `(now - t0) / durationMs`. A slow frame skips ahead rather
 * than slowing the shot, so every clip on the same path stays in lock-step.
 * `section` sweeps the section plane position over the shot. Returns the
 * probe's per-frame records.
 */
export const RUN_SHOT = async ({ samples, durationMs, section }) => {
  const store = globalThis.__ifc_lite_viewer_store__;
  const cam = store.getState().cameraCallbacks;
  const p = globalThis.__hgProbe;
  if (!cam?.applyViewpoint || !cam?.getViewpoint) throw new Error('camera callbacks unavailable');
  const base = cam.getViewpoint();
  const n = samples.length / 6 - 1;
  const poseAt = (u) => {
    const f = Math.min(n, Math.max(0, u * n)), i = Math.min(n - 1, Math.floor(f)), k = f - i, a = i * 6, b = (i + 1) * 6;
    const v = (j) => samples[a + j] + (samples[b + j] - samples[a + j]) * k;
    return { ...base, position: { x: v(0), y: v(1), z: v(2) }, target: { x: v(3), y: v(4), z: v(5) } };
  };
  p.frames = [];
  p.recording = true;
  const t0 = performance.now();
  let lastSection = null;
  for (;;) {
    const u = Math.min(1, (performance.now() - t0) / durationMs);
    // `__hgCameraHold`: the recorder is interacting (a pick); stop driving the camera until released.
    if (!globalThis.__hgCameraHold) cam.applyViewpoint(poseAt(u), false);
    if (section) {
      const q = Math.min(1, Math.max(0, (u - section.start) / (section.end - section.start)));
      const pos = section.from + (section.to - section.from) * (q * q * (3 - 2 * q));
      if (lastSection === null || Math.abs(pos - lastSection) >= 0.2) { store.getState().setSectionPlanePosition(pos); lastSection = pos; }
    }
    if (u >= 1) break;
    await new Promise((resolve) => requestAnimationFrame(resolve));
  }
  await new Promise((resolve) => requestAnimationFrame(resolve));
  p.recording = false;
  const out = p.frames;
  p.frames = [];
  return out;
};

/** Run one feature beat action in the page: isolate/show-all, section on/off, colour override on/off, clear selection. */
export const BEAT = ({ action, ids, colour }) => {
  const s = globalThis.__ifc_lite_viewer_store__.getState();
  const need = (name) => { if (typeof s[name] !== 'function') throw new Error(`store action ${name} unavailable`); return s[name]; };
  if (action === 'isolate') need('isolateEntities')(ids);
  else if (action === 'show-all') need('showAll')();
  // setSectionPlaneAxis already enables the cut (sectionSlice.ts); enabling explicitly keeps the beat independent of that.
  else if (action === 'section-on') { need('setSectionPlaneAxis')('down'); need('setSectionPlaneEnabled')(true); need('setSectionPlanePosition')(100); }
  else if (action === 'section-off') need('setSectionPlaneEnabled')(false);
  else if (action === 'colour-on') {
    need('registerOverlayLayer')({ id: 'hg-showcase-beat', priority: 250, hiddenIds: null, colorOverrides: new Map(ids.map((id) => [id, colour])) });
  } else if (action === 'colour-off') need('removeOverlayLayer')('hg-showcase-beat');
  else if (action === 'clear-selection') { s.clearSelection?.(); s.setSelectedEntity?.(null); }
  else throw new Error(`unknown beat action ${action}`);
  return true;
};

/** Element ids' renderer bounds through the selection (the same lookup frameSelection uses); clears the selection after. */
export const BOUNDS_OF = async (ids) => {
  const store = globalThis.__ifc_lite_viewer_store__;
  const out = [];
  for (const id of ids) {
    store.getState().setSelectedEntityIds([id]);
    store.getState().setSelectedEntityId(id);
    for (let i = 0; i < 3; i++) await new Promise((resolve) => requestAnimationFrame(resolve));
    const b = store.getState().cameraCallbacks.selectionBounds?.() ?? null;
    out.push(b ? { id, centre: [(b.min.x + b.max.x) / 2, (b.min.y + b.max.y) / 2, (b.min.z + b.max.z) / 2] } : { id, centre: null });
  }
  store.getState().clearSelection?.();
  store.getState().setSelectedEntity?.(null);
  return out;
};

/** Screen position (page CSS pixels) of a viewer-space point, or null. */
export const PROJECT = (pos) => {
  const cam = globalThis.__ifc_lite_viewer_store__.getState().cameraCallbacks;
  const s = cam.projectToScreen?.({ x: pos[0], y: pos[1], z: pos[2] });
  if (!s) return null;
  const canvas = [...document.querySelectorAll('canvas')].sort((a, b) => b.width * b.height - a.width * a.height)[0];
  const r = canvas.getBoundingClientRect();
  // projectToScreen reports canvas-relative CSS pixels.
  const x = r.x + s.x, y = r.y + s.y, hit = document.elementFromPoint(x, y);
  return { x, y, raw: s, hitTag: hit?.tagName ?? null, hitIsCanvas: hit === canvas, tool: globalThis.__ifc_lite_viewer_store__.getState().activeTool ?? null };
};

/** The current selection with its IFC class and name, read from the viewer's data store. */
export const SELECTION = () => {
  const s = globalThis.__ifc_lite_viewer_store__.getState();
  const id = s.selectedEntityId ?? s.selectedEntity?.expressId ?? null;
  if (id === null) return null;
  const models = [...(s.models?.values?.() ?? [])];
  const ds = models[0]?.ifcDataStore ?? s.ifcDataStore;
  let name = null, type = null;
  try { name = ds?.entities?.getName?.(id) ?? null; type = ds?.entities?.getTypeName?.(id) ?? null; } catch { /* data store shape differs: id only */ }
  return { id, name, type };
};

/** In page: wait for a camera tween to finish (bounded). */
export const TWEEN_DONE = async () => {
  const cam = globalThis.__ifc_lite_viewer_store__.getState().cameraCallbacks;
  const end = performance.now() + 4000;
  while (cam.isCameraTweening?.() && performance.now() < end) await new Promise((r) => requestAnimationFrame(r));
  for (let i = 0; i < 3; i++) await new Promise((r) => requestAnimationFrame(r));
};

/** In page: a camera move through the viewer's own callbacks ('home' tween, or framing ids). */
export const CAMERA_CALL = ({ call, ids }) => {
  const cam = globalThis.__ifc_lite_viewer_store__.getState().cameraCallbacks;
  if (call === 'home') cam.home?.();
  else if (call === 'frame') cam.frameEntities?.(ids);
  return true;
};

/** In page: hold or release the shot's camera driving. */
export const CAMERA_HOLD = (on) => { globalThis.__hgCameraHold = Boolean(on); return true; };
