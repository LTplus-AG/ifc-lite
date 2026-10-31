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
//   sceneHeldMs          the renderer's scene holds the first published product
//                        (`__ifc_lite_scene_owner__`, installed by the viewport).
//   firstRetainedFrameMs `FrameStats.timestamp` (end of the render call) of the first
//                        COMPLETED frame that began after sceneHeldMs and issued draw
//                        calls. Under `kernel=retained` every mesh is retained geometry,
//                        so a draw call is a retained draw. A product event alone is not
//                        a frame (the #7955 qualification plan).
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
  const tick = () => {
    q.ticks++;
    try {
      const store = host.__ifc_lite_viewer_store__;
      if (store && !subscribed) { subscribed = true; store.subscribe(onStore); }
      const stats = host.__ifc_lite_render_stats__?.();
      const frame = stats?.frame ?? null;
      if (store && q.firstProductMs !== null && q.sceneHeldMs === null && typeof host.__ifc_lite_scene_owner__ === 'function') {
        const meshes = model(store.getState())?.geometryResult?.meshes;
        const owner = meshes?.length ? host.__ifc_lite_scene_owner__(meshes[0].expressId) : null;
        if (owner && (owner.flat?.length || owner.instance)) q.sceneHeldMs = performance.now();
      }
      if (q.sceneHeldMs !== null && q.firstRetainedFrameMs === null && frame && frame.timestamp > q.sceneHeldMs && frame.drawCalls > 0) {
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
    if (q.settledFrameMs === null) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

/** Source text for `page.addInitScript`: tsx-free, so no helper wrapper reaches the page. */
export const INIT_SCRIPT = `(${install.toString()})(${JSON.stringify(PAGE_KEY)});`;
