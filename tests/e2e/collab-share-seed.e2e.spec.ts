/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Relay acceptance for #4446 — the invite must not appear before the initial
 * seed is in the room.
 *
 * Real browser contexts, this checkout's viewer build served by a private
 * `vite preview` (`collab/preview.ts`) and a disposable signed
 * `@ifc-lite/collab-server` (`collab/relay.ts`), both on ephemeral ports. The
 * owner loads the textured AC20-FZK-Haus IFCZIP (`collab/textured-ac20.ts`
 * builds it from the plain fixture), opens File → Share, and its context is
 * closed the instant the Copy action is enabled — no grace period. A fresh
 * guest must then reconstruct the complete room (every entity, every geometry
 * reference, the textured wall byte-identical), a third context must see the
 * same on rejoin, and the guest's ordinary IFC export must produce a download.
 *
 * Two controls show the gate is what makes the difference:
 *   - blob uploads slowed: the dialog withholds Copy while `role="status"`
 *     reports the upload, the Room panel labels Leave as abandoning it, and a
 *     room whose owner DOES leave mid-upload hands a joiner a model with no
 *     geometry — what a link minted on `collabStatus === 'connected'` used to do;
 *   - the owner's frames to the relay held back: every local write is done,
 *     yet Copy stays disabled in `confirming` until the relay's state vector
 *     covers the owner's — a gate keyed on the local doc would have handed
 *     out a link to a room the relay did not hold yet.
 *
 * Run: `pnpm turbo build --filter=@ifc-lite/viewer && pnpm --filter @ifc-lite/collab-server build
 *       && pnpm fixtures && pnpm test:e2e:collab` (see docs/contributing/collaboration-testing.md).
 * Skips, never fails, when the fixture, the wasm runtime, the viewer or the relay build is missing.
 */

import { test, expect } from '@playwright/test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildTexturedAc20, texturedAc20Inputs, type TexturedAc20 } from './collab/textured-ac20';
import { mintToken, relayBinary, startRelay, waitForRoomEmpty, type Relay } from './collab/relay';
import { startViewerPreview, viewerDist, type ViewerPreview } from './collab/preview';
import {
  collectCollabLog,
  enableCollab,
  loadModel,
  openFileTab,
  openViewer,
  roomCounts,
  seedPhaseTrace,
  shootCanvas,
  storeState,
  texturedMeshFingerprints,
  traceSeedPhases,
  waitForStore,
  type RoomCounts,
} from './collab/viewer-page';
import { IN_FLIGHT, WAITING_TEXT, expectComplete, guestSnapshot, joinAsGuest, openShare } from './collab/share-flow';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const OUT = join(ROOT, 'test-results/collab-share-seed');
test.describe.configure({ mode: 'serial' });

let relay: Relay;
let viewer: ViewerPreview;
let fixture: TexturedAc20;
/** Filled by the acceptance test, compared against by the control. */
let readyCounts: RoomCounts | null = null;
const evidence: Record<string, unknown> = { issue: 4446, startedAt: new Date().toISOString() };

test.beforeAll(async () => {
  const inputs = texturedAc20Inputs(ROOT);
  test.skip(!inputs.ok, 'AC20-FZK-Haus.ifc, the wasm runtime or packages/geometry/dist missing — run `pnpm fixtures` and `pnpm turbo build --filter=@ifc-lite/viewer`');
  test.skip(!existsSync(relayBinary(ROOT)), 'relay not built — run `pnpm --filter @ifc-lite/collab-server build`');
  test.skip(!existsSync(viewerDist(ROOT)), 'viewer not built — run `pnpm turbo build --filter=@ifc-lite/viewer`');
  mkdirSync(OUT, { recursive: true });
  fixture = await buildTexturedAc20(inputs.ac20, OUT);
  relay = await startRelay(ROOT);
  viewer = await startViewerPreview(ROOT);
  evidence.fixture = { ...fixture, ifczipPath: 'test-results/collab-share-seed/AC20-FZK-Haus.textured.ifczip' };
  evidence.relay = { wsUrl: relay.wsUrl, auth: 'room-token (random COLLAB_TOKEN_SECRET)', dataDir: 'temp, deleted on stop' };
  evidence.viewer = { url: viewer.url, dist: 'apps/viewer/dist (this checkout, private vite preview)' };
});

test.afterAll(async () => {
  evidence.relayLog = relay?.log ?? [];
  evidence.finishedAt = new Date().toISOString();
  if (relay) writeFileSync(join(OUT, 'result.json'), JSON.stringify(evidence, null, 2));
  await viewer?.stop();
  await relay?.stop();
});

test('owner leaves as soon as the invite appears → fresh guest, rejoin and export are complete', async ({ browser }) => {
  test.setTimeout(600_000);
  // ── Owner ──
  const ownerCtx = await browser.newContext();
  await enableCollab(ownerCtx, relay.wsUrl);
  const ownerLog: string[] = [];
  await collectCollabLog(ownerCtx, ownerLog);
  const owner = await openViewer(ownerCtx, viewer.url);
  const ownerModelId = await loadModel(owner, fixture.ifczipPath);
  const ownerTextured = await texturedMeshFingerprints(owner, ownerModelId);
  expect(ownerTextured, 'the IFCZIP loads with exactly one textured member').toHaveLength(1);
  expect(ownerTextured[0].texture?.rgbaFnv1a, 'the owner decoded the PNG pixel-exact').toBe(fixture.texture.rgbaFnv1a);
  expect(ownerTextured[0].triangles).toBe(fixture.wallTriangles);
  const ownerMeshes = await storeState<number>(owner, `state.models.get(${JSON.stringify(ownerModelId)}).geometryResult.meshes.length`);
  await traceSeedPhases(owner);

  const share = await openShare(owner);
  // The seed-ready gate: progress is visible and Copy is disabled BEFORE any link exists.
  await expect(share.status).toBeVisible({ timeout: 60_000 });
  const firstStatus = (await share.status.textContent()) ?? '';
  expect(firstStatus).toMatch(IN_FLIGHT);
  await expect(share.copy).toBeDisabled();
  expect(await share.link.inputValue()).toBe(WAITING_TEXT);
  await owner.screenshot({ path: join(OUT, 'owner-uploading.png') });

  const t0 = Date.now();
  await expect(share.copy).toBeEnabled({ timeout: 300_000 });
  const readyAfterMs = Date.now() - t0;
  const phases = await seedPhaseTrace(owner);
  expect(phases.map((p) => p.phase)).toEqual(['none', 'syncing', 'structure', 'geometry', 'confirming', 'ready']);
  const link = await share.link.inputValue();
  expect(link).toMatch(/\?room=[^&]+&t=.+/);
  expect(await storeState<string>(owner, 'state.collabSeedPhase')).toBe('ready');
  expect(await storeState<string | null>(owner, 'state.collabSeedFailure')).toBeNull();
  await expect(share.status).toBeHidden();
  // Over the relay, not local-only: the whole acceptance would be vacuous otherwise.
  const ownerTransport = await storeState<{ status: string; provider: string | null }>(owner, '({ status: state.collabStatus, provider: state.collabSession && state.collabSession.provider })');
  expect(ownerTransport).toEqual({ status: 'connected', provider: 'indexeddb+websocket' });
  const ownerCounts = await roomCounts(owner);
  expect(ownerCounts.modelSlots).toBe(1);
  expect(ownerCounts.entities).toBeGreaterThan(100);
  expect(ownerCounts.texturedRecords).toBe(1);
  expect(ownerCounts.geometryRefs).toBeGreaterThanOrEqual(ownerCounts.geometryRecords);
  readyCounts = ownerCounts;
  await owner.screenshot({ path: join(OUT, 'owner-link-ready.png') });
  // Navigate away the moment the completed share action is available.
  await ownerCtx.close();
  const ownerClosedAt = new Date().toISOString();
  evidence.owner = { modelId: ownerModelId, meshesLoaded: ownerMeshes, firstStatus, seedPhases: phases, copyEnabledAfterStatusMs: readyAfterMs, roomCounts: ownerCounts, textured: ownerTextured[0], link: link.replace(/t=.*/, 't=<redacted>'), contextClosedAt: ownerClosedAt, log: ownerLog };

  // ── Fresh guest ──
  const guestCtx = await browser.newContext({ acceptDownloads: true });
  await enableCollab(guestCtx, relay.wsUrl);
  const guestLog: string[] = [];
  await collectCollabLog(guestCtx, guestLog);
  const guest = await joinAsGuest(guestCtx, link, ownerCounts.geometryRefs);
  const guestSnap = await guestSnapshot(guest.page, guest.modelId);
  expectComplete('fresh guest', guestSnap, { counts: ownerCounts, textured: ownerTextured, textureFnv1a: fixture.texture.rgbaFnv1a });
  // Frame the textured member for the screenshot (the store selection / isolate / frame actions the UI uses; it is an interior wall).
  await guest.page.evaluate(
    ({ modelId, globalId }) => {
      const store = (globalThis as unknown as Record<string, { getState(): Record<string, unknown> } | undefined>).__ifc_lite_viewer_store__!;
      const s = store.getState() as { models: Map<string, { idOffset: number }>; setSelectedEntity(ref: { modelId: string; expressId: number }): void; isolateEntity(id: number): void; cameraCallbacks: { frameSelection?: () => void } };
      s.setSelectedEntity({ modelId, expressId: globalId - s.models.get(modelId)!.idOffset });
      s.isolateEntity(globalId);
      s.cameraCallbacks.frameSelection?.();
    },
    { modelId: guest.modelId, globalId: guestSnap.model.texturedExpressId! },
  );
  await shootCanvas(guest.page, join(OUT, 'guest-textured-member.png'));

  // Export through the ordinary dialog: a room model is IFC5 → one .ifcx download.
  await openFileTab(guest.page);
  await guest.page.getByRole('button', { name: 'Export IFC (with changes)' }).click();
  const exportDialog = guest.page.getByRole('dialog', { name: /Export IFC File/ });
  await expect(exportDialog).toBeVisible();
  const download = guest.page.waitForEvent('download', { timeout: 120_000 });
  await exportDialog.getByRole('button', { name: /^Export$/ }).click();
  const file = await download;
  const exportPath = join(OUT, file.suggestedFilename());
  await file.saveAs(exportPath);
  expect(file.suggestedFilename()).toMatch(/\.ifcx$/);
  const exported = JSON.parse(readFileSync(exportPath, 'utf8')) as { data?: unknown[] };
  expect(Array.isArray(exported.data) && exported.data.length > 0, 'export holds IFCX nodes').toBe(true);
  await expect(exportDialog.getByText(/Exported IFCX: \d+ nodes, \d+ meshes/)).toBeVisible({ timeout: 60_000 });
  const exportSummary = await exportDialog.getByText(/Exported IFCX: \d+ nodes, \d+ meshes/).first().textContent();
  evidence.guest = { ...guestSnap, export: { file: file.suggestedFilename(), nodes: exported.data!.length, summary: exportSummary }, log: guestLog };
  await guestCtx.close();

  // ── Rejoin: a third context, both earlier ones gone ──
  const rejoinCtx = await browser.newContext();
  await enableCollab(rejoinCtx, relay.wsUrl);
  const rejoinLog: string[] = [];
  await collectCollabLog(rejoinCtx, rejoinLog);
  const rejoin = await joinAsGuest(rejoinCtx, link, ownerCounts.geometryRefs);
  const rejoinSnap = await guestSnapshot(rejoin.page, rejoin.modelId);
  expectComplete('rejoin', rejoinSnap, { counts: ownerCounts, textured: ownerTextured, textureFnv1a: fixture.texture.rgbaFnv1a });
  expect(rejoinSnap.model.entities).toBe(guestSnap.model.entities);
  await shootCanvas(rejoin.page, join(OUT, 'rejoin.png'));
  evidence.rejoin = { ...rejoinSnap, log: rejoinLog };
  await rejoinCtx.close();
});

test('control: mid-upload the invite is withheld, Leave abandons, and an abandoned room is incomplete', async ({ browser }) => {
  test.setTimeout(600_000);
  expect(readyCounts, 'the acceptance test recorded the complete room').not.toBeNull();
  const ownerCtx = await browser.newContext();
  await enableCollab(ownerCtx, relay.wsUrl);
  const owner = await openViewer(ownerCtx, viewer.url);
  // Slow every blob PUT (16 in parallel) so the geometry phase lasts tens of seconds.
  await owner.route('**/blobs/**', async (route) => {
    if (route.request().method() === 'PUT') await new Promise((r) => setTimeout(r, 1500));
    await route.continue();
  });
  await loadModel(owner, fixture.ifczipPath);
  const share = await openShare(owner);
  await expect(share.status).toBeVisible({ timeout: 60_000 });
  // The pre-#4540 dialog handed out the link once `collabRoomId` was set and the socket connected. Snapshot that moment.
  const roomId = await waitForStore<string | null>(owner, 'state.collabRoomId', (v) => Boolean(v), 30_000, 'owner collabRoomId');
  await waitForStore<string>(owner, 'state.collabStatus', (v) => v === 'connected', 30_000, 'owner collabStatus');
  await waitForStore<string>(owner, 'state.collabSeedPhase', (v) => v === 'geometry', 120_000, 'geometry phase');
  // `collabSession` is only committed after the seed, so the room's own
  // progress counter is the in-flight measure: blobs uploaded of blobs offered.
  await waitForStore<{ uploaded: number } | null>(owner, 'state.collabSeedProgress', (p) => Boolean(p && p.uploaded > 0), 60_000, 'first blob uploaded');
  const linkMoment = await storeState<{ phase: string; status: string; progress: { uploaded: number; total: number } | null }>(
    owner,
    '({ phase: state.collabSeedPhase, status: state.collabStatus, progress: state.collabSeedProgress })',
  );
  await expect(share.copy).toBeDisabled();
  expect(await share.link.inputValue()).toBe(WAITING_TEXT);
  expect((await share.status.textContent()) ?? '').toMatch(/Uploading geometry \d+\/\d+…/);
  await owner.screenshot({ path: join(OUT, 'control-dialog-uploading.png') });
  expect(linkMoment.status).toBe('connected');
  expect(linkMoment.progress, 'a link at this moment would point at a room still missing geometry').not.toBeNull();
  expect(linkMoment.progress!.uploaded).toBeLessThan(linkMoment.progress!.total);

  // Room panel while uploading.
  await share.dialog.getByRole('button', { name: 'Close' }).click();
  await expect(share.dialog).toBeHidden();
  await owner.getByRole('group', { name: 'Share' }).getByRole('button', { name: 'Collaboration room' }).click();
  const panel = owner.locator('div[aria-label="Collaboration room"]');
  await expect(panel.getByText('Uploading model')).toBeVisible();
  await expect(panel.getByRole('status')).toHaveText(/Uploading geometry \d+\/\d+…/);
  const copyInvite = panel.getByRole('button', { name: 'Copy invite link' });
  await expect(copyInvite).toBeDisabled();
  await expect(copyInvite).toHaveAttribute('title', 'Available once the upload finishes');
  const leave = panel.getByRole('button', { name: 'Leave (abandons upload)' });
  await expect(leave).toBeVisible();
  await owner.screenshot({ path: join(OUT, 'control-room-panel-uploading.png') });
  const adminToken = await storeState<string | null>(owner, 'state.collabSelfToken');
  expect(adminToken).toBeTruthy();

  // Abandon the upload — what "navigating away" did before the gate.
  const leaveMoment = await storeState<{ phase: string; progress: { uploaded: number; total: number } | null }>(owner, '({ phase: state.collabSeedPhase, progress: state.collabSeedProgress })');
  expect(leaveMoment.phase).toBe('geometry');
  await leave.click();
  await waitForStore<string | null>(owner, 'state.collabRoomId', (v) => v === null, 30_000, 'owner left');
  await ownerCtx.close();

  // A joiner of the abandoned room: structure is there, geometry never landed
  // (records are written after the last blob), and no marker says so.
  await waitForRoomEmpty(relay, roomId!);
  const token = await mintToken(relay, roomId!, 'viewer', adminToken!);
  const guestCtx = await browser.newContext();
  await enableCollab(guestCtx, relay.wsUrl);
  const abandonedLog: string[] = [];
  await collectCollabLog(guestCtx, abandonedLog);
  const guest = await openViewer(guestCtx, `${viewer.url}/?room=${roomId}&t=${token}`);
  await waitForStore<string | null>(guest, 'state.collabRoomId', (v) => v === roomId, 60_000, 'guest collabRoomId');
  const modelId = `room:${roomId}:m0`;
  const hydrated = await waitForStore<number>(
    guest,
    `(() => { const m = state.models.get(${JSON.stringify(modelId)}); return m && m.loadState === 'complete' && m.geometryResult ? m.geometryResult.meshes.length : -1; })()`,
    (n) => n >= 0,
    120_000,
    'abandoned-room guest model',
  );
  await guest.waitForTimeout(3000); // nothing more can arrive: the owner is gone
  const abandoned = await guestSnapshot(guest, modelId);
  expect(abandoned.counts.entities, 'structure landed before the upload was abandoned').toBe(readyCounts!.entities);
  expect(abandoned.model.meshes, 'the abandoned room is missing geometry').toBeLessThan(readyCounts!.geometryRefs);
  expect(abandoned.counts.geometryRecords).toBeLessThan(readyCounts!.geometryRecords);
  await shootCanvas(guest, join(OUT, 'control-abandoned-guest.png'));
  evidence.control = { linkMoment, leaveMoment, abandonedGuest: { ...abandoned, hydratedAtFirstCheck: hydrated, log: abandonedLog }, readyCounts };
  await guestCtx.close();
});

test('control: a relay that receives the owner\'s frames late keeps the invite withheld until it holds the model', async ({ browser }) => {
  test.setTimeout(600_000);
  // Hold every frame the owner's LIVE socket sends to the relay for HOLD_MS.
  // The seed's local transactions still settle instantly, so a gate keyed
  // on the local doc would have enabled Copy while the relay held nothing —
  // exactly what a tab closed at that moment used to leave behind. Later
  // connections (the relay-confirmation probes) pass through untouched.
  const HOLD_MS = 2500;
  const ownerCtx = await browser.newContext();
  await enableCollab(ownerCtx, relay.wsUrl);
  let sockets = 0;
  let heldFrames = 0;
  // Installed on the context before its page exists: routing applies to sockets opened afterwards.
  await ownerCtx.routeWebSocket((url) => url.href.startsWith(`${relay.wsUrl}/`), (ws) => {
    const server = ws.connectToServer();
    const live = sockets++ === 0;
    ws.onMessage((message) => {
      if (!live) {
        server.send(message);
        return;
      }
      heldFrames++;
      setTimeout(() => server.send(message), HOLD_MS);
    });
    server.onMessage((message) => ws.send(message));
    ws.onClose((code, reason) => server.close({ code, reason }));
    server.onClose((code, reason) => ws.close({ code, reason }));
  });
  const owner = await openViewer(ownerCtx, viewer.url);
  await loadModel(owner, fixture.ifczipPath);
  await traceSeedPhases(owner);
  const share = await openShare(owner);
  await expect(share.status).toBeVisible({ timeout: 60_000 });
  // Local writes are done long before the relay has them: the dialog sits in "confirming".
  await waitForStore<string>(owner, 'state.collabSeedPhase', (v) => v === 'confirming', 120_000, 'confirming phase');
  await expect(share.status).toHaveText(/Confirming the upload with the room server/);
  await expect(share.copy).toBeDisabled();
  expect(await share.link.inputValue()).toBe(WAITING_TEXT);
  await owner.screenshot({ path: join(OUT, 'control-dialog-confirming.png') });
  await expect(share.copy).toBeEnabled({ timeout: 120_000 });
  const phases = await seedPhaseTrace(owner);
  const confirming = phases.find((p) => p.phase === 'confirming');
  expect(phases.map((p) => p.phase)).toEqual(['none', 'syncing', 'structure', 'geometry', 'confirming', 'ready']);
  expect(confirming?.ms ?? 0, 'ready waited for the held frames to reach the relay').toBeGreaterThanOrEqual(HOLD_MS * 0.6);
  expect(sockets, 'the live socket plus at least one confirmation probe').toBeGreaterThanOrEqual(2);
  const link = await share.link.inputValue();
  const ownerCounts = await roomCounts(owner);
  const ownerTextured = await texturedMeshFingerprints(owner, (await storeState<string[]>(owner, 'Array.from(state.models.keys())'))[0]);
  await ownerCtx.close();

  // The relay really holds it: a fresh guest is complete although the owner left the instant Copy enabled.
  const guestCtx = await browser.newContext();
  await enableCollab(guestCtx, relay.wsUrl);
  const guest = await joinAsGuest(guestCtx, link, ownerCounts.geometryRefs);
  const snap = await guestSnapshot(guest.page, guest.modelId);
  expectComplete('guest after delayed delivery', snap, { counts: ownerCounts, textured: ownerTextured, textureFnv1a: fixture.texture.rgbaFnv1a });
  evidence.controlDelayedRelay = { holdMs: HOLD_MS, heldFrames, sockets, seedPhases: phases, roomCounts: ownerCounts, guest: snap };
  await guestCtx.close();
});
