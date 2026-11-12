/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * UI probes for the modelling parity scorecard (#9296).
 *
 * One probe per capability where the UI is the point. Each probe starts from
 * "Start blank" in a fresh page, does the task with real input (tool
 * shortcuts, canvas clicks, typed values, named controls), then reads the
 * result: the IFC the viewer exports, parsed by `lib/step.mjs`, or the
 * viewer's own state. "No error" is never the oracle.
 *
 * A probe is `{ id, capability, title, run(s) }`. `run` returns
 * `{ checks, notes, tasks }`:
 * - `checks`: `[{ name, ok, detail }]`, the oracle. All ok is a pass, some ok
 *   is partial, none ok is a fail.
 * - `tasks`: from `task()`; their actions and ms are the probe's metrics. A
 *   task marked `setup: true` builds the state the capability needs (walls for
 *   a door) and is reported separately as `setupActions`.
 * - `notes`: where the UI blocked or misled, in plain words.
 */


import { downloadCount, nextDownload, task } from './driver.mjs';
import {
  escape, hudText, oracleModel, openStoreyManager, readSession, readStoreyManager, switchStorey, tool, toasts, typeFields,
} from './model-ui.mjs';



const PLAN_CAM = { pos: [2.5, -2, 28], target: [2.5, 2, 0] };
const near = (a, b, tol) => Math.abs(a - b) <= tol;
const nearPt = (p, q, tol) => Math.hypot(p[0] - q[0], p[1] - q[1]) <= tol;
const fmt = (p) => `(${p.map((v) => v.toFixed(3)).join(', ')})`;

/** Draw a closed rectangle of walls with typed lengths and angles (the precise way). */
async function typedRoom(s, origin, w, d) {
  await tool(s, 'wall.place');
  await s.ui.clickWorld([origin[0], origin[1], 0]);
  await typeFields(s, [w, 0]);
  await typeFields(s, [d, 90]);
  await typeFields(s, [w, 180]);
  await typeFields(s, [d, 270]);
  await escape(s);
}

/** Wall setup that does not count toward the capability under test. */
const setupRoom = (s, origin = [0, 0], w = 5, d = 4) => task(s, 'setup: typed 5x4 walls', () => typedRoom(s, origin, w, d)).then((t) => ({ ...t, setup: true }));

/** Select elements by clicking them in Select mode; extra ones with Ctrl held (Ctrl+click toggles). */
async function selectAt(s, points) {
  await escape(s);
  for (let i = 0; i < points.length; i++) {
    const [x, y] = await s.worldToScreen(points[i]);
    if (i === 0) {
      await s.ui.clickPixel(x, y);
    } else {
      await s.page.keyboard.down('Control');
      await s.ui.clickPixel(x, y);
      await s.page.keyboard.up('Control');
    }
  }
  return (await readSession(s)).selected;
}

const wallsOn = (step, storeyName) => {
  const storey = step.storeys().find((x) => x.name === storeyName);
  const contained = step.containment();
  return step.wallAxes().filter((w) => contained.get(w.id) === storey?.id);
};

/** Section tool (X) -> New cut: Front -> the "2D section" toggle opens the Drawing panel. */
async function openFrontSection(s) {
  await escape(s);
  await s.ui.key('x', { settle: 600 });
  await s.ui.click(s.page.getByRole('button', { name: 'Front (Y)', exact: true }).first(), { settle: 800 });
  await s.ui.click(s.page.getByRole('button', { name: '2D section', exact: true }).first(), { settle: 3000 });
}

const drawingState = (s) => s.state(() => {
  const st = globalThis.__ifc_lite_viewer_store__.getState();
  return {
    status: st.drawing2DStatus ?? null, panel: !!st.drawing2DPanelVisible,
    cutPolygons: st.drawing2D?.cutPolygons?.length ?? 0, lines: st.drawing2D?.lines?.length ?? 0,
    sheetEnabled: !!st.sheetEnabled, activeSheet: !!st.activeSheet,
  };
});

/**
 * Drawing panel > Export > one format. Returns the download `{ name, type, bytes, text }`.
 * `count: false` is the harness's own export (not a modeller action).
 */
async function exportDrawing(s, format, { count = true } = {}) {
  const { page } = s;
  const click = (loc) => (count ? s.ui.click(loc) : loc.click({ timeout: 5000 }));
  const before = await downloadCount(page);
  await click(page.getByRole('button', { name: 'Export', exact: true }).last());
  const item = { svg: 'Download SVG', dxf: 'Download DXF', pdf: /^Download PDF/ }[format];
  await click(page.getByRole('menuitem', { name: item }));
  if (format === 'pdf') {
    const dialog = page.getByRole('dialog');
    if (await dialog.getByRole('combobox').count()) {
      await click(dialog.getByRole('combobox'));
      await click(page.getByRole('option', { name: /^1:50 / }));
    }
    await click(dialog.getByRole('button', { name: 'Export', exact: true }));
  }
  if (format === 'dxf') {
    // DXF asks first when it would leave markups out.
    const anyway = page.getByRole('button', { name: 'Export anyway' });
    if (await anyway.isVisible({ timeout: 800 }).catch(() => false)) await click(anyway);
  }
  return nextDownload(page, before, 30000);
}

const isPdf = (d) => !!d && d.bytes.subarray(0, 5).toString() === '%PDF-';
const isDxf = (d) => !!d && /\bSECTION\b/.test(d.text) && /\bEOF\b/.test(d.text);
const svgShapes = (d) => (d?.text.match(/<(path|polygon|polyline|line|rect)\b/g) ?? []).length;


export { PLAN_CAM, near, nearPt, fmt, typedRoom, setupRoom, selectAt, wallsOn, openFrontSection, drawingState, exportDrawing, isPdf, isDxf, svgShapes };
