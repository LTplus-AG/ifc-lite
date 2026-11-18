/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Init script: stamp (wall clock) every dialog, alert, status or toast each time its text
 * changes (a reused element with new text is a new event; no first-match-wins), and the
 * viewer store's load error the moment it is set (a subscription, not the 2 s poll).
 */
export const DIALOG_MARKS = () => {
  const marks = (globalThis.__oomProbeDialogs = []), lastText = new WeakMap();
  const SEL = '[role=dialog],[role=alertdialog],[role=alert],[role=status],[data-sonner-toast]';
  const scan = () => {
    for (const el of document.querySelectorAll(SEL)) {
      const text = el.innerText?.trim();
      if (text && lastText.get(el) !== text) {
        lastText.set(el, text);
        const kind = /dialog/.test(el.getAttribute('role') ?? '') ? 'dialog' : 'notice';
        marks.push({ t: Date.now(), kind, text: text.slice(0, 4000) });
      }
    }
  };
  new MutationObserver(scan).observe(document, { subtree: true, childList: true, characterData: true });
  const hook = setInterval(() => {
    const store = globalThis.__ifc_lite_viewer_store__;
    if (!store?.subscribe) return;
    clearInterval(hook);
    let prev = store.getState().error ?? null;
    store.subscribe((st) => {
      const err = st.error ?? null;
      if (err && err !== prev) marks.push({ t: Date.now(), kind: 'store-error', text: String(err).slice(0, 4000) });
      prev = err;
    });
  }, 25);
};

/** In page: what the load has reached. */
export const PAGE_PROBE = () => {
  const s = globalThis.__ifc_lite_viewer_store__?.getState();
  const models = [...(s?.models?.values?.() ?? [])];
  let tris = 0;
  for (const g of (models.length ? models.map((m) => m.geometryResult) : [s?.geometryResult])) tris += g?.totalTriangles ?? 0;
  const l = (globalThis.__IFC_LITE_LOAD_TRACE__?.loads?.() ?? []).at(-1);
  return { loading: s?.loading ?? null, error: s?.error ?? null, progress: s?.progress ?? null, tris,
    modelStates: models.map((m) => m.loadState ?? null),
    jsHeapMiB: performance.memory ? performance.memory.usedJSHeapSize / 2 ** 20 : null,
    openSpans: l ? l.spans.filter((sp) => sp.end === null).slice(0, 8).map((sp) => sp.name) : [] };
};

/** In page: the viewer's "CPU geometry held" walk (#10264 S0), or null on a viewer without the hook. */
export const CPU_GEOMETRY_PROBE = async () => {
  const hook = globalThis.__ifc_lite_cpu_geometry_held__;
  if (typeof hook !== 'function') return null;
  const held = await hook();
  const state = globalThis.__ifc_lite_viewer_store__?.getState();
  const models = [...(state?.models?.values?.() ?? [])];
  const results = models.length ? models.map(model => model.geometryResult) : [state?.geometryResult];
  const triangles = results.reduce((sum, result) => sum + (result?.totalTriangles ?? 0), 0);
  return { ...held, triangles };
};
/** In page: text of dialogs, alerts and toasts (not the whole page). */
export const NOTICES = () => [...document.querySelectorAll('[role=dialog],[role=alertdialog],[role=alert],[role=status],[data-sonner-toast]')]
  .map((e) => e.innerText.trim().slice(0, 4000)).filter(Boolean);
