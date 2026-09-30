/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// A4b room parity (#6232) on AC20-FZK-Haus via real-GPU Chrome: Edit (drag corner, split, merge),
// Footprint, Auto on every storey, leaks for an open region.
import { readFileSync } from 'node:fs';
const AC20 = '/mnt/c/Users/louistrue/Documents/Dev/ifc-lite/tests/models/ara3d/AC20-FZK-Haus.ifc';
const SHOT = (n) => `/home/louistrue/modelling-refactor/shots/a4b-${n}.png`;

const state = (page) => page.evaluate(() => {
  const s = globalThis.__ifc_lite_viewer_store__.getState();
  const [modelId] = [...s.models.keys()];
  const view = s.mutationViews.get(modelId);
  const spaces = view ? view.getNewEntities().filter((e) => e.type.toUpperCase() === 'IFCSPACE' && !view.isDeleted(e.expressId)) : [];
  const area = (fp) => Math.abs(fp.reduce((a, p, i) => { const q = fp[(i + 1) % fp.length]; return a + p[0] * q[1] - q[0] * p[1]; }, 0) / 2);
  return {
    undo: [...s.undoStacks.values()].reduce((n, st) => n + st.length, 0),
    spaces: spaces.map((e) => ({ id: e.expressId, area: +area(s.readSlabFootprint(modelId, e.expressId)?.footprint ?? []).toFixed(2) })),
    faces: document.querySelectorAll('[data-plan-command="room.place"] [data-room-face]').length,
    linked: document.querySelectorAll('[data-plan-command="room.place"] [data-room-linked]').length,
    faces3d: document.querySelectorAll('svg:not([data-plan-canvas]) [data-room-face]').length,
    leakWalls: document.querySelectorAll('[data-plan-command="room.place"] [data-room-leak-wall]').length,
    openEnds: document.querySelectorAll('[data-plan-command="room.place"] [data-room-open-end]').length,
  };
});
const boxes = (page) => page.evaluate(() => [...document.querySelectorAll('[data-plan-command="room.place"] [data-room-linked]')].map((p) => {
  const r = p.getBoundingClientRect(); return { id: p.getAttribute('data-room-linked'), x0: r.left, y0: r.top, x1: r.right, y1: r.bottom, w: r.width, h: r.height };
}));
const roomsOnly = async (page) => page.evaluate(() => {
  // Setup: take the file's own (faceted) IfcSpaces out so the tool has rooms to make and edit.
  const s = globalThis.__ifc_lite_viewer_store__.getState();
  const [modelId] = [...s.models.keys()];
  const ids = new Set();
  for (const m of s.models.get(modelId).geometryResult.meshes) {
    if (m.ifcType !== 'IfcSpace') continue;
    const ref = s.resolveGlobalIdFromModels(m.expressId); if (ref) ids.add(ref.expressId);
  }
  for (const id of ids) s.removeEntity(modelId, id);
  return ids.size;
});

export default async (page) => {
  const log = {};
  await page.waitForTimeout(1500);
  await page.locator('text=Privacy settings').locator('xpath=../..').getByRole('button').last().click({ timeout: 2000 }).catch(() => {});
  await page.locator('input[type=file]').first().setInputFiles({ name: 'AC20-FZK-Haus.ifc', mimeType: 'application/octet-stream', buffer: readFileSync(AC20) });
  await page.waitForFunction(() => { const s = globalThis.__ifc_lite_viewer_store__?.getState(); return s && s.models.size > 0 && [...s.models.values()].every((m) => m.loadState === 'complete') && !s.loading; }, null, { timeout: 120000 });
  await page.waitForTimeout(1000);
  await page.locator('text=IFClite stores an action log').locator('xpath=ancestor::*[.//button][1]').getByRole('button').last().click({ timeout: 3000 }).catch(() => {});
  await page.keyboard.press('e');
  await page.waitForTimeout(800);
  if (!(await page.locator('[data-plan-view]').count())) await page.getByRole('button', { name: 'Show the plan' }).first().click();
  await page.waitForFunction(() => document.querySelectorAll('[data-plan-layer="cut"] path').length > 0, null, { timeout: 30000 });
  await page.keyboard.press('Shift+O');
  await page.waitForFunction(() => document.querySelectorAll('[data-plan-command="room.place"] [data-room-face]').length > 0, null, { timeout: 15000 });
  log.removedFileSpaces = await roomsOnly(page);
  await page.waitForTimeout(1200);
  const depth0 = (await state(page)).undo;
  const undoTo = async (depth) => { for (let i = 0; i < 20 && (await state(page)).undo > depth; i++) { await page.keyboard.press('Control+z'); await page.waitForTimeout(600); } };
  await page.getByRole('button', { name: /^Auto ·/ }).click(); await page.waitForTimeout(1500);
  log.auto = await state(page);

  // Edit mode.
  await page.getByRole('radio', { name: 'Edit' }).or(page.getByRole('button', { name: 'Edit', exact: true })).first().click();
  await page.waitForTimeout(800);
  log.edit = await state(page);
  await page.screenshot({ path: SHOT('1-edit-layout') });

  // 1. Drag a room corner: an interior layout corner, pressed, dragged 25 px, released (plan gesture).
  const corner = await page.evaluate(() => {
    const circles = [...document.querySelectorAll('[data-plan-command="room.place"] [data-room-edit] circle')].map((c) => c.getBoundingClientRect());
    const paths = [...document.querySelectorAll('[data-plan-command="room.place"] [data-room-linked]')].map((p) => p.getBoundingClientRect());
    // A corner on at least two linked rooms' boxes: shared by two rooms.
    const on = (c, r) => c.left + 3 >= r.left - 2 && c.left + 3 <= r.right + 2 && c.top + 3 >= r.top - 2 && c.top + 3 <= r.bottom + 2;
    const hit = circles.find((c) => paths.filter((r) => on(c, r)).length >= 2);
    return hit ? { x: hit.left + hit.width / 2, y: hit.top + hit.height / 2 } : null;
  });
  log.corner = corner;
  const before = await state(page);
  await page.mouse.move(corner.x, corner.y, { steps: 4 }); await page.waitForTimeout(300);
  await page.mouse.down(); await page.mouse.move(corner.x + 25, corner.y + 10, { steps: 8 }); await page.waitForTimeout(300);
  await page.screenshot({ path: SHOT('2a-drag-corner-live') });
  await page.mouse.up(); await page.waitForTimeout(1500);
  log.drag = await state(page);
  log.dragUndo = log.drag.undo - before.undo;
  log.dragChanged = log.drag.spaces.filter((s) => before.spaces.find((b) => b.id === s.id)?.area !== s.area).length;
  await page.screenshot({ path: SHOT('2-drag-corner') });

  // 2. Split the largest room: click its top edge, then its bottom edge.
  const big = (await boxes(page)).sort((a, b) => b.w * b.h - a.w * a.h)[0];
  const s0 = await state(page);
  const cx = big.x0 + big.w * 0.5;
  await page.mouse.move(cx, big.y0 + 1, { steps: 4 }); await page.waitForTimeout(250); await page.mouse.click(cx, big.y0 + 1); await page.waitForTimeout(300);
  await page.mouse.move(cx, big.y1 - 1, { steps: 8 }); await page.waitForTimeout(300);
  await page.screenshot({ path: SHOT('3a-cut-preview') });
  await page.mouse.click(cx, big.y1 - 1); await page.waitForTimeout(1500);
  log.split = await state(page);
  log.splitRooms = log.split.spaces.length - s0.spaces.length;
  log.splitUndo = log.split.undo - s0.undo;
  await page.screenshot({ path: SHOT('3-split') });

  // 3. Merge two rooms: Merge · Remove, click the wall between two side-by-side rooms.
  await page.getByRole('radio', { name: 'Merge · Remove' }).or(page.getByRole('button', { name: 'Merge · Remove' })).first().click(); await page.waitForTimeout(400);
  const bs = await boxes(page);
  let seam = null;
  for (const a of bs) for (const b of bs) {
    if (a === b || seam) continue;
    const ov0 = Math.max(a.y0, b.y0), ov1 = Math.min(a.y1, b.y1);
    if (Math.abs(a.x1 - b.x0) < 4 && ov1 - ov0 > 30) seam = { x: (a.x1 + b.x0) / 2, y: (ov0 + ov1) / 2 };
  }
  log.seam = seam;
  const m0 = await state(page);
  await page.mouse.move(seam.x, seam.y, { steps: 4 }); await page.waitForTimeout(400);
  await page.screenshot({ path: SHOT('4a-merge-hover') });
  await page.mouse.click(seam.x, seam.y); await page.waitForTimeout(1500);
  log.merge = await state(page);
  log.mergeRooms = log.merge.spaces.length - m0.spaces.length;
  log.mergeUndo = log.merge.undo - m0.undo;
  await page.screenshot({ path: SHOT('4-merge') });
  // Undo the merge restores both rooms.
  await page.keyboard.press('Control+z'); await page.waitForTimeout(1200);
  log.mergeUndone = (await state(page)).spaces.length - m0.spaces.length;

  // 4. Footprint: undo everything the tool made on this storey, then Footprint.
  await undoTo(depth0);
  await page.evaluate(() => { const s = globalThis.__ifc_lite_viewer_store__.getState(); s.setSelectedEntityId(null); });
  log.beforeFootprint = await state(page);
  await page.getByRole('radio', { name: 'Pick' }).or(page.getByRole('button', { name: 'Pick', exact: true })).first().click(); await page.waitForTimeout(300);
  await page.locator('[data-room-more]:visible').first().click(); await page.waitForTimeout(300);
  await page.getByRole('button', { name: 'Footprint' }).click(); await page.waitForTimeout(1500);
  log.footprint = await state(page);
  await page.keyboard.press('Escape').catch(() => {});
  await page.screenshot({ path: SHOT('5-footprint') });
  await page.keyboard.press('Control+z'); await page.waitForTimeout(1200);

  // 5. Auto on every storey.
  const a0 = await state(page);
  await page.locator('[data-room-more]:visible').first().click(); await page.waitForTimeout(300);
  await page.getByRole('button', { name: 'Auto on every storey' }).click(); await page.waitForTimeout(2000);
  log.autoAll = await state(page);
  log.autoAllUndo = log.autoAll.undo - a0.undo;
  log.autoAllStoreys = await page.evaluate(() => {
    const s = globalThis.__ifc_lite_viewer_store__.getState();
    const [modelId] = [...s.models.keys()];
    const view = s.mutationViews.get(modelId);
    const out = {};
    for (const e of view.getNewEntities()) if (e.type.toUpperCase() === 'IFCRELAGGREGATES') for (const k of e.attributes[5] ?? []) {
      const id = Number(String(k).slice(1)); const t = view.getNewEntity(id)?.type;
      if (t && t.toUpperCase() === 'IFCSPACE' && !view.isDeleted(id)) out[e.attributes[4]] = (out[e.attributes[4]] ?? 0) + 1;
    }
    return out;
  });
  await page.keyboard.press('Escape').catch(() => {});
  await page.screenshot({ path: SHOT('6-auto-all-storeys') });
  await page.keyboard.press('Control+z'); await page.waitForTimeout(1500);

  // 6. Leaks: remove one exterior wall (setup) so a region opens, turn on Show leaks.
  log.removedWall = await page.evaluate(() => {
    const s = globalThis.__ifc_lite_viewer_store__.getState();
    const [modelId] = [...s.models.keys()];
    const ext = (m) => { let lo = Infinity, hi = -Infinity, x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity; const o = m.origin ?? [0, 0, 0];
      for (let i = 0; i < m.positions.length; i += 3) { const x = o[0] + m.positions[i], y = o[1] + m.positions[i + 1], z = o[2] + m.positions[i + 2]; lo = Math.min(lo, y); hi = Math.max(hi, y); x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z); }
      return { lo, hi, len: Math.max(x1 - x0, z1 - z0), thin: Math.min(x1 - x0, z1 - z0) }; };
    // An interior partition of the ground floor: its removal opens the rooms either side into one region with a stub.
    const ws = s.models.get(modelId).geometryResult.meshes.filter((m) => m.ifcType === 'IfcWall' || m.ifcType === 'IfcWallStandardCase')
      .map((m) => ({ m, e: ext(m) })).filter(({ e }) => e.lo < 1 && e.hi > 1.5).sort((a, b) => b.e.thin - a.e.thin || b.e.len - a.e.len);
    const ref = s.resolveGlobalIdFromModels(ws[0].m.expressId);
    s.removeEntity(modelId, ref.expressId); return ref.expressId;
  });
  await page.waitForTimeout(1500);
  await page.locator('[data-room-more]:visible').first().click(); await page.waitForTimeout(300);
  await page.getByRole('button', { name: 'Show leaks' }).click(); await page.waitForTimeout(300);
  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(800);
  const house = await page.evaluate(() => { const r = document.querySelector('[data-plan-layer="cut"]').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
  await page.mouse.move(house.x, house.y, { steps: 5 }); await page.waitForTimeout(600);
  log.leaks = await state(page);
  log.leakHint = await page.evaluate(() => document.body.innerText.includes('No walls close this area'));
  await page.screenshot({ path: SHOT('7-leaks') });
  return log;
};
