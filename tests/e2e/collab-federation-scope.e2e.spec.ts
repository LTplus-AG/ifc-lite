/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #4444 in real browsers: the issue's own reproduction, end to end.
 *
 * Owner profile: `AC20-FZK-Haus.ifc` loaded twice (Open, then Add Model), a
 * red image appearance applied to IfcMember `0oTQ6V1VbChulreA_hfmUa` in copy 1
 * and a blue one to the same member in copy 2 through the Appearance
 * workspace, File → Share with scope "All 2 loaded models", **Create link**,
 * the invite copied once the seed is ready, the owner closed. Fresh guest
 * profile: two room models (the second suffixed "(2)"), each hydrated with
 * its own copy's meshes and its own texture, the member picked by a real
 * canvas click in each copy resolving to that copy, no geometry notice, and
 * the Export dialog writing one `.ifcx` per room model whose node paths carry
 * the model's GlobalIds and never the room slot. A third profile rejoins and
 * sees the same. A second share with "Active model only" pins the
 * single-slot case: one guest model at offset 0 (`globalId === expressId`).
 *
 * Runs against a disposable signed relay and a private `vite preview` of this
 * checkout's build (`tests/e2e/collab/{relay,preview}.ts`, shared with the
 * #4446 relay acceptance); see `pnpm test:e2e:collab` in
 * `docs/contributing/collaboration-testing.md`. Skips, never fails, when the
 * fixture, the viewer build or the relay build is absent; needs real Google
 * Chrome (the project's `channel: 'chrome'`, for WebGPU) — that one it cannot
 * detect ahead of launch.
 */

import { test, expect, type Browser, type Page, type TestInfo } from '@playwright/test';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { relayBinary, startRelay, type Relay } from './collab/relay';
import { startViewerPreview, viewerDist, type ViewerPreview } from './collab/preview';
import { enableCollab, openFileTab, openViewer } from './collab/viewer-page';
import {
  exportRoomModel,
  loadFile,
  memberIn,
  paintMember,
  pickMember,
  roomStats,
  waitForRoomModels,
} from './collab/federation-scope';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const FIXTURE = join(ROOT, 'tests', 'models', 'ara3d', 'AC20-FZK-Haus.ifc');
/** IfcMember #35169 — the mapped member of the #4420 / #4404 evidence; the one member both copies paint. */
const MEMBER_GUID = '0oTQ6V1VbChulreA_hfmUa';
const RED: [number, number, number] = [255, 0, 0];
const BLUE: [number, number, number] = [0, 0, 255];
const SLOT_PATH_RE = /^\/m\d+\//;
/** Where a run's JSON and screenshots land when `E2E_EVIDENCE_DIR` names a directory (else only the report). */
const EVIDENCE_DIR = process.env.E2E_EVIDENCE_DIR;

function save(info: TestInfo, name: string, body: string | Buffer, contentType: string): void {
  void info.attach(name, { body, contentType });
  if (EVIDENCE_DIR) {
    mkdirSync(EVIDENCE_DIR, { recursive: true });
    writeFileSync(join(EVIDENCE_DIR, name), body);
  }
}

async function shot(page: Page, info: TestInfo, name: string): Promise<void> {
  save(info, name, await page.screenshot(), 'image/png');
}

/** A fresh profile on the relay, opened at `url`; waits for the viewer store. */
async function freshProfile(browser: Browser, relay: Relay, url: string) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    permissions: ['clipboard-read', 'clipboard-write'],
    acceptDownloads: true,
  });
  await enableCollab(context, relay.wsUrl);
  const page = await openViewer(context, url);
  await page.waitForFunction(() => Boolean(globalThis.__ifc_lite_viewer_store__), null, { timeout: 60_000 });
  return { context, page };
}

/** Owner: two copies, painted, shared with `scope`; returns the invite. Closes the owner. */
async function ownerShares(browser: Browser, relay: Relay, viewer: ViewerPreview, info: TestInfo, scope: 'all' | 'active', paint: boolean) {
  const { context, page } = await freshProfile(browser, relay, `${viewer.url}/`);
  await loadFile(page, FIXTURE, 1);
  await loadFile(page, FIXTURE, 2);
  const [a, b] = await page.evaluate(() => [...globalThis.__ifc_lite_viewer_store__.getState().models.values()].map((m) => m.id));
  const members = [await memberIn(page, a, MEMBER_GUID), await memberIn(page, b, MEMBER_GUID)];
  expect(members.map((m) => m.storedGlobalId)).toEqual([MEMBER_GUID, MEMBER_GUID]);
  expect(members[0].global).not.toBe(members[1].global);
  if (paint) {
    await page.keyboard.press('Control+k');
    await page.keyboard.type('Appearance');
    await page.keyboard.press('Enter');
    await page.getByLabel('Appearance workspace').waitFor();
    await paintMember(page, a, members[0].global, 'red.png', RED);
    await paintMember(page, b, members[1].global, 'blue.png', BLUE);
    const painted = [await memberIn(page, a, MEMBER_GUID), await memberIn(page, b, MEMBER_GUID)];
    expect(painted.map((m) => m.textureRef !== null)).toEqual([true, true]);
    expect(painted[0].textureRef).not.toBe(painted[1].textureRef);
    members.splice(0, 2, ...painted);
    await shot(page, info, 'owner-two-copies-painted.png');
  }
  // Slots follow share order — the active model first (`share-scope.ts`) — so
  // make copy 1 active again (painting copy 2 left it active): m0 is the red
  // copy, m1 the blue one, and "(2)" names the second copy on the guest.
  await page.evaluate((id) => globalThis.__ifc_lite_viewer_store__.getState().setActiveModel(id), a);
  await openFileTab(page);
  await page.getByRole('button', { name: /^Share: link-based/ }).click();
  const dialog = page.getByRole('dialog');
  const scopeGroup = dialog.getByRole('radiogroup', { name: 'Share scope' });
  await expect(scopeGroup.getByRole('radio', { name: 'All 2 loaded models' })).toHaveAttribute('aria-checked', 'true');
  if (scope === 'active') await scopeGroup.getByRole('radio', { name: 'Active model only' }).click();
  await dialog.getByRole('button', { name: 'Create link' }).click();
  // The seed-ready gate: the link field shows the upload until every slot landed.
  const link = dialog.locator('#share-link');
  await expect(link).toHaveValue(/[?&]room=[^&]+&t=/, { timeout: 300_000 });
  await expect(dialog.getByText(`This room carries ${scope === 'all' ? 2 : 1} model`)).toBeVisible();
  await dialog.getByRole('button', { name: 'Copy' }).click();
  await expect(dialog.getByRole('button', { name: 'Copied' })).toBeVisible();
  const url = await link.inputValue();
  const clipboard = await page.evaluate(() => navigator.clipboard.readText()).catch(() => null);
  if (clipboard !== null) expect(clipboard).toBe(url);
  await shot(page, info, `owner-share-${scope}.png`);
  const stats = await roomStats(page);
  await context.close();
  // The invite's signed token is for a relay that no longer exists; keep the room id only in the record.
  return { url, invite: url.replace(/&t=.*$/, '&t=<redacted>'), stats, members, clipboardRead: clipboard !== null };
}

/** What of the owner's run goes into the evidence record (everything but the live invite URL). */
function recordOf(owner: Awaited<ReturnType<typeof ownerShares>>) {
  return { invite: owner.invite, stats: owner.stats, members: owner.members, clipboardRead: owner.clipboardRead };
}

/** A guest profile opening `url`; returns the context, page and the room models in slot order. */
async function guestJoins(browser: Browser, relay: Relay, url: string, slots: number) {
  const { context, page } = await freshProfile(browser, relay, url);
  await waitForRoomModels(page, slots);
  const models = await page.evaluate(() => {
    const s = globalThis.__ifc_lite_viewer_store__.getState();
    return [...s.collabRoomModels.entries()].map(([id, slot]) => {
      const m = s.models.get(id)!;
      return { id, slot: slot.slotId, name: m.name, idOffset: m.idOffset, maxExpressId: m.maxExpressId, meshes: m.geometryResult!.meshes.length, schemaVersion: m.schemaVersion };
    });
  });
  return { context, page, models };
}

test.describe('federation scope: two copies of AC20-FZK-Haus.ifc in one room (#4444)', () => {
  let relay: Relay;
  let viewer: ViewerPreview;
  test.beforeAll(async () => {
    test.skip(!existsSync(FIXTURE), 'AC20-FZK-Haus.ifc missing — run pnpm fixtures');
    test.skip(!existsSync(relayBinary(ROOT)), 'collab-server not built — run pnpm turbo build --filter=@ifc-lite/collab-server');
    test.skip(!existsSync(viewerDist(ROOT)), 'viewer not built — run pnpm --filter @ifc-lite/viewer build');
    relay = await startRelay(ROOT);
    viewer = await startViewerPreview(ROOT);
  });
  test.afterAll(async () => {
    await viewer?.stop();
    await relay?.stop();
  });

  test('owner → fresh guest → rejoin: two models, two textures, real picks, slot-free exports', async ({ browser }, info) => {
    const owner = await ownerShares(browser, relay, viewer, info, 'all', true);
    expect(owner.stats.slots).toEqual(['m0', 'm1']);
    expect(owner.stats.entitiesPerSlot.m1).toBe(owner.stats.entitiesPerSlot.m0);
    expect(owner.stats.refsPerSlot.m1).toBe(owner.stats.refsPerSlot.m0);
    const evidence: Record<string, unknown> = { fixture: 'tests/models/ara3d/AC20-FZK-Haus.ifc', memberGuid: MEMBER_GUID, owner: recordOf(owner) };

    const checkGuest = async (label: string, page: Page, models: Awaited<ReturnType<typeof guestJoins>>['models']) => {
      const record: Record<string, unknown> = { models };
      // Two models, one per seeded slot, the second suffixed; disjoint id ranges.
      expect(models.map((m) => m.slot)).toEqual(['m0', 'm1']);
      expect(models.map((m) => m.name)).toEqual(['AC20-FZK-Haus.ifc', 'AC20-FZK-Haus.ifc (2)']);
      expect(models.length).toBe(owner.stats.slots.length);
      expect(models[1].idOffset).toBeGreaterThan(models[0].idOffset + models[0].maxExpressId);
      expect(models[0].meshes).toBe(owner.stats.refsPerSlot.m0);
      expect(models[1].meshes).toBe(owner.stats.refsPerSlot.m1);
      await expect(page.getByText('AC20-FZK-Haus.ifc (2)').first()).toBeVisible();
      // Each copy's member carries its own texture, and its own store key.
      const [ma, mb] = [await memberIn(page, models[0].id, MEMBER_GUID), await memberIn(page, models[1].id, MEMBER_GUID)];
      expect(ma.storedGlobalId).toBe(`/m0/${MEMBER_GUID}`);
      expect(mb.storedGlobalId).toBe(`/m1/${MEMBER_GUID}`);
      expect(ma.texturePixel).toEqual(RED);
      expect(mb.texturePixel).toEqual(BLUE);
      expect(ma.textureBlobHash).toBeTruthy();
      expect(mb.textureBlobHash).toBeTruthy();
      expect(ma.textureBlobHash).not.toBe(mb.textureBlobHash);
      record.members = [ma, mb];
      // A real click lands on the copy that is showing.
      const pickA = await pickMember(page, models[0].id, models[1].id, ma.global, () => shot(page, info, `${label}-copy-a-picked.png`));
      expect(pickA.lookup).toEqual({ modelId: models[0].id, expressId: ma.local });
      const pickB = await pickMember(page, models[1].id, models[0].id, mb.global, () => shot(page, info, `${label}-copy-b-picked.png`));
      expect(pickB.lookup).toEqual({ modelId: models[1].id, expressId: mb.local });
      record.picks = { a: pickA, b: pickB };
      const notice = await page.evaluate(() => globalThis.__ifc_lite_viewer_store__.getState().collabGeometryNotice);
      expect(notice).toBeNull();
      await expect(page.getByText(/shared model (has no 3D geometry|references 3D geometry)/)).toHaveCount(0);
      record.room = await roomStats(page);
      return record;
    };

    const guest = await guestJoins(browser, relay, owner.url, 2);
    evidence.guest = await checkGuest('guest', guest.page, guest.models);
    // Export each room model from the guest's Export dialog.
    const exports: Record<string, unknown>[] = [];
    for (const [i, model] of guest.models.entries()) {
      const { filename, file } = await exportRoomModel(guest.page, model.name);
      const entityPaths = file.data.map((n) => n.path).filter((p) => p.startsWith('/'));
      expect(entityPaths.length).toBeGreaterThan(0);
      expect(entityPaths.filter((p) => SLOT_PATH_RE.test(p))).toEqual([]);
      for (const n of file.data) for (const c of Object.values(n.children ?? {})) expect(c).not.toMatch(SLOT_PATH_RE);
      const member = file.data.find((n) => n.path === `/${MEMBER_GUID}`);
      expect(member, `${filename} carries the member at /${MEMBER_GUID}`).toBeDefined();
      const fragments = file.data.filter((n) => Object.values(member!.children ?? {}).includes(n.path));
      expect(fragments.some((n) => n.attributes?.['ifclite::appearance::v1'] !== undefined)).toBe(true);
      exports.push({ slot: model.slot, filename, nodes: file.data.length, entityPaths: entityPaths.length, memberPath: member!.path });
      if (i === 0) save(info, 'guest-export-m0-sample.json', JSON.stringify({ filename, member, fragments: fragments.length }, null, 2), 'application/json');
    }
    expect(exports[0].entityPaths as number).toBe(exports[1].entityPaths as number);
    // Two byte-different files must not download under one name: the "(2)"
    // copy suffix has to survive the extension strip (review of this PR).
    expect(exports[1].filename).not.toBe(exports[0].filename);
    evidence.exports = exports;
    await guest.context.close();

    const rejoin = await guestJoins(browser, relay, owner.url, 2);
    evidence.rejoin = await checkGuest('rejoin', rejoin.page, rejoin.models);
    await rejoin.context.close();
    save(info, 'browser-run.json', JSON.stringify(evidence, null, 2), 'application/json');
  });

  test('"Active model only" with two loaded copies shares one slot: the guest keeps globalId === expressId', async ({ browser }, info) => {
    const owner = await ownerShares(browser, relay, viewer, info, 'active', false);
    expect(owner.stats.slots).toEqual(['m0']);
    const guest = await guestJoins(browser, relay, owner.url, 1);
    expect(guest.models.map((m) => [m.slot, m.name, m.idOffset])).toEqual([['m0', 'AC20-FZK-Haus.ifc', 0]]);
    const member = await memberIn(guest.page, guest.models[0].id, MEMBER_GUID);
    expect(member.global).toBe(member.local);
    expect(member.storedGlobalId).toBe(`/m0/${MEMBER_GUID}`);
    expect(guest.models[0].meshes).toBe(owner.stats.refsPerSlot.m0);
    save(info, 'browser-run-active-only.json', JSON.stringify({ owner: recordOf(owner), guest: { models: guest.models, member } }, null, 2), 'application/json');
    await guest.context.close();
  });
});
