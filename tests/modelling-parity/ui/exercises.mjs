/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * UI exercise runs F1 and F2 for the modelling parity climb (#9296).
 *
 * An exercise is the whole building, modelled from "Start blank" to an
 * exported IFC through the UI, the way a modeller would: tool shortcuts,
 * typed lengths, clicks on walls, the storey chip and manager, File > Export.
 * Every click and key counts. The exported file is the oracle.
 *
 * Checkpoints are the council frames: at fixed points the run sets a fixed
 * camera, waits for the scene to settle and captures `<exercise>-<checkpoint>`
 * in the run's theme at 1600x900. Running the same exercise in light and dark
 * gives the frame pairs `tests/ui-scenes/pair.mjs` compares across builds.
 * Change a checkpoint only between campaigns: a new one has no baseline.
 */

import { loadTarget, ownOpenings, uniqueWallJoins } from './lib/oracles.mjs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { downloadCount, nextDownload, sha256, task } from './lib/driver.mjs';
import { escape, openStoreyManager, readSession, startBlank, switchStorey, toasts, tool, typeFields } from './lib/model-ui.mjs';
import { readStep } from './lib/step.mjs';

const near = (a, b, tol) => Math.abs(a - b) <= tol;

/** Layout numbers the council's hard constraints use, as tests/ui-scenes/capture.mjs measures them. */
async function measureLayout(page) {
  return page.evaluate(() => {
    const canvases = [...document.querySelectorAll('canvas')];
    const main = canvases.sort((a, b) => b.clientWidth * b.clientHeight - a.clientWidth * a.clientHeight)[0] ?? null;
    const cols = 64; const rows = 40;
    let onCanvas = 0;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const hit = document.elementFromPoint((c + 0.5) * innerWidth / cols, (r + 0.5) * innerHeight / rows);
        if (main && hit === main) onCanvas++;
      }
    }
    let minFontPx = Infinity; let small = 0; let total = 0;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const el = node.parentElement;
      if (!el || !node.textContent.trim()) continue;
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.bottom < 0 || rect.top > innerHeight || rect.right < 0 || rect.left > innerWidth) continue;
      const style = getComputedStyle(el);
      if (style.visibility === 'hidden' || Number(style.opacity) === 0) continue;
      const size = parseFloat(style.fontSize);
      total++;
      if (size < 11) small++;
      minFontPx = Math.min(minFontPx, size);
    }
    return {
      modelVisibleFraction: Math.round((onCanvas / (cols * rows)) * 1000) / 1000,
      minFontPx: Number.isFinite(minFontPx) ? minFontPx : null,
      smallTextShare: total ? Math.round((small / total) * 1000) / 1000 : 0,
      visibleTextNodes: total,
    };
  });
}

/** Walls typed as a closed rectangle from `o` (z is the storey elevation). */
async function typedRect(s, o, w, d) {
  await s.ui.clickWorld(o);
  await typeFields(s, [w, 0]);
  await typeFields(s, [d, 90]);
  await typeFields(s, [w, 180]);
  await typeFields(s, [d, 270]);
  await escape(s);
}

/** Click a labelled field, select all, type, Enter (four actions plus the typed characters). */
async function editField(s, label, value) {
  await s.ui.click(s.page.getByLabel(label, { exact: true }));
  await s.ui.key('Control+A');
  await s.ui.type(String(value));
  await s.ui.key('Enter', { settle: 600 });
}

/** A value in the right-hand Defaults panel of the active tool. */
const setDefault = (s, label, value) => editField(s, label, value);

/** Click each host point; restart the tool if a placement ended it. */
async function hostClicks(s, command, points) {
  for (const p of points) {
    if ((await readSession(s)).command !== command) await tool(s, command);
    await s.ui.clickWorld(p);
  }
}

/** The Room tool's mode radio (Pick / Draw / Edit), clicked only when it is not already on. */
async function roomMode(s, mode) {
  const radio = s.page.locator('[data-command-id]').getByRole('radio', { name: mode, exact: true });
  if ((await radio.getAttribute('aria-checked')) !== 'true') await s.ui.click(radio);
}

/** File > Export modified IFC; returns the open review dialog so a checkpoint can frame it. */
async function openExportReview(s) {
  const { page } = s;
  await s.ui.click(page.getByRole('tab', { name: 'File' }));
  await s.ui.click(page.locator('[data-export-command="modified-ifc"]'));
  await page.getByRole('dialog').waitFor({ timeout: 8000 });
}

async function confirmExport(s) {
  const { page } = s;
  const before = await downloadCount(page);
  await s.ui.click(page.getByRole('dialog').getByRole('button', { name: /^Export$/ }).last());
  return nextDownload(page, before);
}

function commonChecks(step, want) {
  const c = step.counts(['IFCWALL', 'IFCDOOR', 'IFCWINDOW', 'IFCSLAB', 'IFCSPACE', 'IFCOPENINGELEMENT', 'IFCRELFILLSELEMENT', 'IFCRELCONNECTSPATHELEMENTS', 'IFCSTAIR', 'IFCSTAIRFLIGHT', 'IFCROOF']);
  const floorSlabs = step.of('IFCSLAB').filter((x) => x.args?.[8]?.enum !== 'ROOF');
  const contained = step.containment();
  const elements = ['IFCWALL', 'IFCDOOR', 'IFCWINDOW', 'IFCSLAB', 'IFCSTAIR'].flatMap((t) => step.of(t));
  const uncontained = elements.filter((e) => !contained.has(e.id)).length;
  // Each filler is matched to its own opening and host wall, so two fills on one door can't stand in for a window.
  const wallIds = new Set(step.of('IFCWALL').map((w) => w.id));
  const fillers = [...step.of('IFCDOOR'), ...step.of('IFCWINDOW')];
  const unhosted = fillers.filter((e) => !wallIds.has(step.hostOf(e.id)));
  return {
    c,
    checks: [
      { name: `${want.walls} walls`, ok: c.IFCWALL === want.walls, detail: `${c.IFCWALL}` },
      { name: `walls joined at every corner (${want.walls} joins)`, ok: uniqueWallJoins(step) >= want.walls, detail: `${c.IFCRELCONNECTSPATHELEMENTS}` },
      { name: `${want.doors} door(s)`, ok: c.IFCDOOR === want.doors, detail: `${c.IFCDOOR}` },
      { name: `${want.windows} window(s)`, ok: c.IFCWINDOW === want.windows, detail: `${c.IFCWINDOW}` },
      { name: 'every door and window fills its own opening in a wall', ok: ownOpenings(step,fillers) && unhosted.length === 0 && fillers.length === want.doors + want.windows, detail: unhosted.length ? `${unhosted.length} of ${fillers.length} not hosted in a wall: #${unhosted.map((e) => e.id).join(', #')}` : `${fillers.length} hosted` },
      { name: `${want.slabs} floor slab(s)`, ok: floorSlabs.length === want.slabs, detail: `${floorSlabs.length}` },
      { name: `${want.spaces} space(s)`, ok: c.IFCSPACE === want.spaces, detail: `${c.IFCSPACE}` },
      { name: 'every element is contained in a storey', ok: uncontained === 0, detail: `${uncontained} uncontained` },
    ],
  };
}

/**
 * FZK-Haus plan, read from the reference IFC (tests/modelling-parity/references, PR #9304):
 * inner wall axes, door and window centres on their host walls, and the rooms.
 */
const FZK_INNER_WALLS = [
  { start: [0, 5.75], legs: [[7.41, 0]] },
  { start: [7.41, 10], legs: [[5.75, 270], [4.59, 0]] },
  { start: [0, 4.25], legs: [[3.8, 0]] },
  { start: [3.8, 10], legs: [[4.25, 270]] },
];
const FZK_DOORS = [
  { width: 0.885, height: 2.01, at: [[7.41, 5.0, 1], [5.66, 5.75, 1], [2.05, 5.75, 1]] },
  { width: 1.01, height: 2.01, at: [[0, 5.0, 1]] },
  { width: 2.01, height: 2.375, at: [[6.0, 0, 1]] },
];
const FZK_EG_WINDOWS = [[0, 7.5, 1.4], [0, 2.21, 1.4], [2.79, 0, 1.4], [9.21, 0, 1.4], [12, 7.5, 1.4], [12, 2.21, 1.4], [2.05, 10, 1.4], [5.66, 10, 1.4], [9.79, 10, 1.4]];
const FZK_PICKED_ROOMS = [[1.9, 7.9], [5.6, 7.9], [9.7, 7.1]];
const FZK_DRAWN_ROOMS = [
  { name: 'Kueche', corner: [0, 0], w: 3.8, d: 4.25 },
  { name: 'Flur', corner: [0, 4.25], w: 7.41, d: 1.5 },
  { name: 'Wohnen', corner: [3.8, 0], w: 8.2, d: 4.25 },
];

/** The numbers F2 is judged on: the target file when lane L5's references are present, else this copy of it. */
const FZK_TARGET_FALLBACK = {
  storeys: [
    { name: 'Erdgeschoss', elevation: 0, walls: { count: 9, totalLength: 69.8 }, doors: { count: 5, widthXHeight: { '0.885x2.01': 3, '1.01x2.01': 1, '2.01x2.375': 1 } }, windows: { count: 9, widthXHeight: { '2x1.2': 9 } }, stairs: 1 },
    { name: 'Dachgeschoss', elevation: 2.7, walls: { count: 4, totalLength: 44 }, doors: { count: 0, widthXHeight: {} }, windows: { count: 2, widthXHeight: { '1x1': 2 } }, stairs: 0 },
  ],
  totals: { spaces: 7 },
  spaces: [11.53, 12.99, 12.5, 22.07, 25.99, 16.31, 107.16].map((area) => ({ area })),
  footprint: { bboxWidthX: 12, bboxDepthY: 10 },
  roof: { inferredForm: 'gable', slopes: [{ tiltDeg: 30 }, { tiltDeg: 30 }] },
  tolerances: { elevationM: { value: 0.05 }, wallCountPerStorey: { value: 0.15 }, wallTotalLengthPerStorey: { value: 0.05 }, openingSizeM: { value: 0.05 }, footprintBboxM: { value: 0.15 }, spaceAreaM2: { value: 0.05 } },
};
const TARGET_FILE = new URL('../references/f2-fzk-haus-target.json', import.meta.url);
function fzkTarget() {
  return loadTarget(TARGET_FILE,FZK_TARGET_FALLBACK);
}

function fzkOracle(step) {
  const T = fzkTarget();
  const tol = T.tolerances;
  const checks = [];
  const storeys = step.storeys();
  const contained = step.containment();
  const onStorey = (id, type) => step.of(type).filter((e) => contained.get(e.id) === id);
  for (const ts of T.storeys) {
    // Matched by name only: a storey at the right height with another name is not the reference storey.
    const st = storeys.find((x) => x.name === ts.name);
    const label = ts.name;
    checks.push({ name: `${label} at ${ts.elevation} m`, ok: !!st && near(st.elevation, ts.elevation, tol.elevationM.value), detail: st ? `${st.name}@${st.elevation}` : 'missing' });
    if (!st) continue;
    const walls = step.wallAxes().filter((w) => contained.get(w.id) === st.id);
    const total = walls.reduce((n, w) => n + w.length, 0);
    checks.push({ name: `${label}: ${ts.walls.count} walls (rel ${tol.wallCountPerStorey.value})`, ok: Math.abs(walls.length - ts.walls.count) <= ts.walls.count * tol.wallCountPerStorey.value, detail: `${walls.length}` });
    checks.push({ name: `${label}: wall length ${ts.walls.totalLength} m (rel ${tol.wallTotalLengthPerStorey.value})`, ok: Math.abs(total - ts.walls.totalLength) <= ts.walls.totalLength * tol.wallTotalLengthPerStorey.value, detail: total.toFixed(2) });
    for (const [kind, type] of [['doors', 'IFCDOOR'], ['windows', 'IFCWINDOW']]) {
      const got = onStorey(st.id, type);
      checks.push({ name: `${label}: ${ts[kind].count} ${kind}`, ok: got.length === ts[kind].count, detail: `${got.length}` });
      const wallIds = new Set(step.of('IFCWALL').map((w) => w.id));
      const unhosted = got.filter((e) => !wallIds.has(step.hostOf(e.id)));
      if (got.length) checks.push({ name: `${label}: every ${kind.slice(0, -1)} fills its own opening in a wall`, ok: ownOpenings(step,[...step.of('IFCDOOR'),...step.of('IFCWINDOW')]) && unhosted.length === 0, detail: unhosted.length ? `not hosted: #${unhosted.map((e) => e.id).join(', #')}` : `${got.length} hosted` });
      if (!ts[kind].count) continue;
      // Sizes: every reference size bucket is matched by that many elements within the tolerance.
      const sizes = got.map((e) => [e.args?.[8], e.args?.[9]]);
      const missing = [];
      for (const [key, n] of Object.entries(ts[kind].widthXHeight)) {
        const [w, h] = key.split('x').map(Number);
        const match = sizes.filter(([gh, gw]) => near(gw, w, tol.openingSizeM.value) && near(gh, h, tol.openingSizeM.value)).length;
        if (match < n) missing.push(`${key}: ${match}/${n}`);
      }
      checks.push({ name: `${label}: ${kind} sizes match (abs ${tol.openingSizeM.value} m)`, ok: missing.length === 0, detail: missing.join(', ') || 'all matched' });
    }
    // Checked on every storey, including the ones that expect none.
    if (typeof ts.stairs === 'number') checks.push({ name: `${label}: ${ts.stairs} stair(s)`, ok: onStorey(st.id, 'IFCSTAIR').length === ts.stairs, detail: `${onStorey(st.id, 'IFCSTAIR').length}` });
  }
  const eg = storeys[0];
  const egWalls = eg ? step.wallAxes().filter((w) => contained.get(w.id) === eg.id) : [];
  const xs = egWalls.flatMap((w) => [w.start[0], w.end[0]]); const ys = egWalls.flatMap((w) => [w.start[1], w.end[1]]);
  const bw = xs.length ? Math.max(...xs) - Math.min(...xs) : 0; const bd = ys.length ? Math.max(...ys) - Math.min(...ys) : 0;
  checks.push({ name: `footprint ${T.footprint.bboxWidthX} x ${T.footprint.bboxDepthY} m (abs ${tol.footprintBboxM.value})`, ok: near(bw, T.footprint.bboxWidthX, tol.footprintBboxM.value) && near(bd, T.footprint.bboxDepthY, tol.footprintBboxM.value), detail: `${bw.toFixed(2)} x ${bd.toFixed(2)}` });
  const spaces = step.of('IFCSPACE');
  checks.push({ name: `${T.totals.spaces} spaces`, ok: spaces.length === T.totals.spaces, detail: `${spaces.length}` });
  // The UI names rooms "Room N", so spaces are matched to reference areas greedily by area, not by name.
  const got = spaces.map((sp) => { const q = step.quantities(sp.id); return q.NetFloorArea ?? q.GrossFloorArea ?? null; }).filter((v) => typeof v === 'number');
  const pool = [...got];
  const unmatched = [];
  for (const ref of T.spaces.map((x) => x.area).sort((a, b) => b - a)) {
    const i = pool.findIndex((v) => Math.abs(v - ref) <= ref * tol.spaceAreaM2.value);
    if (i >= 0) pool.splice(i, 1); else unmatched.push(ref);
  }
  checks.push({ name: `space areas match the reference (rel ${tol.spaceAreaM2.value}, matched by area)`, ok: unmatched.length === 0 && got.length === T.spaces.length, detail: `areas ${got.map((v) => v.toFixed(2)).join(', ')}; unmatched reference ${unmatched.join(', ') || 'none'}` });
  const roofs = [...step.of('IFCROOF'), ...step.of('IFCSLAB').filter((x) => x.args?.[8]?.enum === 'ROOF')];
  checks.push({ name: `${T.roof.inferredForm} roof at ${T.roof.slopes[0].tiltDeg} degrees`, ok: false, detail: roofs.length ? `${roofs.length} roof element(s), flat` : 'no roof: the UI has no sloped or gable roof (the Slab tool\'s Roof class makes a flat slab on the active storey floor; see ui.roof and #9214)' });
  return { checks, target: T.from };
}

export const EXERCISES = {
  F1: {
    id: 'F1',
    title: 'A room, 5x4 m, with a door, window, floor slab and space',
    drawCam: { pos: [2.5, -2, 28], target: [2.5, 2, 0] },
    frameCam: { pos: [13, -11, 10], target: [2.5, 2, 1] },
    steps: [
      { name: 'Start blank', run: (s) => startBlank(s) },
      { name: 'walls: typed 5/4/5/4 m (wall tool is active after Start blank)', run: (s) => typedRect(s, [0, 0, 0], 5, 4), checkpoint: 'walls' },
      { name: 'door: Shift+D, click the south wall', run: async (s) => { await tool(s, 'door.place'); await s.ui.clickWorld([2.5, 0, 1]); await escape(s); } },
      { name: 'window: Shift+W, click the east wall', run: async (s) => { await tool(s, 'window.place'); await s.ui.clickWorld([5, 2, 1.5]); await escape(s); }, checkpoint: 'openings' },
      { name: 'floor slab: Shift+S, click a corner, typed 5 x 4', run: async (s) => { await tool(s, 'slab.place'); await s.ui.clickWorld([0, 0, 0]); await typeFields(s, [5, 4]); await escape(s); } },
      { name: 'space: Shift+O, click inside', run: async (s) => { await tool(s, 'room.place'); await s.ui.clickWorld([2.5, 2, 0]); await escape(s); }, checkpoint: 'room' },
      { name: 'export: File > Modified IFC (review dialog)', run: (s) => openExportReview(s), checkpoint: 'export-review', keepCamera: true },
      { name: 'export: confirm', run: async (s) => { s.download = await confirmExport(s); }, checkpoint: 'done' },
    ],
    oracle(step) {
      const { checks } = commonChecks(step, { walls: 4, doors: 1, windows: 1, slabs: 1, spaces: 1 });
      const axes = step.wallAxes();
      const lengths = axes.map((a) => a.length);
      const space = step.of('IFCSPACE')[0];
      const q = space ? step.quantities(space.id) : {};
      const area = q.NetFloorArea ?? q.GrossFloorArea;
      checks.push({ name: 'walls are exactly 5, 4, 5, 4 m', ok: lengths.length === 4 && [5, 4, 5, 4].every((v, i) => near(lengths[i], v, 1e-3)), detail: lengths.map((v) => v.toFixed(3)).join(', ') });
      checks.push({ name: 'space floor area 18.24 m2 (inside the walls)', ok: typeof area === 'number' && near(area, 18.24, 0.05), detail: JSON.stringify(q) });
      return checks;
    },
  },
  F2: {
    id: 'F2',
    title: 'The KIT FZK-Haus: 12x10 m, storeys at 0 and 2.7 m, 13 walls, 5 doors, 11 windows, a stair, 7 spaces, a 30 degree gable roof',
    drawCam: { pos: [6, -5, 34], target: [6, 5, 0] },
    frameCam: { pos: [28, -22, 20], target: [6, 5, 2] },
    steps: [
      { name: 'Start blank', run: (s) => startBlank(s) },
      {
        name: 'storeys: Manage storeys, add above, floor-to-floor 2.7, rename both, draw on Erdgeschoss',
        run: async (s) => {
          await openStoreyManager(s);
          await s.ui.click(s.page.locator('[data-storey-manager]').getByRole('button', { name: 'Add storey above' }).first(), { settle: 600 });
          await editField(s, 'Floor-to-floor height of Level 1, metres', '2.7');
          await editField(s, 'Name of Level 1', 'Erdgeschoss');
          await editField(s, 'Name of Level 2', 'Dachgeschoss');
          await s.ui.click(s.page.getByRole('radio', { name: 'Draw on Erdgeschoss' }));
        },
        checkpoint: 'storeys',
        keepCamera: true,
      },
      // The manager holds the right panel; the tool Defaults (door and window sizes) live behind it.
      { name: 'close the storey manager: Back to the inspector', run: (s) => s.ui.click(s.page.getByRole('button', { name: 'Back to the inspector' })) },
      { name: 'EG base slab: Shift+S, typed 12 x 10', run: async (s) => { await escape(s); await tool(s, 'slab.place'); await s.ui.clickWorld([0, 0, 0]); await typeFields(s, [12, 10]); await escape(s); } },
      { name: 'EG outer walls: W, typed 12/10/12/10 m', run: async (s) => { await tool(s, 'wall.place'); await typedRect(s, [0, 0, 0], 12, 10); } },
      {
        name: 'EG inner walls: 5 walls, Alt+click each start (no surface snap), typed length and angle',
        run: async (s) => {
          await tool(s, 'wall.place');
          for (const run of FZK_INNER_WALLS) {
            await s.ui.clickWorld([run.start[0], run.start[1], 0], { modifiers: ['Alt'] });
            for (const [len, ang] of run.legs) await typeFields(s, [len, ang]);
            await escape(s, 1);
          }
          await escape(s);
        },
        checkpoint: 'EG-walls',
      },
      {
        name: 'EG doors: Shift+D, sizes in the Defaults panel, click the host walls',
        run: async (s) => {
          for (const group of FZK_DOORS) {
            await tool(s, 'door.place');
            await setDefault(s, 'Width in metres', group.width);
            await setDefault(s, 'Height in metres', group.height);
            await hostClicks(s, 'door.place', group.at);
            await escape(s);
          }
        },
      },
      {
        name: 'EG windows: Shift+W, 2.0 x 1.2 sill 0.8 in the Defaults panel, click 9 wall points',
        run: async (s) => {
          await tool(s, 'window.place');
          await setDefault(s, 'Width in metres', 2);
          await setDefault(s, 'Height in metres', 1.2);
          await setDefault(s, 'Sill height in metres', 0.8);
          await hostClicks(s, 'window.place', FZK_EG_WINDOWS);
          await escape(s);
        },
        checkpoint: 'EG-openings',
      },
      {
        name: 'EG spaces: Shift+O, Pick in the 3 walled rooms, Draw rectangles for Kueche, Flur, Wohnen (no wall between them)',
        run: async (s) => {
          await tool(s, 'room.place');
          for (const p of FZK_PICKED_ROOMS) {
            if ((await readSession(s)).command !== 'room.place') await tool(s, 'room.place');
            await s.ui.clickWorld([p[0], p[1], 0], { modifiers: ['Alt'] });
          }
          for (const r of FZK_DRAWN_ROOMS) {
            if ((await readSession(s)).command !== 'room.place') await tool(s, 'room.place');
            await roomMode(s, 'Draw');
            await s.ui.clickWorld([r.corner[0], r.corner[1], 0], { modifiers: ['Alt'] });
            await typeFields(s, [r.w, r.d]);
          }
          await escape(s);
        },
      },
      { name: 'stair EG to DG: Shift+T, click the foot and the head of a 3.6 m run', run: async (s) => { await tool(s, 'stair.place'); await s.ui.clickWorld([8.2, 0.8, 0]); await s.ui.clickWorld([11.8, 0.8, 0]); await escape(s); }, checkpoint: 'EG-done' },
      { name: 'switch to Dachgeschoss (storey chip)', run: (s) => switchStorey(s, 'Dachgeschoss'), cam: { pos: [6, -5, 37], target: [6, 5, 2.7] } },
      { name: 'DG floor slab: Shift+S, typed 12 x 10', run: async (s) => { await tool(s, 'slab.place'); await s.ui.clickWorld([0, 0, 2.7]); await typeFields(s, [12, 10]); await escape(s); } },
      { name: 'DG walls: W, typed 12/10/12/10 m', run: async (s) => { await tool(s, 'wall.place'); await typedRect(s, [0, 0, 2.7], 12, 10); } },
      {
        name: 'DG gable windows: Shift+W, 1.0 x 1.0 in the Defaults panel, click both gable walls',
        run: async (s) => {
          await tool(s, 'window.place');
          await setDefault(s, 'Width in metres', 1);
          await setDefault(s, 'Height in metres', 1);
          await hostClicks(s, 'window.place', [[0, 5, 4.2], [12, 5, 4.2]]);
          await escape(s);
        },
      },
      {
        name: 'DG space: Shift+O, Pick inside',
        run: async (s) => { await tool(s, 'room.place'); await roomMode(s, 'Pick'); await s.ui.clickWorld([6, 5, 2.7], { modifiers: ['Alt'] }); await escape(s); },
        checkpoint: 'DG-done',
      },
      { name: 'export: File > Modified IFC (review dialog)', run: (s) => openExportReview(s), checkpoint: 'export-review', keepCamera: true },
      { name: 'export: confirm', run: async (s) => { s.download = await confirmExport(s); }, checkpoint: 'done' },
    ],
    oracle: (step) => fzkOracle(step),
  },
};

/**
 * Run one exercise in a fresh page. `measured` marks the run whose actions
 * and timings are reported; the other theme's run only writes frames.
 */
export async function runExercise(ex, { openFresh, theme, shots, frames, saveArtifact, base, measured }) {
  const s = await openFresh(`${ex.id}-${theme}`, theme, shots);
  const tasks = [];
  const notes = [];
  const frameResults = [];
  const frameFailures = [];
  const evidence = [];
  let cam = ex.drawCam;
  let aimed = false;
  for (const st of ex.steps) {
    if (st.cam) cam = st.cam;
    if (aimed || st.name !== 'Start blank') {
      if (!aimed || st.cam) await s.harness.aim(cam.pos, cam.target);
      aimed = true;
    }
    const t = await task(s, st.name, () => st.run(s));
    tasks.push(t);
    if (!t.ok) {
      notes.push(`step "${st.name}" failed: ${t.error}`);
      const shot = await s.shot(`fail-${tasks.length}`);
      if (shot) evidence.push(shot);
      // Recover to a known state so later steps still measure something.
      await s.page.keyboard.press('Escape').catch(() => {});
      await s.page.keyboard.press('Escape').catch(() => {});
    }
    const t2 = await toasts(s);
    for (const msg of t2) if (/can't|cannot|doesn't|don't|failed|error|no storey|point at/i.test(msg) && !notes.includes(`toast: ${msg}`)) notes.push(`toast: ${msg}`);
    if (st.checkpoint && frames) {
      const id = `${ex.id}-${st.checkpoint}`;
      try {
        if (!st.keepCamera) await s.harness.aim(ex.frameCam.pos, ex.frameCam.target, { pin: false });
        await s.harness.dismissToasts();
        await s.settle(1200);
        const metrics = await measureLayout(s.page);
        const file = `${id}.${theme}.png`;
        const png = await s.page.screenshot();
        await writeFile(join(frames, file), png);
        frameResults.push({ scene: id, title: `${ex.id}: ${st.name}`, theme, viewport: { width: 1600, height: 900 }, file, sha256: sha256(png), metrics, pageErrors: [...s.pageErrors] });
        if (!st.keepCamera) await s.harness.aim(cam.pos, cam.target);
      } catch (error) {
        frameFailures.push({ scene: id, theme, error: String(error).slice(0, 500) });
      }
    }
  }
  let checks = [];
  let targetFrom = null;
  let ifcPath = null;
  if (s.download?.text) {
    if (measured && saveArtifact) ifcPath = await saveArtifact(ex.id, `${ex.id}.ui.ifc`, s.download.bytes);
    const judged = ex.oracle(readStep(s.download.text));
    checks = Array.isArray(judged) ? judged : judged.checks;
    if (!Array.isArray(judged)) targetFrom = judged.target;
  } else {
    checks = [{ name: 'the model was exported', ok: false, detail: 'no download' }];
  }
  notes.push(...s.findings);
  if (s.counters.cameraJumps) notes.push(`the camera moved by itself ${s.counters.cameraJumps} time(s) during drawing`);
  const session = await readSession(s).catch(() => null);
  await s.close();
  const ok = checks.filter((c) => c.ok).length;
  const status = ok === checks.length && !s.scriptedSteps.length && tasks.every((t) => t.ok) ? 'pass' : ok > 0 ? 'partial' : 'fail';
  const reasons = [...checks.filter((c) => !c.ok).map((c) => `${c.name}: ${c.detail}`), ...tasks.filter((t) => !t.ok).map((t) => `step "${t.name}" failed`)];
  const result = {
    ...base,
    capability: null,
    exercise: ex.id,
    probe: 'exercise',
    mode: 'ui',
    id: `${ex.id}.ui`,
    title: ex.title,
    status,
    ...(status === 'pass' ? {} : { reason: reasons.join('; ') }),
    metrics: {
      ms: tasks.reduce((n, t) => n + t.ms, 0),
      actions: tasks.reduce((n, t) => n + t.actions, 0),
      clicks: s.counters.clicks,
      keys: s.counters.keys,
      steps: tasks.length,
      cameraJumps: s.counters.cameraJumps,
    },
    checks,
    ...(targetFrom ? { target: targetFrom } : {}),
    tasks,
    notes,
    scripted: s.scriptedSteps,
    pageErrors: s.pageErrors,
    finalSession: session,
    evidence: [...evidence.map((e) => `shots/${e.file}`), ...frameResults.map((f) => `frames/${f.file}`), ...(ifcPath ? [ifcPath] : [])],
    ...(ifcPath ? { artifacts: { ifc: ifcPath } } : {}),
  };
  return { result, frames: frameResults, frameFailures };
}
