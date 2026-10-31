/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Page-side instrumentation for retained-qual-viewer.mjs, installed with
// addInitScript BEFORE the viewer boots. It adds no viewer code and writes no store.
//
// Clock: every value is the page's `performance.now()` (the load trace's clock).
//   loadChangeMs         the `change` event of the file input, observed in the CAPTURE
//                        phase on `document` so it precedes the viewer's own handler:
//                        the canonical `loadFile` invocation (the origin).
//   firstProductMs       the store first holds a retained model with published > 0 and
//                        at least one mesh (store subscription; not a frame).
//   sceneHeldMs          upper bound on scene ownership: the first retained draw's end.
//   firstRetainedFrameMs first completed drawing frame after retained publication in
//                        this fresh, single-model scene. Inspect after every animation
//                        callback so on-demand and continuous rendering cannot lose it.
//   terminalMs           loadState 'complete', not loading, completeness != 'running'.
//   settledFrameMs       the first completed frame after terminalMs and firstRetainedFrameMs
//                        that drew, with resident GPU bytes unchanged since the previous tick
//                        (no upload in flight): rendered complete geometry. The renderer
//                        draws on demand, so a load whose last frame precedes terminalMs has
//                        none; the driver then records null with a reason, never a guess.
// Detection is on requestAnimationFrame ticks (at most one frame late) but every
// recorded time is the event's or the frame's own timestamp.

export const PAGE_KEY = '__retainedQual';

function install(key) {
  const q = globalThis[key] = { loadChangeMs: null, firstProductMs: null, sceneHeldMs: null, firstRetainedFrameMs: null,
    terminalMs: null, settledFrameMs: null, longTaskMs: 0, ticks: 0, drawCallsAtFirstFrame: null, errors: [] };
  const host = globalThis;
  document.addEventListener('change', event => {
    if (q.loadChangeMs === null && event.target?.type === 'file') q.loadChangeMs = performance.now();
  }, true);
  try {
    new PerformanceObserver(list => { for (const e of list.getEntries()) q.longTaskMs += e.duration; }).observe({ type: 'longtask', buffered: true });
  } catch (error) { q.errors.push(`longtask: ${error}`); }
  const model = state => [...state.models.values()][0];
  const gpuBytes = stats => { const g = stats?.gpu; return g ? Object.values(g).reduce((s, v) => s + (typeof v === 'number' ? v : 0), 0) : -1; };
  let subscribed = false, lastBytes = -2;
  const onStore = state => {
    const m = model(state), now = performance.now();
    const rg = m?.retainedGeometry;
    if (q.firstProductMs === null && q.loadChangeMs !== null && rg && rg.published > 0 && (m.geometryResult?.meshes?.length ?? 0) > 0) q.firstProductMs = now;
    if (q.terminalMs === null && q.firstProductMs !== null && !state.loading && m.loadState === 'complete' && rg && rg.completeness !== 'running') q.terminalMs = now;
  };
  const observe = () => {
    q.ticks++;
    try {
      const store = host.__ifc_lite_viewer_store__;
      if (store && !subscribed) { subscribed = true; store.subscribe(onStore); }
      const stats = host.__ifc_lite_render_stats__?.();
      const frame = stats?.frame ?? null;
      if (q.firstProductMs !== null && q.firstRetainedFrameMs === null && frame
          && frame.timestamp >= q.firstProductMs && frame.drawCalls > 0) {
        q.sceneHeldMs = frame.timestamp;
        q.firstRetainedFrameMs = frame.timestamp;
        q.drawCallsAtFirstFrame = frame.drawCalls;
      }
      const bytes = gpuBytes(stats);
      if (q.terminalMs !== null && q.firstRetainedFrameMs !== null && q.settledFrameMs === null && frame
          && frame.timestamp > Math.max(q.terminalMs, q.firstRetainedFrameMs) && frame.drawCalls > 0 && bytes === lastBytes) {
        q.settledFrameMs = frame.timestamp;
      }
      lastBytes = bytes;
    } catch (error) { q.errors.push(String(error)); }
  };
  // No geometry reads/copies. The frame timestamp is fixed before this observation.
  // Wrap before the viewer boots; inspecting only our own tick could lose an earlier
  // drawing frame when another callback completes a newer non-drawing frame.
  const raf = host.requestAnimationFrame.bind(host);
  host.requestAnimationFrame = callback => raf(time => { try { callback(time); } finally { observe(); } });
  const tick = () => { observe(); if (q.settledFrameMs === null) raf(tick); };
  raf(tick);
}

/** Source text for `page.addInitScript`: tsx-free, so no helper wrapper reaches the page. */
export const INIT_SCRIPT = `(${install.toString()})(${JSON.stringify(PAGE_KEY)});`;
