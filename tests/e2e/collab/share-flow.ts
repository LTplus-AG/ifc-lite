/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The share → join flow steps and the "complete room" assertion shared by the
 * relay acceptance's tests (#4446): open File → Share, join a link in a fresh
 * context, snapshot what the joiner holds, compare it with the owner.
 */

import { expect, type BrowserContext, type Page } from '@playwright/test';
import { openFileTab, openViewer, roomCounts, storeState, texturedMeshFingerprints, waitForStore, type MeshFingerprint, type RoomCounts } from './viewer-page';

export const IN_FLIGHT = /Connecting to the room…|Uploading model structure…|Uploading geometry|Confirming the upload/;
export const WAITING_TEXT = 'Link is ready once the upload finishes…';

/** Open File → Share and return the dialog's three gate surfaces. */
export async function openShare(page: Page) {
  await openFileTab(page);
  await page.getByRole('button', { name: 'Share' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  return { dialog, status: dialog.getByRole('status'), copy: dialog.getByRole('button', { name: /^(Copy|Copied)$/ }), link: dialog.locator('#share-link') };
}

/** Join `link` in a fresh context and wait for the room model to hydrate `expectedMeshes`. */
export async function joinAsGuest(browserContext: BrowserContext, link: string, expectedMeshes: number) {
  const page = await openViewer(browserContext, link);
  const roomId = new URL(link).searchParams.get('room')!;
  await waitForStore<string | null>(page, 'state.collabRoomId', (v) => v === roomId, 60_000, 'guest collabRoomId');
  const modelId = `room:${roomId}:m0`;
  try {
    await waitForStore<number>(
      page,
      `(() => { const m = state.models.get(${JSON.stringify(modelId)}); return m && m.loadState === 'complete' && m.geometryResult ? m.geometryResult.meshes.length : -1; })()`,
      (n) => n >= expectedMeshes,
      60_000,
      'guest hydrated meshes',
    );
  } catch (err) {
    const counts = await roomCounts(page).catch((e) => String(e));
    const marker = await storeState(page, "state.collabSession && state.collabSession.doc.getMap('meta').toJSON()").catch((e) => String(e));
    const transport = await storeState(page, "({ status: state.collabStatus, role: state.collabRole, provider: state.collabSession && state.collabSession.provider, models: Array.from(state.models.keys()) })").catch((e) => String(e));
    throw new Error(`${String(err)}
room: ${JSON.stringify(counts)}
meta: ${JSON.stringify(marker)}
transport: ${JSON.stringify(transport)}`);
  }
  return { page, roomId, modelId };
}

export async function guestSnapshot(page: Page, modelId: string) {
  const counts = await roomCounts(page);
  const model = await storeState<{ meshes: number; entities: number; idOffset: number; texturedExpressId: number | null }>(
    page,
    `(() => { const m = state.models.get(${JSON.stringify(modelId)}); const t = m.geometryResult.meshes.find((x) => x.texture); return { meshes: m.geometryResult.meshes.length, entities: m.ifcDataStore.entityCount, idOffset: m.idOffset, texturedExpressId: t ? t.expressId : null }; })()`,
  );
  const textured = await texturedMeshFingerprints(page, modelId);
  const notice = await storeState<string | null>(page, 'state.collabGeometryNotice');
  const seedPhase = await storeState<string>(page, 'state.collabSeedPhase');
  const transport = await storeState<{ status: string; provider: string | null }>(page, '({ status: state.collabStatus, provider: state.collabSession && state.collabSession.provider })');
  return { counts, model, textured, notice, seedPhase, transport };
}

export type GuestSnapshot = Awaited<ReturnType<typeof guestSnapshot>>;

export function expectComplete(label: string, snap: GuestSnapshot, owner: { counts: RoomCounts; textured: MeshFingerprint[]; textureFnv1a: string }) {
  expect(snap.counts, `${label}: room counts match the owner's`).toEqual(owner.counts);
  expect(snap.model.meshes, `${label}: one hydrated mesh per geometry reference`).toBe(owner.counts.geometryRefs);
  expect(snap.notice, `${label}: no missing-geometry notice`).toBeNull();
  expect(snap.seedPhase, `${label}: a recipient never seeds`).toBe('none');
  expect(snap.transport, `${label}: joined through the relay`).toEqual({ status: 'connected', provider: 'indexeddb+websocket' });
  expect(snap.textured, `${label}: exactly the owner's textured member, byte-identical texture, UVs and positions`).toEqual(owner.textured);
  expect(snap.textured[0].texture?.rgbaFnv1a, `${label}: the generated PNG's pixels`).toBe(owner.textureFnv1a);
}
