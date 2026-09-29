// A4 room tool (#6232 M4) on AC20-FZK-Haus: E → Shift+O; candidates with areas in plan + 3D;
// Auto (N rooms) → one Ctrl+Z removes them all; click a room in the plan → one room.
import { readFileSync } from 'node:fs';
const AC20 = '/mnt/c/Users/louistrue/Documents/Dev/ifc-lite/tests/models/ara3d/AC20-FZK-Haus.ifc';
const SHOT = (n) => `./a4-room-${n}.png`;

const state = (page) => page.evaluate(() => {
  const s = globalThis.__ifc_lite_viewer_store__.getState();
  const [modelId] = [...s.models.keys()];
  const view = s.mutationViews.get(modelId);
  const spaces = view ? view.getNewEntities().filter((e) => e.type.toUpperCase() === 'IFCSPACE' && !view.isDeleted(e.expressId)) : [];
  return {
    cmd: s.session?.activeCommandId ?? null,
    layout: s.modelLayout,
    undo: [...s.undoStacks.values()].reduce((n, st) => n + st.length, 0),
    newSpaces: spaces.map((e) => ({ id: e.expressId, name: e.attributes[2], area: s.readSlabFootprint(modelId, e.expressId)?.footprint.length })),
    spacesVisible: s.typeVisibility.spaces,
    candidates: document.querySelectorAll('[data-plan-command="room.place"] [data-room-face]').length,
    candidates3d: document.querySelectorAll('svg [data-room-face]').length,
    taken: document.querySelectorAll('[data-plan-command="room.place"] [data-room-taken]').length,
    labels: [...document.querySelectorAll('[data-plan-command="room.place"] [data-room-face] text')].map((t) => t.textContent),
    hover: document.querySelector('[data-plan-command="room.place"] [data-room-hover]')?.getAttribute('data-room-face') ?? null,
    bar: document.querySelector('[data-command-id="room.place"]')?.textContent ?? null,
  };
});

/** Screen centre of a free (or taken) candidate's label in the plan. */
const faceLabel = (page, taken) => page.evaluate((wantTaken) => {
  const g = [...document.querySelectorAll('[data-plan-command="room.place"] [data-room-face]')]
    .find((el) => el.hasAttribute('data-room-taken') === wantTaken);
  const t = g?.querySelector('text');
  if (!t) return null;
  const r = t.getBoundingClientRect();
  return { face: g.getAttribute('data-room-face'), x: r.left + r.width / 2, y: r.top + r.height + 12 };
}, taken);

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
  await page.waitForTimeout(800);
  await page.keyboard.press('Shift+O');
  await page.waitForFunction(() => document.querySelectorAll('[data-plan-command="room.place"] [data-room-face]').length > 0, null, { timeout: 15000 });
  await page.waitForTimeout(500);
  log.started = await state(page);
  // AC20 already has a room in every face of this storey: all taken, Auto has nothing to do.
  const taken = await faceLabel(page, true);
  await page.mouse.move(taken.x, taken.y, { steps: 6 }); await page.waitForTimeout(600);
  log.takenHover = await state(page);
  await page.screenshot({ path: SHOT('0-all-taken') });
  // Setup: remove the file's own IfcSpaces so the storey has rooms to make.
  log.removed = await page.evaluate(() => {
    const s = globalThis.__ifc_lite_viewer_store__.getState();
    const [modelId] = [...s.models.keys()];
    const ids = new Set();
    for (const m of s.models.get(modelId).geometryResult.meshes) {
      if (m.ifcType !== 'IfcSpace') continue;
      const ref = s.resolveGlobalIdFromModels(m.expressId);
      if (ref) ids.add(ref.expressId);
    }
    for (const id of ids) s.removeEntity(modelId, id);
    return ids.size;
  });
  await page.waitForTimeout(1200);
  log.afterRemove = await state(page);

  // Hover a free candidate: it is emphasised in the plan and its ghost volume shows in 3D.
  const free = await faceLabel(page, false);
  await page.mouse.move(free.x, free.y, { steps: 6 }); await page.waitForTimeout(600);
  log.hover = await state(page);
  await page.screenshot({ path: SHOT('1-hover') });

  // Auto: every free face becomes a room, one undo step.
  const undo0 = log.hover.undo;
  await page.getByRole('button', { name: /^Auto/ }).click();
  await page.waitForTimeout(1500);
  log.auto = await state(page);
  log.autoUndoEntries = log.auto.undo - undo0;
  await page.mouse.move(free.x + 400, free.y - 300); await page.waitForTimeout(400);
  await page.screenshot({ path: SHOT('2-auto') });
  // The same rooms in 3D with only this storey shown (the roof out of the way).
  const solo = page.getByRole('button', { name: 'Show only this storey' }).last();
  if (await solo.count()) {
    await solo.click(); await page.waitForTimeout(1500);
    await page.screenshot({ path: SHOT('2b-auto-3d-storey') });
    await page.getByRole('button', { name: 'Show all storeys' }).last().click().catch(() => {});
    await page.waitForTimeout(800);
  }

  // One Ctrl+Z removes every room Auto made.
  await page.keyboard.press('Control+z'); await page.waitForTimeout(1200);
  log.undone = await state(page);
  await page.screenshot({ path: SHOT('3-undo') });

  // Click-a-room: one click inside a free face in the plan.
  const pick = await faceLabel(page, false);
  await page.mouse.move(pick.x, pick.y, { steps: 6 }); await page.waitForTimeout(400);
  await page.mouse.click(pick.x, pick.y); await page.waitForTimeout(1500);
  log.picked = await state(page);
  log.pickedFace = pick.face;
  await page.screenshot({ path: SHOT('4-click-room') });

  // Update rooms (D5): Auto the rest, draw a partition across the big room, then re-derive it.
  await page.getByRole('button', { name: /^Auto/ }).click(); await page.waitForTimeout(1500);
  const bigRoom = () => page.evaluate(() => {
    const s = globalThis.__ifc_lite_viewer_store__.getState();
    const [modelId] = [...s.models.keys()];
    const view = s.mutationViews.get(modelId);
    const area = (fp) => Math.abs(fp.reduce((a, p, i) => { const q = fp[(i + 1) % fp.length]; return a + p[0] * q[1] - q[0] * p[1]; }, 0) / 2);
    const rooms = view.getNewEntities().filter((e) => e.type.toUpperCase() === 'IFCSPACE' && !view.isDeleted(e.expressId))
      .map((e) => ({ id: e.expressId, name: e.attributes[2], area: +area(s.readSlabFootprint(modelId, e.expressId).footprint).toFixed(2) }));
    return rooms.sort((a, b) => b.area - a.area)[0];
  });
  log.bigBefore = await bigRoom();
  await page.keyboard.press('Escape'); await page.keyboard.press('Escape'); await page.waitForTimeout(300);
  const house = await page.evaluate(() => {
    const paths = [...document.querySelectorAll('[data-plan-layer="cut"] path')];
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of paths) { const r = p.getBoundingClientRect(); x0 = Math.min(x0, r.left); y0 = Math.min(y0, r.top); x1 = Math.max(x1, r.right); y1 = Math.max(y1, r.bottom); }
    return { x0, y0, x1, y1 };
  });
  const W = house.x1 - house.x0, H = house.y1 - house.y0;
  await page.mouse.move(house.x0 + W * 0.3, house.y0 + H * 0.8);
  await page.keyboard.press('w'); await page.waitForTimeout(400);
  const P0 = [house.x0 + W * 0.02, house.y0 + H * 0.8], P1 = [house.x0 + W * 0.98, house.y0 + H * 0.8];
  await page.mouse.move(...P0, { steps: 4 }); await page.waitForTimeout(200);
  await page.mouse.click(...P0); await page.waitForTimeout(250);
  await page.mouse.move(...P1, { steps: 10 }); await page.waitForTimeout(300);
  await page.mouse.click(...P1); await page.waitForTimeout(1500);
  await page.keyboard.press('Escape'); await page.keyboard.press('Escape'); await page.waitForTimeout(500);
  await page.keyboard.press('Shift+O'); await page.waitForTimeout(1500);
  // Setup: select the big room (the selection a user makes in the hierarchy or plan).
  await page.evaluate((id) => {
    const s = globalThis.__ifc_lite_viewer_store__.getState();
    const [modelId] = [...s.models.keys()];
    const gid = id + (s.models.get(modelId).idOffset ?? 0);
    s.setSelectedEntityIds([gid]); s.setSelectedEntityId(gid);
  }, log.bigBefore.id);
  await page.waitForTimeout(300);
  log.beforeUpdate = await state(page);
  await page.screenshot({ path: SHOT('5-wall-drawn') });
  const undo1 = log.beforeUpdate.undo;
  await page.getByRole('button', { name: 'Update rooms' }).click(); await page.waitForTimeout(1500);
  log.bigAfter = await bigRoom();
  log.updated = await state(page);
  log.updateUndoEntries = log.updated.undo - undo1;
  await page.screenshot({ path: SHOT('6-updated') });
  return log;
};
