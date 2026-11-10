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

import { roofGeometry, copiedPlansMatch, uniqueWallJoins, wallEndpointsJoined, hasDwgDownload, assignedTypes, ownOpenings, wallPropertySets, wallQuantityCoverage } from './lib/oracles.mjs';
import { downloadCount, nextDownload, task } from './lib/driver.mjs';
import {
  escape, hudText, oracleModel, openStoreyManager, readSession, readStoreyManager, switchStorey, tool, toasts, typeFields,
} from './lib/model-ui.mjs';
import { U4_PROBES } from './probes-u4.mjs';
import { readStep } from './lib/step.mjs';
import { meshIfc } from '../probes/sdk/lib/parity.mjs';

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
  if (format === 'pdf') await click(page.getByRole('dialog').getByRole('button', { name: 'Export', exact: true }));
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

export const PROBES = [
  ...U4_PROBES,
  {
    id: 'ui.storeys',
    capability: 'storeys',
    title: 'Storey manager: add above, edit floor-to-floor, rename, delete',
    async run(s) {
      const notes = [];
      const tasks = [];
      tasks.push(await task(s, 'open storey manager', () => openStoreyManager(s)));
      const before = (await readSession(s)).storeyId;
      tasks.push(await task(s, 'add storey above', () => s.ui.click(s.page.locator('[data-storey-manager]').getByRole('button', { name: 'Add storey above' }).first(), { settle: 600 })));
      const after = (await readSession(s)).storeyId;
      if (after !== before) notes.push('"Add storey above" makes the new storey the one you draw on.');
      tasks.push(await task(s, 'edit Level 1 floor-to-floor to 3.5', async () => {
        await s.ui.click(s.page.getByLabel('Floor-to-floor height of Level 1, metres'));
        await s.ui.key('Control+A');
        await s.ui.type('3.5');
        await s.ui.key('Enter', { settle: 800 });
      }));
      tasks.push(await task(s, 'rename Level 2 to First floor', async () => {
        await s.ui.click(s.page.getByLabel('Name of Level 2'));
        await s.ui.key('Control+A');
        await s.ui.type('First floor');
        await s.ui.key('Enter', { settle: 500 });
      }));
      let sawAdded = false;
      let sawDeleted = false;
      tasks.push(await task(s, 'add and delete a storey', async () => {
        await s.ui.click(s.page.locator('[data-storey-manager]').getByRole('button', { name: 'Add storey above' }).first(), { settle: 600 });
        const rows = await readStoreyManager(s);
        sawAdded = /Level 3/.test(rows ?? '');
        if (!sawAdded) throw new Error(`no Level 3 after adding: ${rows?.slice(0, 200)}`);
        await s.ui.click(s.page.getByRole('button', { name: 'Delete Level 3' }), { settle: 600 });
        sawDeleted = !/Level 3/.test((await readStoreyManager(s)) ?? '');
      }));
      const shot = await s.shot('storeys');
      const { step } = await oracleModel(s);
      const storeys = step.storeys();
      const l1 = storeys.find((x) => x.name === 'Level 1');
      const l2 = storeys.find((x) => x.name === 'First floor');
      return {
        tasks, notes, evidence: [shot],
        checks: [
          { name: 'the manager showed Level 3 after adding it and not after deleting it', ok: sawAdded && sawDeleted, detail: `added ${sawAdded}, deleted ${sawDeleted}` },
          { name: 'two storeys after add, add, delete', ok: storeys.length === 2, detail: storeys.map((x) => `${x.name}@${x.elevation}`).join(', ') },
          { name: 'renamed storey exported as "First floor"', ok: !!l2, detail: storeys.map((x) => x.name).join(', ') },
          { name: 'floor-to-floor 3.5 moved First floor to +3.5', ok: !!l1 && !!l2 && near(l2.elevation - l1.elevation, 3.5, 1e-6), detail: l2 ? `First floor at ${l2.elevation}` : 'missing' },
        ],
      };
    },
  },
  {
    id: 'ui.wall-chain',
    capability: 'wall-chains-autojoin',
    title: 'Draw a closed 5x4 m wall chain by clicking corners',
    async run(s) {
      const pts = [[0, 0], [5, 0], [5, 4], [0, 4], [0, 0]];
      const tasks = [];
      tasks.push(await task(s, 'click 5 corners (wall tool already active after Start blank)', async () => {
        for (const p of pts) await s.ui.clickWorld([p[0], p[1], 0]);
        await escape(s);
      }));
      const shot = await s.shot('chain');
      const { step } = await oracleModel(s);
      const axes = step.wallAxes();
      const joins = uniqueWallJoins(step);
      const tol = 0.05;
      const closed = axes.length >= 4 && nearPt(axes[0].start, axes.at(-1).end, 1e-6);
      const onTarget = axes.length === 4 && axes.every((a, i) => nearPt(a.start, pts[i], tol) && nearPt(a.end, pts[i + 1], tol));
      const notes = [];
      if (s.counters.cameraJumps) notes.push(`The camera moved by itself ${s.counters.cameraJumps} time(s) while drawing (it reframes after a commit), so the next click would land on a wall face instead of the floor.`);
      const off = axes.map((a, i) => (pts[i] ? Math.hypot(a.start[0] - pts[i][0], a.start[1] - pts[i][1]) : 0));
      if (off.some((d) => d > 0.005)) notes.push(`Clicked corners land off the intended metre points by up to ${(Math.max(...off) * 1000).toFixed(0)} mm: no snap to round increments or a grid on a blank model.`);
      return {
        tasks, notes, evidence: [shot],
        checks: [
          { name: '4 walls', ok: axes.length === 4, detail: `${axes.length} walls` },
          { name: 'corners within 50 mm of the clicked points', ok: onTarget, detail: axes.map((a) => `${fmt(a.start)}->${fmt(a.end)}`).join(' ') },
          { name: 'loop closed exactly (snapped to the first point)', ok: closed, detail: closed ? 'closed' : 'open' },
          { name: 'corners auto-joined (4 IfcRelConnectsPathElements)', ok: joins >= 4 && wallEndpointsJoined(step), detail: `${joins} joins` },
        ],
        metrics: { cameraJumps: s.counters.cameraJumps },
      };
    },
  },
  {
    id: 'ui.typed-dims',
    capability: 'typed-input-temp-dims',
    title: 'Typed lengths and angles for walls, typed width and depth for a slab',
    async run(s) {
      const tasks = [];
      tasks.push(await task(s, 'walls 5/4/5/4 m typed with angles', () => typedRoom(s, [0, 0], 5, 4)));
      tasks.push(await task(s, 'slab 5x4 m typed', async () => {
        await tool(s, 'slab.place');
        await s.ui.clickWorld([8, 0, 0]);
        await typeFields(s, [5, 4]);
        await escape(s);
      }));
      const shot = await s.shot('typed');
      const { step } = await oracleModel(s);
      const axes = step.wallAxes();
      const want = [5, 4, 5, 4];
      const slab = step.of('IFCSLAB')[0];
      const q = slab ? step.quantities(slab.id) : {};
      const notes = [];
      const hud = await hudText(s);
      return {
        tasks, notes, evidence: [shot],
        checks: [
          { name: 'wall lengths exactly 5, 4, 5, 4 m', ok: axes.length === 4 && axes.every((a, i) => near(a.length, want[i], 1e-3)), detail: axes.map((a) => a.length.toFixed(4)).join(', ') },
          { name: 'typed chain closes on the start point', ok: axes.length === 4 && nearPt(axes[0].start, axes[3].end, 1e-3), detail: axes.length ? `${fmt(axes[0].start)} vs ${fmt(axes.at(-1).end)}` : 'no walls' },
          { name: 'slab 5 x 4 m (GrossArea 20 m2)', ok: near(q.GrossArea ?? 0, 20, 1e-3), detail: JSON.stringify({ Length: q.Length, Depth: q.Depth, GrossArea: q.GrossArea }) },
        ],
        extra: { hud },
      };
    },
  },
  {
    id: 'ui.snapping',
    capability: 'snapping-inference',
    title: 'Endpoint and midpoint snaps while drawing',
    async run(s) {
      const tasks = [];
      const glyph = () => s.state(() => [...document.querySelectorAll('[data-snap-kind]')].map((g) => g.getAttribute('data-snap-kind')));
      tasks.push(await task(s, 'setup: wall (0,0)-(5,0) typed', async () => {
        await s.ui.clickWorld([0, 0, 0]);
        await typeFields(s, [5, 0]);
        await escape(s, 1);
      }).then((t) => ({ ...t, setup: true })));
      let endGlyphs = [];
      let midGlyphs = [];
      tasks.push(await task(s, 'start a wall 80 mm off the endpoint, end it 80 mm off the midpoint', async () => {
        await s.ui.hoverWorld([5.08, 0.08, 0]);
        endGlyphs = await glyph();
        await s.ui.clickWorld([5.08, 0.08, 0]);
        await s.ui.hoverWorld([2.58, 0.08, 0]);
        midGlyphs = await glyph();
        await s.ui.clickWorld([2.58, 0.08, 0]);
        await escape(s);
      }));
      const shot = await s.shot('snap');
      const { step } = await oracleModel(s);
      const axes = step.wallAxes();
      const [first, second] = axes;
      const end = first?.end ?? [5, 0];
      const mid = first ? [(first.start[0] + first.end[0]) / 2, (first.start[1] + first.end[1]) / 2] : [2.5, 0];
      const notes = [];
      if (second && first && Math.abs(second.start[1] - end[1]) > 0.05 && near(Math.abs(second.start[1] - end[1]), 0.1, 0.01)) {
        notes.push('Endpoint and midpoint snaps pick the corner and edge of the wall body (its face, half the thickness off the axis), not the wall axis end, so a wall started on a snapped end does not continue the first one.');
      }
      return {
        tasks, notes, evidence: [shot],
        checks: [
          { name: 'endpoint glyph shown near the wall end', ok: endGlyphs.includes('endpoint'), detail: `glyphs: ${endGlyphs.join(',') || 'none'}` },
          { name: 'second wall starts exactly on the first wall end', ok: !!second && nearPt(second.start, end, 1e-3), detail: second ? `${fmt(second.start)} vs ${fmt(end)}` : 'no second wall' },
          { name: 'midpoint glyph shown near the middle', ok: midGlyphs.includes('midpoint'), detail: `glyphs: ${midGlyphs.join(',') || 'none'}` },
          { name: 'second wall ends exactly on the first wall midpoint', ok: !!second && nearPt(second.end, mid, 1e-3), detail: second ? `${fmt(second.end)} vs ${fmt(mid)}` : 'no second wall' },
        ],
      };
    },
  },
  {
    id: 'ui.hosted-openings',
    capability: 'hosted-doors-windows-from-types',
    title: 'Click a wall with the door and window tools',
    async run(s) {
      const tasks = [await setupRoom(s)];
      tasks.push(await task(s, 'door: Shift+D, click the south wall', async () => {
        await tool(s, 'door.place');
        await s.ui.clickWorld([2.5, 0, 1]);
        await escape(s);
      }));
      tasks.push(await task(s, 'window: Shift+W, click the east wall', async () => {
        await tool(s, 'window.place');
        await s.ui.clickWorld([5, 2, 1.5]);
        await escape(s);
      }));
      const notes = [];
      const t = await toasts(s);
      if (t.length) notes.push(`toasts: ${t.join(' / ')}`);
      const shot = await s.shot('hosted');
      const { step } = await oracleModel(s);
      const c = step.counts(['IFCDOOR', 'IFCWINDOW', 'IFCOPENINGELEMENT', 'IFCRELVOIDSELEMENT', 'IFCRELFILLSELEMENT', 'IFCDOORTYPE', 'IFCWINDOWTYPE', 'IFCRELDEFINESBYTYPE']);
      const wallIds = new Set(step.of('IFCWALL').map((w) => w.id));
      const fillers = [...step.of('IFCDOOR'), ...step.of('IFCWINDOW')];
      const unhosted = fillers.filter((e) => !wallIds.has(step.hostOf(e.id)));
      const typed = fillers.length === 2 && assignedTypes(step, fillers);
      if (!typed) notes.push('Doors and windows are placed without an IfcDoorType / IfcWindowType: the click flow offers no type to place from.');
      return {
        tasks, notes, evidence: [shot],
        checks: [
          { name: '1 door and 1 window', ok: c.IFCDOOR === 1 && c.IFCWINDOW === 1, detail: `${c.IFCDOOR} doors, ${c.IFCWINDOW} windows` },
          { name: 'each fills its own opening in a wall', ok: fillers.length === 2 && ownOpenings(step,fillers) && unhosted.length === 0, detail: unhosted.length ? `not hosted: #${unhosted.map((e) => e.id).join(', #')}; ${JSON.stringify(c)}` : JSON.stringify(c) },
          { name: 'placed from a door type and a window type', ok: typed, detail: `${c.IFCDOORTYPE} door types, ${c.IFCWINDOWTYPE} window types` },
        ],
      };
    },
  },
  {
    id: 'ui.stair',
    capability: 'stairs-railings',
    title: 'Stair from Level 1 to the storey above, and a railing (two clicks, Enter)',
    async run(s) {
      const tasks = [];
      tasks.push(await task(s, 'setup: add storey above, back to Level 1', async () => {
        await openStoreyManager(s);
        await s.ui.click(s.page.locator('[data-storey-manager]').getByRole('button', { name: 'Add storey above' }).first(), { settle: 600 });
        await s.ui.click(s.page.getByRole('radio', { name: 'Draw on Level 1' }));
      }).then((t) => ({ ...t, setup: true })));
      await s.harness.aim(PLAN_CAM.pos, PLAN_CAM.target);
      tasks.push(await task(s, 'stair: Shift+T, click start and end of the run', async () => {
        await escape(s);
        await tool(s, 'stair.place');
        await s.ui.clickWorld([1, 0, 0]);
        await s.ui.clickWorld([1, 4, 0]);
        await escape(s);
      }));
      tasks.push(await task(s, 'railing: Shift+L, click two points, Enter', async () => {
        await tool(s, 'railing.place');
        await s.ui.clickWorld([3, 0, 0]);
        await s.ui.clickWorld([3, 4, 0]);
        await s.ui.key('Enter', { settle: 300 });
        await escape(s);
      }));
      const notes = [];
      const t = await toasts(s);
      if (t.length) notes.push(`toasts: ${t.join(' / ')}`);
      const shot = await s.shot('stair');
      const { step } = await oracleModel(s);
      const c = step.counts(['IFCSTAIR', 'IFCSTAIRFLIGHT', 'IFCRAILING']);
      const flight = step.of('IFCSTAIRFLIGHT')[0];
      const risers = flight?.args?.[8] ?? null;
      return {
        tasks, notes, evidence: [shot],
        checks: [
          { name: 'IfcStair with a flight', ok: c.IFCSTAIR >= 1 && c.IFCSTAIRFLIGHT >= 1, detail: JSON.stringify(c) },
          { name: 'flight rises the 3.0 m storey height (risers x riser height)', ok: !!flight && typeof risers === 'number' && near(risers * (flight.args?.[10] ?? 0), 3, 0.01), detail: flight ? `risers ${risers}, riser height ${flight.args?.[10]}` : 'no flight' },
          { name: 'IfcRailing', ok: c.IFCRAILING >= 1, detail: `${c.IFCRAILING} railings` },
        ],
      };
    },
  },
  {
    id: 'ui.curtain-wall',
    capability: 'curtain-walls',
    title: 'Curtain wall by two clicks',
    async run(s) {
      const tasks = [];
      tasks.push(await task(s, 'curtain wall: Shift+U, click two points', async () => {
        await escape(s);
        await tool(s, 'curtainwall.place');
        await s.ui.clickWorld([0, 0, 0]);
        await s.ui.clickWorld([6, 0, 0]);
        await escape(s);
      }));
      const shot = await s.shot('curtain');
      const { step } = await oracleModel(s);
      const c = step.counts(['IFCCURTAINWALL', 'IFCPLATE', 'IFCMEMBER', 'IFCRELAGGREGATES']);
      const cw = step.of('IFCCURTAINWALL')[0];
      const parts = cw ? step.of('IFCRELAGGREGATES').filter((r) => r.args?.[4]?.ref === cw.id).flatMap((r) => r.args[5]).map((r) => step.get(r)?.type) : [];
      return {
        tasks, notes: [], evidence: [shot],
        checks: [
          { name: 'IfcCurtainWall', ok: c.IFCCURTAINWALL === 1, detail: JSON.stringify(c) },
          { name: 'decomposed into plates and members', ok: parts.includes('IFCPLATE') && parts.includes('IFCMEMBER'), detail: `${parts.length} parts` },
        ],
      };
    },
  },
  {
    id: 'ui.roof',
    capability: 'roof-by-footprint',
    title: 'Roof over a 5x4 m footprint (hip expected; #9214)',
    async run(s) {
      const tasks = [await setupRoom(s)];
      const notes = ['The exported roof is meshed and checked against four 30-degree eave planes; its IFC type alone cannot establish a hip.'];
      tasks.push(await task(s, 'Roof tool, typed 5.6 x 4.6 m', async () => {
        await s.ui.key('Shift+Y', { settle: 300 });
        await s.ui.clickWorld([-0.3, -0.3, 3], { modifiers: ['Alt'] });
        await typeFields(s, [5.6, 4.6]);
        await escape(s);
      }));
      await s.harness.aim([14, -12, 12], [2.5, 2, 1.5], { pin: false });
      const shot = await s.shot('roof');
      const { step, text } = await oracleModel(s);
      const roofs = [...step.of('IFCROOF'), ...step.of('IFCSLAB').filter((x) => x.args?.[8]?.enum === 'ROOF')];
      // Reuse the geometric SDK oracle: slabs, full-height prisms and mono-pitch
      // plates cannot pass as a hip even if their IFC label says HIP_ROOF.
      const sloped = roofGeometry(step, await meshIfc(text), {
        footprint: [[-.3,-.3],[5.3,-.3],[5.3,4.3],[-.3,4.3]],
        slopes: Array(4).fill(Math.PI / 6), thickness: .3, hip: true,
      });
      return {
        tasks, notes, evidence: [shot],
        checks: [
          { name: 'a roof element exists (IfcRoof or IfcSlab ROOF)', ok: roofs.length >= 1, detail: `${roofs.length} roof elements` },
          { name: 'the roof is sloped (hip by footprint)', ok: sloped === true, detail: sloped === true ? 'four 30-degree planes, low eaves, high centre and volume pass the native-mesh oracle' : sloped },
        ],
      };
    },
  },
  {
    id: 'ui.copy-to-levels',
    capability: 'copy-to-levels',
    title: 'Copy four walls to two storeys above with Ctrl+C, storey switch, Ctrl+Shift+V',
    async run(s) {
      const tasks = [await setupRoom(s)];
      tasks.push(await task(s, 'setup: add two storeys above', async () => {
        await openStoreyManager(s);
        const add = s.page.locator('[data-storey-manager]').getByRole('button', { name: 'Add storey above' }).first();
        await s.ui.click(add, { settle: 600 });
        await s.ui.click(add, { settle: 600 });
        await s.ui.click(s.page.getByRole('radio', { name: 'Draw on Level 1' }));
      }).then((t) => ({ ...t, setup: true })));
      await s.harness.aim(PLAN_CAM.pos, PLAN_CAM.target);
      let selected = 0;
      tasks.push(await task(s, 'select the 4 walls (click, Ctrl+click) and copy', async () => {
        selected = await selectAt(s, [[2.5, 0, 1.5], [5, 2, 1.5], [2.5, 4, 1.5], [0, 2, 1.5]]);
        await s.ui.key('Control+C');
      }));
      const copied = await toasts(s);
      for (const level of ['Level 2', 'Level 3']) {
        tasks.push(await task(s, `switch to ${level} and paste in place`, async () => {
          await switchStorey(s, level);
          await s.ui.key('Control+Shift+V', { settle: 800 });
        }));
      }
      const notes = ['Copying to several storeys is one storey at a time: switch storey, paste, repeat.'];
      const shot = await s.shot('copied');
      const { step } = await oracleModel(s);
      const l1 = wallsOn(step, 'Level 1');
      const l2 = wallsOn(step, 'Level 2');
      const l3 = wallsOn(step, 'Level 3');
      const storeys = step.storeys();
      const z2 = storeys.find((x) => x.name === 'Level 2')?.elevation;
      return {
        tasks, notes, evidence: [shot],
        checks: [
          { name: '4 walls selected by click and Ctrl+click', ok: selected === 4, detail: `${selected} selected; ${copied.join(' / ')}` },
          { name: '4 walls on Level 2', ok: l2.length === 4, detail: `${l2.length}` },
          { name: '4 walls on Level 3', ok: l3.length === 4, detail: `${l3.length}` },
          { name: 'copies keep the plan position of the Level 1 walls', ok: l1.length === 4 && copiedPlansMatch(l1, [l2,l3]), detail: [l2,l3].map((walls) => walls.map((w) => fmt(w.start)).join(' ') || 'none').join(' / ') },
          { name: 'Level 2 at +3.0 m', ok: near(z2 ?? -1, 3, 1e-6), detail: `${z2}` },
        ],
      };
    },
  },
  {
    id: 'ui.transforms',
    capability: 'transforms-move-copy-rotate-mirror-array',
    title: 'Move 2 m, rotate 90 degrees, array x3, mirror',
    async run(s) {
      const tasks = [];
      await s.harness.aim([2, -5, 42], [2, 5, 0]);
      tasks.push(await task(s, 'setup: three 4 m walls at y = 0, 5, 10', async () => {
        for (const y of [0, 5, 10]) {
          await s.ui.clickWorld([0, y, 0]);
          await typeFields(s, [4, 0]);
          await escape(s, 1);
        }
        await escape(s);
      }).then((t) => ({ ...t, setup: true })));
      const notes = [];
      tasks.push(await task(s, 'move: select the y=0 wall, Shift+M, from (0,0), type 2 towards +Y', async () => {
        await selectAt(s, [[2, 0, 1.5]]);
        await s.ui.key('Shift+M', { settle: 300 });
        await s.ui.clickWorld([0, 0, 0]);
        await s.ui.hoverWorld([0, 1.5, 0]);
        await typeFields(s, [2]);
        await escape(s);
      }));
      tasks.push(await task(s, 'rotate: select the y=5 wall, Shift+Q, type 90', async () => {
        await selectAt(s, [[2, 5, 1.5]]);
        await s.ui.key('Shift+Q', { settle: 300 });
        await typeFields(s, [90]);
        await escape(s);
      }));
      tasks.push(await task(s, 'array: select the y=10 wall, Shift+A, count 3, spacing 1.5, two clicks for +Y', async () => {
        await selectAt(s, [[2, 10, 1.5]]);
        await s.ui.key('Shift+A', { settle: 300 });
        await typeFields(s, [3, 1.5], { enter: false });
        await s.ui.key('Tab');
        await s.ui.clickWorld([6, 10, 0]);
        await s.ui.clickWorld([6, 12, 0]);
        await escape(s);
      }));
      let editItems = [];
      tasks.push(await task(s, 'look for Mirror in the Edit menu', async () => {
        await s.ui.click(s.page.locator('[data-model-tool-rail]').getByRole('button', { name: 'Edit', exact: true }));
        editItems = await s.state(() => [...document.querySelectorAll('[role=menu] [role=menuitem]')].map((m) => m.innerText.split('\n')[0].trim()));
        await s.ui.key('Escape');
      }));
      const shot = await s.shot('transforms');
      const { step } = await oracleModel(s);
      const axes = step.wallAxes();
      // Clicked wall origins carry the click's few-mm error, so the move is judged to 30 mm.
      const moved = axes.some((a) => nearPt(a.start, [0, 2], 0.03) && nearPt(a.end, [4, 2], 0.03));
      const rotated = axes.some((a) => near(a.end[0] - a.start[0], 0, 1e-3) && near(a.length, 4, 1e-3));
      const arrayed = axes.filter((a) => near(a.length, 4, 1e-3) && a.start[1] > 9).length;
      return {
        tasks, notes, evidence: [shot],
        checks: [
          { name: 'move by a typed 2 m', ok: moved, detail: axes.map((a) => `${fmt(a.start)}->${fmt(a.end)}`).join(' ') },
          { name: 'rotate by a typed 90 degrees', ok: rotated, detail: rotated ? 'a vertical 4 m wall exists' : 'no vertical wall' },
          { name: 'array makes 3 walls from one', ok: arrayed >= 3, detail: `${arrayed} walls in the array region` },
          { name: 'a Mirror command in the Edit menu', ok: editItems.some((x) => /mirror/i.test(x)), detail: `Edit menu: ${editItems.join(', ') || 'empty'}` },
        ],
      };
    },
  },
  {
    id: 'ui.rooms',
    capability: 'rooms-with-area',
    title: 'Room by clicking inside four walls; area from the inner faces',
    async run(s) {
      const tasks = [await setupRoom(s)];
      tasks.push(await task(s, 'room: Shift+O, click inside', async () => {
        await tool(s, 'room.place');
        await s.ui.clickWorld([2.5, 2, 0]);
        await escape(s);
      }));
      const shot = await s.shot('room');
      const { step } = await oracleModel(s);
      const spaces = step.of('IFCSPACE');
      const q = spaces[0] ? step.quantities(spaces[0].id) : {};
      const area = q.NetFloorArea ?? q.GrossFloorArea ?? null;
      const inner = 4.8 * 3.8;
      return {
        tasks, notes: [], evidence: [shot],
        checks: [
          { name: 'one IfcSpace', ok: spaces.length === 1, detail: `${spaces.length}` },
          { name: `floor area quantity ${inner.toFixed(2)} m2 (inner faces)`, ok: area !== null && near(area, inner, 0.05), detail: JSON.stringify(q) },
        ],
      };
    },
  },
  {
    id: 'ui.plan-section',
    capability: 'plans-sections-elevations',
    title: 'Show the plan, then a 2D section drawing',
    async run(s) {
      const tasks = [await setupRoom(s)];
      let planPaths = 0;
      const notes = [];
      tasks.push(await task(s, 'Show the plan (rail); close the inspector first if there is no room', async () => {
        const show = s.page.getByRole('button', { name: 'Show the plan' });
        if ((await show.isVisible()) && (await show.isDisabled())) {
          notes.push('At 1600x900 "Show the plan" is disabled ("No room for the plan beside 3D"): the modeller has to close a side panel before the plan can open.');
          for (const name of ['Close the Model inspector', 'Collapse sidebar to icons']) {
            if (!(await show.isVisible().catch(() => false)) || !(await show.isDisabled())) break;
            const control = s.page.getByRole('button', { name, exact: true }).first();
            if (await control.isVisible().catch(() => false)) await s.ui.click(control, { settle: 800 });
          }
          if ((await show.isVisible().catch(() => false)) && (await show.isDisabled())) throw new Error('"Show the plan" stays disabled after closing and collapsing the right panel');
        }
        // With room, the "auto" layout opens the plan by itself and the button turns into "Hide the plan".
        if (await show.isVisible().catch(() => false)) await s.ui.click(show, { settle: 1500 });
        else await s.page.waitForTimeout(1500);
        planPaths = await s.state(() => document.querySelectorAll('svg[data-plan-canvas] path, svg[data-plan-canvas] polygon, svg[data-plan-canvas] line, svg[data-plan-canvas] polyline, svg[data-plan-canvas] rect').length);
      }));
      const planShot = await s.shot('plan');
      tasks.push(await task(s, 'Section tool (X), New cut: Front, then the 2D section toggle', () => openFrontSection(s)));
      const section = await drawingState(s);
      const sectionShot = await s.shot('section');
      const files = {};
      for (const format of ['svg', 'dxf', 'pdf']) {
        tasks.push(await task(s, `Drawing > Export > ${format.toUpperCase()}`, async () => { files[format] = await exportDrawing(s, format); }));
      }
      return {
        tasks, notes, evidence: [planShot, sectionShot], artifacts: files,
        checks: [
          { name: 'plan view shows the walls', ok: planPaths >= 4, detail: `${planPaths} plan shapes` },
          { name: '2D section drawing shows the cut walls', ok: section.panel && section.cutPolygons >= 2, detail: `status ${section.status}, panel ${section.panel}, ${section.cutPolygons} cut polygons, ${section.lines} lines` },
          { name: 'section exported as SVG with geometry', ok: svgShapes(files.svg) >= 2, detail: files.svg ? `${files.svg.name}, ${svgShapes(files.svg)} shapes` : 'no SVG' },
          { name: 'section exported as DXF', ok: isDxf(files.dxf), detail: files.dxf ? `${files.dxf.name}, ${files.dxf.bytes.length} bytes` : 'no DXF' },
          { name: 'section exported as PDF', ok: isPdf(files.pdf), detail: files.pdf ? `${files.pdf.name}, ${files.pdf.bytes.length} bytes` : 'no PDF' },
          { name: 'PDF geometry is at the requested drawing scale', ok: false, detail: 'unmeasured: requires PDF geometry-to-model dimension evidence (#9328)' },
        ],
      };
    },
  },
  {
    id: 'ui.drawing-dims',
    capability: 'dimensions-tags',
    title: 'A Distance dimension on the 2D section, exported to SVG; element tags',
    async run(s) {
      const tasks = [await setupRoom(s)];
      tasks.push(await task(s, 'setup: 2D section of the room', () => openFrontSection(s)).then((t) => ({ ...t, setup: true })));
      const plain = await exportDrawing(s, 'svg', { count: false }).catch(() => null);
      let toolbar = [];
      let canvas = null;
      tasks.push(await task(s, 'Distance tool, drag from wall to wall, Esc', async () => {
        const { page } = s;
        toolbar = await s.state(() => [...document.querySelectorAll('button,[role=radio]')].filter((b) => b.offsetParent && b.getBoundingClientRect().top > innerHeight * 0.55 && b.getBoundingClientRect().top < innerHeight * 0.65).map((b) => b.innerText.trim()).filter(Boolean));
        // The Drawing toolbar's markup tool (the section HUD has its own "distance" field, hence the exact text).
        await s.ui.click(page.getByText('Distance', { exact: true }).last());
        const active = await s.state(() => globalThis.__ifc_lite_viewer_store__.getState().measure2DMode ?? null);
        if (!active) throw new Error('the Distance tool did not become active');
        // The drawing canvas fills the panel; the fitted front section puts the two cut walls at
        // these fractions of its width (measured at 1600x900 on the baseline).
        canvas = await s.state(() => {
          const c = [...document.querySelectorAll('canvas, svg')].filter((x) => x.getBoundingClientRect().top > innerHeight * 0.58 && x.getBoundingClientRect().width > 600)
            .sort((a, b) => b.getBoundingClientRect().width * b.getBoundingClientRect().height - a.getBoundingClientRect().width * a.getBoundingClientRect().height)[0];
          if (!c) return null;
          const r = c.getBoundingClientRect();
          return { x: r.x, y: r.y, w: r.width, h: r.height, tag: c.tagName };
        });
        if (!canvas) throw new Error('no drawing canvas found');
        const y = canvas.y + canvas.h * 0.5;
        // A 2D distance is one press-drag-release from wall to wall.
        await s.ui.drag([canvas.x + canvas.w * 0.351, y], [canvas.x + canvas.w * 0.649, y]);
        await s.ui.key('Escape');
      }));
      const shot = await s.shot('dimension');
      const dimensions = await s.state(() =>
        (globalThis.__ifc_lite_viewer_store__.getState().measure2DResults ?? []).map((m) => m.distance));
      const annotations = dimensions.length;
      let svg = null;
      tasks.push(await task(s, 'Drawing > Export > SVG', async () => { svg = await exportDrawing(s, 'svg'); }));
      const added = svg && plain ? svg.text.length - plain.text.length : 0;
      const numbers = (svg?.text.match(/<text[^>]*>[^<]*\d+[.,]\d+[^<]*<\/text>/g) ?? []).length;
      const tagTool = toolbar.some((t) => /tag|label/i.test(t));
      return {
        tasks, notes: tagTool ? [] : [`The Drawing toolbar has no tag tool (${toolbar.join(', ')}).`], evidence: [shot], artifacts: { svg },
        checks: [
          { name: 'a dimension was placed in the drawing', ok: annotations > 0, detail: `${annotations} drawing markups in the store` },
          { name: 'dimension measures the 5 m room span', ok: dimensions.length === 1 && near(dimensions[0], 5, 0.25), detail: JSON.stringify(dimensions) },
          { name: 'the exported SVG carries the dimension', ok: added > 0 && numbers > 0, detail: `${added} more SVG characters than before, ${numbers} numeric text labels` },
          { name: 'a tag tool for elements (door, window, room tags)', ok: false, detail: tagTool ? 'tag control found, but no entity-bound tag placement/export oracle has passed' : `no tag control in toolbar: ${toolbar.join(', ')}` },
        ],
      };
    },
  },
  {
    id: 'ui.sheet',
    capability: 'sheets-pdf-dwg',
    title: 'Put the 2D section on a sheet and export the sheet as PDF and DXF',
    async run(s) {
      const tasks = [await setupRoom(s)];
      tasks.push(await task(s, 'setup: 2D section of the room', () => openFrontSection(s)).then((t) => ({ ...t, setup: true })));
      tasks.push(await task(s, 'Sheet, Enable Sheet', async () => {
        await s.ui.click(s.page.getByRole('button', { name: 'Sheet', exact: true }).first(), { settle: 800 });
        await s.ui.click(s.page.getByRole('button', { name: 'Enable Sheet' }), { settle: 1500 });
      }));
      const state = await drawingState(s);
      const shot = await s.shot('sheet');
      const files = {};
      tasks.push(await task(s, 'Drawing > Export > PDF (the sheet)', async () => { files.pdf = await exportDrawing(s, 'pdf'); }));
      tasks.push(await task(s, 'Drawing > Export > DXF', async () => { files.dxf = await exportDrawing(s, 'dxf'); }));
      return {
        tasks, notes: ['The drawing exports DXF; there is no DWG export.'], evidence: [shot], artifacts: files,
        checks: [
          { name: 'a sheet is active (paper, frame, title block)', ok: state.sheetEnabled && state.activeSheet, detail: `sheetEnabled ${state.sheetEnabled}, activeSheet ${state.activeSheet}` },
          { name: 'sheet exported as PDF', ok: isPdf(files.pdf), detail: files.pdf ? `${files.pdf.name}, ${files.pdf.bytes.length} bytes` : 'no PDF' },
          { name: 'drawing exported as DXF (no DWG export exists)', ok: isDxf(files.dxf), detail: files.dxf ? `${files.dxf.name}, ${files.dxf.bytes.length} bytes` : 'no DXF' },
          { name: 'drawing exported as DWG', ok: hasDwgDownload(files.dwg), detail: files.dwg?.name ?? 'no DWG export exists' },
        ],
      };
    },
  },
  {
    id: 'ui.export-ifc4',
    capability: 'psets-classification-valid-ifc4',
    title: 'File > IFC export as IFC4 with base quantities and property sets',
    async run(s) {
      const tasks = [await setupRoom(s)];
      let dl = null;
      tasks.push(await task(s, 'File > Export IFC, schema IFC4, Export', async () => {
        const { page } = s;
        const before = await downloadCount(page);
        await s.ui.click(page.getByRole('tab', { name: 'File' }));
        await s.ui.click(page.locator('[data-export-command="ifc"]'));
        const dialog = page.getByRole('dialog');
        await dialog.waitFor({ timeout: 8000 });
        await s.ui.click(dialog.getByRole('combobox').nth(1));
        await s.ui.click(page.getByRole('option', { name: /^IFC4( \(current\))?$/ }));
        await s.ui.click(dialog.getByRole('button', { name: /^Export$/ }).last());
        dl = await nextDownload(page, before);
      }));
      const step = dl ? readStep(dl.text) : null;
      const q = step ? wallQuantityCoverage(step) : [];
      const psets = step ? wallPropertySets(step) : [];
      const classified = step ? step.count('IFCCLASSIFICATIONREFERENCE') > 0 : false;
      return {
        tasks, notes: [], evidence: [],
        exportText: dl?.text ?? null,
        checks: [
          { name: 'download is IFC4', ok: step?.schema === 'IFC4', detail: `${dl?.name ?? 'no download'} schema ${step?.schema}` },
          { name: '4 walls in the file', ok: (step?.count('IFCWALL') ?? 0) === 4, detail: `${step?.count('IFCWALL')}` },
          { name: 'base quantities on walls', ok: q.length === 4 && q.every((values) => Number.isFinite(values.Length) && Number.isFinite(values.NetVolume)), detail: JSON.stringify(q) },
          { name: 'a property set on the walls', ok: psets.length === 4 && psets.every((names) => names.length > 0), detail: JSON.stringify(psets) },
          { name: 'classification reference present', ok: classified, detail: classified ? 'yes' : 'none: the modelling flow assigns no classification' },
        ],
      };
    },
  },
  {
    id: 'ui.grid-columns',
    capability: 'columns-beams-on-grid-follow-levels',
    title: 'Grid 18x12 typed, a column on a grid intersection, a beam, then a storey height change',
    async run(s) {
      const tasks = [];
      await s.harness.aim([9, -6, 40], [9, 6, 0]);
      tasks.push(await task(s, 'setup: add a storey above, so columns run to it', async () => {
        await openStoreyManager(s);
        await s.ui.click(s.page.locator('[data-storey-manager]').getByRole('button', { name: 'Add storey above' }).first(), { settle: 600 });
        await s.ui.click(s.page.getByRole('radio', { name: 'Draw on Level 1' }));
        await s.ui.click(s.page.getByRole('button', { name: 'Back to the inspector' }));
      }).then((t) => ({ ...t, setup: true })));
      tasks.push(await task(s, 'grid: Shift+G, click origin, type 18 x 12', async () => {
        await escape(s);
        await tool(s, 'grid.place');
        await s.ui.clickWorld([0, 0, 0]);
        await typeFields(s, [18, 12]);
        await escape(s);
      }));
      tasks.push(await task(s, 'column: Shift+C, click near the grid intersection (6,6)', async () => {
        await tool(s, 'column.place');
        await s.ui.clickWorld([6.08, 6.08, 0]);
        await escape(s);
      }));
      tasks.push(await task(s, 'beam: Shift+B, click (0,0) then (6,0)', async () => {
        await tool(s, 'beam.place');
        await s.ui.clickWorld([0.05, 0.05, 0]);
        await s.ui.clickWorld([6.05, 0.05, 0]);
        await escape(s);
      }));
      tasks.push(await task(s, 'raise Level 1 floor-to-floor to 4.0 in the storey manager', async () => {
        await openStoreyManager(s);
        await s.ui.click(s.page.getByLabel('Floor-to-floor height of Level 1, metres'));
        await s.ui.key('Control+A');
        await s.ui.type('4');
        await s.ui.key('Enter', { settle: 1200 });
      }));
      const shot = await s.shot('grid');
      const { step } = await oracleModel(s);
      const col = step.of('IFCCOLUMN')[0];
      // Column height = depth of its body extrusion.
      const body = col && (step.get(col.args?.[6])?.args?.[2] ?? []).map(step.get).find((r) => r?.args?.[1] === 'Body');
      const solid = body && step.get(body.args[3]?.[0]);
      const colHeight = solid?.type === 'IFCEXTRUDEDAREASOLID' ? solid.args[3] : null;
      const p = col ? step.placement(col.id).origin : null;
      // The grid origin carries the click's few-mm error; binding to the grid is exact.
      const bound = !!col && step.get(step.get(col.args?.[5])?.args?.[0])?.type === 'IFCGRIDPLACEMENT';
      const axes = step.count('IFCGRIDAXIS');
      return {
        tasks, notes: [], evidence: [shot],
        checks: [
          { name: 'IfcGrid with axes', ok: step.count('IFCGRID') === 1 && axes >= 4, detail: `${step.count('IFCGRID')} grids, ${axes} axes` },
          { name: 'column bound to the grid intersection (6,6) by IfcGridPlacement', ok: bound && !!p && nearPt(p, [6, 6], 0.03), detail: p ? `${fmt(p)}${bound ? ', grid placement' : ', free placement'}` : 'no column' },
          { name: 'IfcBeam', ok: step.count('IFCBEAM') === 1, detail: `${step.count('IFCBEAM')}` },
          { name: 'the column follows the storey height change to 4.0 m', ok: typeof colHeight === 'number' && near(colHeight, 4, 0.01), detail: `column height ${colHeight}` },
        ],
      };
    },
  },
];

// The original combined probe only credited the structure row, leaving grids unscored.
const gridProbe = PROBES.find((p) => p.id === 'ui.grid-columns');
PROBES.push({
  ...gridProbe, id: 'ui.grids', capability: 'grids',
  async run(s) {
    const out = await gridProbe.run(s);
    return { ...out, checks: [...out.checks.slice(0, 2), {
      name: 'moving a grid carries its columns', ok: false,
      detail: 'not measured by placement/level-change probe: grid movement and bound column displacement require a separate gesture',
    }] };
  },
});

/** Run one probe in a fresh page. Returns a contract result plus the export text when the probe has one. */
export async function runProbe(probe, openFresh, base, { saveArtifact } = {}) {
  const s = await openFresh(probe.id);
  const t0 = Date.now();
  let out;
  let error = null;
  try {
    const { startBlank } = await import('./lib/model-ui.mjs');
    await startBlank(s, { count: false });
    await s.harness.aim(PLAN_CAM.pos, PLAN_CAM.target);
    out = await probe.run(s);
  } catch (e) {
    error = String(e.message ?? e).split('\n')[0].slice(0, 400);
    out = { tasks: [], checks: [], notes: [] };
  }
  const wall = Date.now() - t0;
  const counted = out.tasks.filter((t) => !t.setup);
  const setup = out.tasks.filter((t) => t.setup);
  const failedTasks = out.tasks.filter((t) => !t.ok);
  const okChecks = out.checks.filter((c) => c.ok).length;
  let status;
  if (error) status = 'error';
  // A failed task can leave an earlier, correct state behind; it never reads as a pass.
  else if (out.checks.length && okChecks === out.checks.length && !s.scriptedSteps.length && !failedTasks.length) status = 'pass';
  else if (okChecks > 0) status = 'partial';
  else status = 'fail';
  const reasons = [];
  if (error) reasons.push(`probe error: ${error}`);
  for (const c of out.checks.filter((x) => !x.ok)) reasons.push(`${c.name}: ${c.detail}`);
  for (const t of failedTasks) reasons.push(`task "${t.name}" failed: ${t.error}`);
  if (s.scriptedSteps.length) reasons.push(`scripted through the store: ${s.scriptedSteps.join(', ')}`);
  const result = {
    ...base,
    capability: probe.capability,
    probe: 'ui',
    id: probe.id,
    title: probe.title,
    status,
    ...(status === 'pass' ? {} : { reason: reasons.join('; ') || 'no check passed' }),
    metrics: {
      ms: counted.reduce((n, t) => n + t.ms, 0),
      actions: counted.reduce((n, t) => n + t.actions, 0),
      setupActions: setup.reduce((n, t) => n + t.actions, 0),
      wallMs: wall,
      cameraJumps: s.counters.cameraJumps,
      ...out.metrics,
    },
    checks: out.checks,
    tasks: out.tasks.map(({ value: _value, ...t }) => t),
    notes: [...out.notes, ...s.findings],
    scripted: s.scriptedSteps,
    pageErrors: s.pageErrors,
    evidence: (out.evidence ?? []).filter(Boolean).map((e) => `shots/${e.file}`),
    evidenceSha256: Object.fromEntries((out.evidence ?? []).filter(Boolean).map((e) => [`shots/${e.file}`, e.sha256])),
  };
  await s.close();
  // Files the probe produced, for the output probes (L1): the exported IFC and any drawing files.
  const files = { ...out.artifacts };
  const ifcText = out.exportText ?? s.lastExport?.text ?? null;
  if (ifcText) files.ifc = { name: `${probe.id}.ifc`, bytes: Buffer.from(ifcText, 'utf8') };
  if (saveArtifact) {
    const artifacts = {};
    for (const [kind, file] of Object.entries(files)) {
      if (file?.bytes) artifacts[kind] = await saveArtifact(probe.capability, file.name, file.bytes);
    }
    if (Object.keys(artifacts).length) {
      result.artifacts = artifacts;
      result.evidence.push(...Object.values(artifacts));
    }
  }
  return { result };
}

