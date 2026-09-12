/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Browser acceptance for face masks on evaluated occurrences (#4404): the real
 * viewer build, the real wasm planner in its worker, the real WebGPU renderer.
 *
 * Journey on AC20-FZK-Haus IfcMember #35169 (one of 42 members sharing a type):
 * opt into evaluated conversion, select part of the member's faces in the
 * Appearance panel, preview the textured + retained split, Discard, preview
 * again, Apply, Undo, Redo, click the member in the viewport, export IFC +
 * images, and reopen the IFCZIP in a fresh page where the member renders as
 * two flat parts and still picks as one product. Sibling #35304 is compared
 * corner-for-corner at every step.
 *
 * Opt-in: `APPEARANCE_E2E=1 pnpm exec playwright test --project=viewer-appearance-e2e`
 * against a built viewer (`pnpm --filter @ifc-lite/viewer build`); the
 * Playwright webServer serves it. Needs a WebGPU-capable Chromium; the
 * project's flags target a real GPU. Skips without the fixture (`pnpm fixtures`).
 * Evidence files go to `APPEARANCE_E2E_OUT` (default: the Playwright output dir).
 */
import { test, expect, type Page } from '@playwright/test';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import type { ViewerState } from '../../apps/viewer/src/store';
import type { SceneOwnerSnapshot } from '../../apps/viewer/src/lib/viewport-debug-hooks';

declare global {
  var __ifc_lite_viewer_store__: { getState(): ViewerState };
  var __ifc_lite_scene_owner__: (globalId: number) => SceneOwnerSnapshot;
}

const FIXTURE = 'tests/models/ara3d/AC20-FZK-Haus.ifc';
const MEMBER = 35169, SIBLING = 35304, BODY_WRAPPER = 35155;
const OUT = process.env.APPEARANCE_E2E_OUT ?? join('test-results', 'appearance-face-mask');

test.describe('appearance face masks on AC20-FZK-Haus (#4404)', () => {
  test.skip(process.env.APPEARANCE_E2E !== '1', 'opt-in: set APPEARANCE_E2E=1 against a built viewer with a WebGPU-capable Chromium');
  test.skip(!existsSync(join(process.cwd(), FIXTURE)), `${FIXTURE} missing — run \`pnpm fixtures\``);

  test('select faces, preview split, discard, apply, undo, redo, pick, export and reopen', async ({ page, context }) => {
    test.setTimeout(600_000);
    mkdirSync(OUT, { recursive: true });
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(String(error)));
    const image = join(OUT, 'checker-64.png');
    writeFileSync(image, checkerPng(64));
    const journey: Record<string, unknown> = {};

    await page.goto('/');
    await page.locator('#file-input-open').setInputFiles(join(process.cwd(), FIXTURE));
    await waitForModel(page, 1);
    const ids = await page.evaluate(({ member, sibling }) => {
      const state = globalThis.__ifc_lite_viewer_store__.getState();
      const model = [...state.models.values()][0];
      const gid = state.toGlobalId(model.id, member);
      state.setSelectedEntityId(gid); state.setSelectedEntity({ modelId: model.id, expressId: member }); state.setSelectedEntityIds([gid]);
      return { modelId: model.id, member: gid, sibling: state.toGlobalId(model.id, sibling) };
    }, { member: MEMBER, sibling: SIBLING });
    await page.waitForFunction(() => typeof globalThis.__ifc_lite_scene_owner__ === 'function');
    const owner = (gid: number) => page.evaluate(id => globalThis.__ifc_lite_scene_owner__(id), gid);
    // The member and its sibling render either as resident flat parts or as GPU
    // instances depending on the loader's instancing decision; both are compared
    // corner-for-corner against this loaded state at every step.
    const siblingBefore = await owner(ids.sibling);
    const memberBefore = await owner(ids.member);
    expect(siblingBefore.corners.length).toBe(36 * 3);
    expect(memberBefore.corners.length).toBe(36 * 3);
    journey.loaded = { ids, member: memberBefore, sibling: siblingBefore };

    // Appearance panel: image, evaluated policy, whole-surface preview first.
    await page.getByRole('tab', { name: 'Author', exact: true }).click();
    await page.getByRole('button', { name: 'Appearance', exact: true }).click();
    const panel = page.getByLabel('Appearance workspace'); await panel.waitFor();
    await panel.getByLabel('Upload appearance source', { exact: true }).setInputFiles(image);
    await panel.getByRole('checkbox', { name: /Convert supported objects to mesh/ }).check();
    await expect(panel).toContainText('Preview ready', { timeout: 120_000 });
    const whole = await owner(ids.member);
    expect(whole.flat?.length, 'a whole-surface conversion previews as one textured part').toBe(1);
    expect(whole.flat?.[0].textured).toBe(true);
    await expect(panel).toContainText('all 12 faces');
    journey.wholePreview = whole.flat;

    // Face selection: marquee over the left half of the member's canvas, then
    // fall back to a single face click if the marquee caught everything or nothing.
    await panel.getByRole('button', { name: 'Select faces', exact: true }).click();
    const editor = panel.getByLabel(`Face selection for IFC object #${MEMBER}`);
    await editor.waitFor();
    await expect(editor, 'the face-selection canvas has its own renderer ready').toHaveAttribute('aria-busy', 'false', { timeout: 60_000 });
    await editor.getByRole('button', { name: 'Pick faces', exact: true }).click();
    const canvas = editor.locator('canvas');
    const box = (await canvas.boundingBox())!;
    await page.mouse.move(box.x + 2, box.y + 2); await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height - 2, { steps: 4 }); await page.mouse.up();
    let chip = await selectedFaces(panel);
    if (chip === null || chip === 12) {
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      chip = await selectedFaces(panel);
    }
    expect(chip, 'a partial face selection').toBeGreaterThan(0);
    expect(chip).toBeLessThan(12);
    // The selection re-plans after a short debounce; wait for the split to land, not for the old status text.
    await page.waitForFunction(id => globalThis.__ifc_lite_scene_owner__(id).flat?.length === 2, ids.member, { timeout: 120_000 });
    await expect(panel).toContainText('Preview ready', { timeout: 120_000 });
    const split = await owner(ids.member);
    expect(split.flat?.length, 'the masked preview stages the textured and the retained face set').toBe(2);
    expect(split.flat?.map(part => part.textured)).toEqual([true, false]);
    expect((split.flat?.[0].triangles ?? 0) + (split.flat?.[1].triangles ?? 0)).toBe(12);
    expect(split.flat?.[0].triangles).toBe(chip);
    expect([...split.corners].sort(), 'the split preserves every placed corner of the member').toEqual([...memberBefore.corners].sort());
    expect((await owner(ids.sibling)).corners).toEqual(siblingBefore.corners);
    await frameSelection(page, ids.member, false);
    await page.screenshot({ path: join(OUT, 'preview-split.png') });
    await clearIsolation(page);
    expect((await owner(ids.member)).flat?.length, 'isolation leaves the preview in place').toBe(2);
    journey.maskedPreview = { selectedFaces: chip, parts: split.flat };

    // Discard restores the instance; the selection survives for the next preview.
    await panel.getByRole('button', { name: 'Discard', exact: true }).click();
    await expect(panel).toContainText('Preview discarded');
    const discarded = await owner(ids.member);
    expect(discarded, 'Discard restores the loaded member exactly').toEqual({ ...memberBefore, screen: discarded.screen });
    await panel.getByLabel('Tile width (m)', { exact: true }).fill('2');
    await page.waitForFunction(id => globalThis.__ifc_lite_scene_owner__(id).flat?.length === 2, ids.member, { timeout: 120_000 });
    await expect(panel).toContainText('Preview ready', { timeout: 120_000 });
    await expect(panel).toContainText(`${chip} of 12 faces selected`);
    journey.discardAndRepreview = { discarded, repreviewed: (await owner(ids.member)).flat };

    // Apply: one history step, the wrapper is the only edited existing entity.
    await panel.getByRole('button', { name: 'Apply', exact: true }).click();
    await page.waitForFunction(modelId => (globalThis.__ifc_lite_viewer_store__.getState().undoStacks.get(modelId)?.length ?? 0) === 1, ids.modelId, { timeout: 120_000 });
    const applied = await owner(ids.member);
    expect(applied.flat?.length).toBe(2); expect(applied.instance).toBe(false);
    const edits = await page.evaluate(({ modelId, member }) => {
      const state = globalThis.__ifc_lite_viewer_store__.getState();
      const mutations = state.mutationViews.get(modelId)!.getMutations();
      const model = state.models.get(modelId)!;
      const meshes = model.geometryResult!.meshes.filter(mesh => mesh.expressId === member).map(mesh => ({ item: mesh.geometryItemId, triangles: mesh.indices.length / 3 }));
      const created = new Set(mutations.filter(m => m.type === 'CREATE_ENTITY').map(m => m.entityId));
      return { count: mutations.length, created: created.size, meshes, selected: state.selectedEntityId,
        editedExisting: [...new Set(mutations.filter(m => m.type === 'UPDATE_POSITIONAL_ATTRIBUTE' && !created.has(m.entityId)).map(m => m.entityId))] };
    }, { modelId: ids.modelId, member: ids.member });
    expect(edits.editedExisting, 'only the occurrence Body wrapper among existing entities changes').toEqual([BODY_WRAPPER]);
    expect(edits.meshes.length).toBe(2);
    expect(edits.selected).toBe(ids.member);
    expect((await owner(ids.sibling)).corners).toEqual(siblingBefore.corners);
    await frameSelection(page, ids.member);
    await page.screenshot({ path: join(OUT, 'applied.png') });
    // Orbit half a turn so the faces the mask left untextured face the camera too.
    const viewport = (await page.locator('canvas').first().boundingBox())!;
    await page.mouse.move(viewport.x + viewport.width / 2, viewport.y + viewport.height / 2); await page.mouse.down();
    await page.mouse.move(viewport.x + viewport.width / 2 + 260, viewport.y + viewport.height / 2 - 40, { steps: 12 }); await page.mouse.up();
    await page.waitForTimeout(800);
    await page.screenshot({ path: join(OUT, 'applied-orbited.png') });
    await clearIsolation(page);
    await page.evaluate(({ modelId, id, member }) => { const s = globalThis.__ifc_lite_viewer_store__.getState(); s.setSelectedEntityId(id); s.setSelectedEntity({ modelId, expressId: member }); s.setSelectedEntityIds([id]); }, { modelId: ids.modelId, id: ids.member, member: MEMBER });
    journey.applied = { parts: applied.flat, edits };

    // Undo restores the instance and the original Body; Redo splits again.
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await page.waitForFunction(id => globalThis.__ifc_lite_scene_owner__(id).flat?.length !== 2, ids.member);
    const undone = await owner(ids.member);
    expect(undone, 'Undo restores the loaded member exactly').toEqual({ ...memberBefore, screen: undone.screen });
    await page.getByRole('button', { name: 'Redo', exact: true }).click();
    await page.waitForFunction(id => globalThis.__ifc_lite_scene_owner__(id).flat?.length === 2, ids.member);
    const redone = await owner(ids.member);
    expect(redone.flat).toEqual(applied.flat);
    expect((await owner(ids.sibling)).corners).toEqual(siblingBefore.corners);
    journey.undoRedo = { undone: undone.flat ?? 'instance', redone: redone.flat };

    // Normal selection: clear, click the member in the viewport, it resolves to the product.
    await page.evaluate(() => { const s = globalThis.__ifc_lite_viewer_store__.getState(); s.setSelectedEntityId(null); s.setSelectedEntity(null); s.setSelectedEntityIds([]); });
    await page.evaluate(id => { const s = globalThis.__ifc_lite_viewer_store__.getState(); s.setIsolatedEntities(new Set([id])); }, ids.member);
    await page.waitForTimeout(500);
    const point = (await owner(ids.member)).screen;
    expect(point, 'the member projects onto the viewport').not.toBeNull();
    await page.mouse.click(point!.x, point!.y);
    await page.waitForFunction(id => globalThis.__ifc_lite_viewer_store__.getState().selectedEntityId === id, ids.member, { timeout: 10_000 });
    journey.pick = { point, selected: ids.member };
    await page.evaluate(() => globalThis.__ifc_lite_viewer_store__.getState().setIsolatedEntities(new Set()));

    // Export IFC + images through the normal dialog.
    await page.getByRole('tab', { name: 'File', exact: true }).click();
    await page.getByRole('button', { name: 'Export IFC (with changes)', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Export IFC File' }); await dialog.waitFor();
    const downloading = page.waitForEvent('download');
    await dialog.getByRole('button', { name: 'Export', exact: true }).click();
    const download = await downloading;
    expect(download.suggestedFilename()).toMatch(/\.ifczip$/);
    const exported = join(OUT, download.suggestedFilename());
    await download.saveAs(exported);
    journey.exported = download.suggestedFilename();

    // Reopen in a fresh page: two flat parts under the member, siblings instanced, click picks the product.
    const second = await context.newPage();
    const secondErrors: string[] = [];
    second.on('pageerror', error => secondErrors.push(String(error)));
    await second.goto('/');
    await second.locator('#file-input-open').setInputFiles(exported);
    await waitForModel(second, 1);
    await second.waitForFunction(() => typeof globalThis.__ifc_lite_scene_owner__ === 'function');
    const reopenedIds = await second.evaluate(({ member, sibling }) => {
      const state = globalThis.__ifc_lite_viewer_store__.getState();
      const model = [...state.models.values()][0];
      return { member: state.toGlobalId(model.id, member), sibling: state.toGlobalId(model.id, sibling), globalId: model.ifcDataStore!.entities.getGlobalId(member) };
    }, { member: MEMBER, sibling: SIBLING });
    const reopened = await second.evaluate(id => globalThis.__ifc_lite_scene_owner__(id), reopenedIds.member);
    expect(reopened.flat?.length, 'the reopened member renders as its textured and retained face sets').toBe(2);
    expect(reopened.flat?.map(part => part.textured).sort()).toEqual([false, true]);
    expect(reopened.flat!.reduce((sum, part) => sum + part.triangles, 0)).toBe(12);
    expect([...reopened.corners].sort()).toEqual([...memberBefore.corners].sort());
    const reopenedSibling = await second.evaluate(id => globalThis.__ifc_lite_scene_owner__(id), reopenedIds.sibling);
    expect(reopenedSibling.corners).toEqual(siblingBefore.corners);
    expect(reopenedSibling.flat?.map(part => part.geometryItemId) ?? 'instance').toEqual(siblingBefore.flat?.map(part => part.geometryItemId) ?? 'instance');
    await second.evaluate(id => globalThis.__ifc_lite_viewer_store__.getState().setIsolatedEntities(new Set([id])), reopenedIds.member);
    await second.waitForTimeout(500);
    const reopenedPoint = (await second.evaluate(id => globalThis.__ifc_lite_scene_owner__(id), reopenedIds.member)).screen;
    expect(reopenedPoint).not.toBeNull();
    await second.mouse.click(reopenedPoint!.x, reopenedPoint!.y);
    await second.waitForFunction(id => globalThis.__ifc_lite_viewer_store__.getState().selectedEntityId === id, reopenedIds.member, { timeout: 10_000 });
    await second.screenshot({ path: join(OUT, 'reopened-selected.png') });
    await frameSelection(second, reopenedIds.member);
    await second.screenshot({ path: join(OUT, 'reopened-member.png') });
    journey.reopened = { parts: reopened.flat, globalId: reopenedIds.globalId, sibling: reopenedSibling.flat ?? 'instance', picked: reopenedIds.member };
    await second.close();

    writeFileSync(join(OUT, 'journey.json'), JSON.stringify({ fixture: FIXTURE, member: MEMBER, sibling: SIBLING, ...journey, pageErrors: errors, reopenedPageErrors: secondErrors }, null, 2));
    expect(errors, 'no uncaught page errors').toEqual([]);
    expect(secondErrors).toEqual([]);
  });
});

/** Isolate and frame the current selection through the Elements ribbon for a
 * legible screenshot, then return to the Author tab. Isolation is visibility
 * only; the caller clears it afterwards. */
async function frameSelection(page: Page, globalId: number, deselect = true): Promise<void> {
  await page.getByRole('tab', { name: 'Elements', exact: true }).click();
  await page.getByRole('button', { name: 'Isolate selection (set basket)', exact: true }).click();
  // The basket isolate clears the selection; select the owner again to frame it.
  await page.evaluate(id => { const s = globalThis.__ifc_lite_viewer_store__.getState(); s.setSelectedEntityId(id); s.setSelectedEntityIds([id]); }, globalId);
  await page.getByRole('button', { name: 'Frame selection', exact: true }).click();
  await page.waitForTimeout(1200);
  // Drop the selection highlight so the screenshot shows the surface itself —
  // except while a selection-scoped preview is live, where the selection IS the scope.
  if (deselect) {
    await page.evaluate(() => { const s = globalThis.__ifc_lite_viewer_store__.getState(); s.setSelectedEntityId(null); s.setSelectedEntity(null); s.setSelectedEntityIds([]); });
    await page.waitForTimeout(300);
  }
  await page.getByRole('tab', { name: 'Author', exact: true }).click();
}
async function clearIsolation(page: Page): Promise<void> {
  await page.evaluate(() => globalThis.__ifc_lite_viewer_store__.getState().setIsolatedEntities(new Set()));
  await page.waitForTimeout(300);
}

async function waitForModel(page: Page, count: number): Promise<void> {
  await page.waitForFunction(n => {
    const state = globalThis.__ifc_lite_viewer_store__?.getState();
    return !!state && !state.loading && !state.geometryStreamingActive && state.models.size === n
      && [...state.models.values()].every(m => m.ifcDataStore && m.geometryResult && m.loadState === 'complete');
  }, count, { timeout: 180_000 });
}

async function selectedFaces(panel: ReturnType<Page['getByLabel']>): Promise<number | null> {
  const text = await panel.innerText();
  const match = text.match(/(\d+) of 12 faces selected/);
  return match ? Number(match[1]) : null;
}

/** A 2-colour checkerboard PNG (RGB, 8 bit) built with zlib only: no fixture, no network. */
function checkerPng(size: number): Buffer {
  const rows: number[] = [];
  for (let y = 0; y < size; y++) {
    rows.push(0);
    for (let x = 0; x < size; x++) {
      const light = ((x >> 3) + (y >> 3)) % 2 === 0;
      rows.push(light ? 214 : 52, light ? 178 : 96, light ? 92 : 160);
    }
  }
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0); header.writeUInt32BE(size, 4); header[8] = 8; header[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.from(rows))), chunk('IEND', Buffer.alloc(0))]);
}
function crc32(buffer: Buffer): number {
  let crc = -1;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xEDB88320 & -(crc & 1));
  }
  return (crc ^ -1) >>> 0;
}
