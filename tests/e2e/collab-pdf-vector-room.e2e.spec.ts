/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** #4604: direct PDF-vector creation through a signed relay and fresh browser. */
import { test, expect, type Browser, type BrowserContext, type Page, type TestInfo } from '@playwright/test';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ViewerState } from '../../apps/viewer/src/store';
import { relayBinary, startRelay, type Relay } from './collab/relay';
import { startViewerPreview, viewerDist, type ViewerPreview } from './collab/preview';
import { enableCollab, openFileTab, openViewer } from './collab/viewer-page';
import { waitForRoomModels } from './collab/federation-scope';

declare global {
  var __ifc_lite_viewer_store__: { getState(): ViewerState };
  var __pdfRoomObject: number;
}

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const TARGET = join(ROOT, 'tests/models/various/issue-604-door.ifc');
const PDF = join(ROOT, 'docs/architecture/evidence/pdf-fidelity-report/control-text-accepted.pdf');
const EVIDENCE_DIR = process.env.E2E_EVIDENCE_DIR;
const RENDERER_CHUNK = readdirSync(join(ROOT, 'apps/viewer/dist/assets')).find(name => /^useBCF-.*\.js$/.test(name));

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

async function fresh(browser: Browser, relay: Relay, url: string, collab = true): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ viewport: { width: 1600, height: 1200 }, acceptDownloads: true });
  if (collab) await enableCollab(context, relay.wsUrl);
  const page = await openViewer(context, url);
  page.setDefaultTimeout(60_000);
  await page.waitForFunction(() => Boolean(globalThis.__ifc_lite_viewer_store__));
  return { context, page };
}

async function loadTarget(page: Page): Promise<void> {
  await page.locator('#file-input-open').setInputFiles(TARGET);
  await page.waitForFunction(() => {
    const models = [...globalThis.__ifc_lite_viewer_store__.getState().models.values()];
    return models.length === 1 && models[0].loadState === 'complete' && (models[0].geometryResult?.meshes.length ?? 0) > 0;
  }, null, { timeout: 180_000 });
}

async function createPdfAnnotation(page: Page) {
  await page.getByRole('tab', { name: 'Author', exact: true }).click();
  await page.getByRole('button', { name: 'Appearance', exact: true }).click();
  await page.getByRole('button', { name: 'Place as reference', exact: true }).click();
  await page.getByLabel('Upload appearance source').setInputFiles(PDF);
  await page.waitForFunction(() => globalThis.__ifc_lite_viewer_store__.getState().appearanceSources.some(source => source.pdf));
  const landmarks = page.getByRole('button', { name: 'Choose calibration landmarks on page' });
  await landmarks.scrollIntoViewIfNeeded();
  const box = await landmarks.locator('img').boundingBox();
  if (!box) throw new Error('PDF calibration preview has no bounds');
  await page.getByRole('button', { name: 'Point A', exact: true }).click();
  await page.mouse.click(box.x + box.width * 0.1, box.y + box.height * 0.5);
  await page.getByRole('button', { name: 'Point B', exact: true }).click();
  await page.mouse.click(box.x + box.width * 0.9, box.y + box.height * 0.5);
  await page.getByLabel('Distance A–B (m)', { exact: true }).fill('2');
  await page.getByLabel('Projection plane').selectOption('xy');
  const place = page.getByRole('button', { name: 'Place reference', exact: true });
  await expect(place).toBeEnabled();
  await place.click();
  await page.waitForFunction(() => globalThis.__ifc_lite_viewer_store__.getState().appearanceReferences.size === 1);
  await page.getByText('Save into model', { exact: true }).click();
  await page.getByLabel('Annotation representation').selectOption('fills');
  await page.getByLabel('Annotation Name').fill('Shared PDF vector control');
  await page.getByRole('button', { name: 'Prepare vector preview', exact: true }).click();
  await page.getByLabel('Accept partial PDF conversion').check();
  await page.getByRole('button', { name: 'Prepare partial conversion', exact: true }).click();
  const create = page.getByRole('button', { name: 'Create annotation', exact: true });
  await expect(create).toBeEnabled({ timeout: 120_000 });
  await create.click();
  await page.getByText(/Partial PDF IfcAnnotation created and selected/).waitFor();
  return page.evaluate(() => {
    const state = globalThis.__ifc_lite_viewer_store__.getState();
    const globalId = state.selectedEntityId!;
    const ref = state.resolveGlobalIdFromModels(globalId)!;
    const model = state.models.get(ref.modelId)!;
    const authored = state.mutationViews.get(ref.modelId)?.getNewEntity(ref.expressId);
    const parts = model.geometryResult!.meshes.filter(part => part.expressId === globalId);
    globalThis.__pdfRoomObject = globalId;
    return {
      modelId: ref.modelId, expressId: ref.expressId, globalId,
      guid: authored?.attributes[0] as string,
      name: authored?.attributes[2] as string,
      parts: parts.length,
      colors: parts.map(part => part.color),
      triangles: parts.map(part => part.indices.length / 3),
    };
  });
}

async function shareAndClose(owner: { context: BrowserContext; page: Page }) {
  await openFileTab(owner.page);
  await owner.page.getByRole('button', { name: /^Share: link-based/ }).click();
  const dialog = owner.page.getByRole('dialog');
  await dialog.waitFor();
  const create = dialog.getByRole('button', { name: 'Create link' });
  if (await create.count()) await create.click();
  const field = dialog.locator('#share-link');
  await expect(field).toHaveValue(/[?&]room=[^&]+&t=/, { timeout: 300_000 });
  const url = await field.inputValue();
  const provenance = await owner.page.evaluate(() => {
    const doc = globalThis.__ifc_lite_viewer_store__.getState().collabSession!.doc;
    const slot = doc.getMap('models').get('m0') as { stepSourceBlobHash?: string };
    return { stepSourceBlobHash: slot.stepSourceBlobHash, geometryRecords: doc.getMap('geometry').size };
  });
  await owner.context.close();
  return { url, provenance };
}

async function observe(page: Page, guid: string) {
  return page.evaluate((targetGuid) => {
    const state = globalThis.__ifc_lite_viewer_store__.getState();
    const model = [...state.models.values()][0];
    for (const local of model.ifcDataStore!.entities.expressId) {
      const stored = model.ifcDataStore!.entities.getGlobalId(local);
      if (stored !== targetGuid && !stored?.endsWith(`/${targetGuid}`)) continue;
      const globalId = model.idOffset + local;
      globalThis.__pdfRoomObject = globalId;
      const parts = model.geometryResult!.meshes.filter(part => part.expressId === globalId);
      return {
        modelId: model.id, expressId: local, globalId, storedGuid: stored,
        type: model.ifcDataStore!.entities.getTypeName(local),
        name: model.ifcDataStore!.entities.getName(local),
        parts: parts.length, colors: parts.map(part => part.color), triangles: parts.map(part => part.indices.length / 3),
        resolved: state.resolveGlobalIdFromModels(globalId),
      };
    }
    throw new Error(`annotation ${targetGuid} not found`);
  }, guid);
}

async function pick(page: Page): Promise<{ selectedEntityId: number; candidatePoints: number }> {
  if (!RENDERER_CHUNK) throw new Error('built useBCF chunk is missing');
  const rendererUrl = new URL(`/assets/${RENDERER_CHUNK}`, page.url()).href;
  await page.evaluate(() => {
    const object = globalThis.__pdfRoomObject;
    const state = globalThis.__ifc_lite_viewer_store__.getState();
    state.setIsolatedEntities(new Set([object]));
    state.setSelectedEntityId(null);
    state.cameraCallbacks.frameEntities?.([object]);
  });
  // frameEntities animates for 300 ms, and the isolation render commits on a
  // later frame. Project only after both have reached their final state.
  await page.waitForTimeout(750);
  const points = await page.evaluate(async (moduleUrl) => {
    const module = await import(moduleUrl);
    const renderer = module.getGlobalRenderer?.() ?? module.r?.();
    if (!renderer) throw new Error('renderer unavailable');
    const object = globalThis.__pdfRoomObject;
    renderer.requestRender();
    const canvas = renderer.getCanvas();
    const rect = canvas.getBoundingClientRect();
    const points: Array<{ x: number; y: number }> = [];
    for (const part of renderer.getScene().getMeshDataPieces(object)) {
      for (let triangle = 0; triangle < part.indices.length; triangle += 3) {
        const vertex = [0, 0, 0];
        for (let corner = 0; corner < 3; corner++) for (let axis = 0; axis < 3; axis++)
          vertex[axis] += (part.positions[part.indices[triangle + corner] * 3 + axis] + (part.origin?.[axis] ?? 0)) / 3;
        const screen = renderer.getCamera().projectToScreen(
          { x: vertex[0], y: vertex[1], z: vertex[2] }, canvas.width, canvas.height,
        );
        if (screen) points.push({
          x: rect.x + screen.x * rect.width / canvas.width,
          y: rect.y + screen.y * rect.height / canvas.height,
        });
      }
    }
    return points;
  }, rendererUrl);
  for (const point of points) {
    await page.mouse.click(point.x, point.y);
    if (await page.evaluate(() => globalThis.__ifc_lite_viewer_store__.getState().selectedEntityId === globalThis.__pdfRoomObject)) break;
  }
  const expected = await page.evaluate(() => globalThis.__pdfRoomObject);
  await expect.poll(() => page.evaluate(() => globalThis.__ifc_lite_viewer_store__.getState().selectedEntityId)).toBe(expected);
  await page.evaluate(() => globalThis.__ifc_lite_viewer_store__.getState().setIsolatedEntities(null));
  return { selectedEntityId: expected, candidatePoints: points.length };
}

async function native2dPixels(page: Page): Promise<{ red: number; green: number }> {
  const showAll = page.getByRole('button', { name: 'Show all (reset filters)' });
  if (await showAll.count()) await showAll.click();
  await page.evaluate(() => {
    const state = globalThis.__ifc_lite_viewer_store__.getState();
    // Put the plan slab on the authored annotation and enable the ordinary
    // construction projection. Its door outlines supply the base drawing
    // that mounts the canvas on which native symbolic fills are overlaid.
    state.setSectionPlaneAxis('down');
    state.setSectionPlanePosition(0);
    state.updateDrawing2DDisplayOptions({ showConstructionProjection: true });
    state.setDrawing2DPanelVisible(true);
  });
  await page.getByText('2D Section', { exact: true }).waitFor();
  await page.waitForFunction(() => globalThis.__ifc_lite_viewer_store__.getState().drawing2DStatus === 'ready');
  await page.getByTitle('Fit to view').first().click();
  await page.waitForTimeout(1500);
  return page.locator('canvas[style*="crisp-edges"]').evaluate((canvas: HTMLCanvasElement) => {
    const context = canvas.getContext('2d');
    if (!context) throw new Error('2D section canvas has no 2D context');
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let red = 0, green = 0;
    for (let i = 0; i < pixels.length; i += 4) {
      if (pixels[i] > 180 && pixels[i + 1] < 80 && pixels[i + 2] < 80) red++;
      if (pixels[i + 1] > 180 && pixels[i] < 80 && pixels[i + 2] < 80) green++;
    }
    return { red, green };
  });
}

test.describe('PDF vectors in a fresh signed room (#4604)', () => {
  let relay: Relay;
  let viewer: ViewerPreview;
  test.beforeAll(async () => {
    test.skip(!existsSync(TARGET), 'issue-604-door.ifc missing — run pnpm fixtures');
    test.skip(!existsSync(PDF), 'controlled PDF missing');
    test.skip(!existsSync(relayBinary(ROOT)), 'collab-server not built');
    test.skip(!existsSync(viewerDist(ROOT)), 'viewer not built');
    relay = await startRelay(ROOT);
    viewer = await startViewerPreview(ROOT);
  });
  test.afterAll(async () => { await viewer?.stop(); await relay?.stop(); });

  test('owner creates, closes; fresh guest picks, draws 2D, exports and reopens', async ({ browser }, info) => {
    const owner = await fresh(browser, relay, `${viewer.url}/`);
    await loadTarget(owner.page);
    const created = await createPdfAnnotation(owner.page);
    expect(created.parts).toBe(2);
    expect(created.colors.sort()).toEqual([[0, 1, 0, 1], [1, 0, 0, 1]]);
    const shared = await shareAndClose(owner);
    expect(shared.provenance.stepSourceBlobHash).toMatch(/^[0-9a-f]{32}$/);

    const guest = await fresh(browser, relay, shared.url);
    await waitForRoomModels(guest.page, 1);
    const joined = await observe(guest.page, created.guid);
    expect(joined).toMatchObject({ type: 'IfcAnnotation', name: 'Shared PDF vector control', parts: 2 });
    expect(joined.colors.sort()).toEqual(created.colors);
    expect(joined.triangles).toEqual(created.triangles);
    expect(joined.resolved).toEqual({ modelId: joined.modelId, expressId: joined.expressId });
    const picked = await pick(guest.page);
    await shot(guest.page, info, 'fresh-guest-selected-3d.png');
    const native2d = await native2dPixels(guest.page);
    expect(native2d.red).toBeGreaterThan(0);
    await shot(guest.page, info, 'fresh-guest-native-2d.png');

    await openFileTab(guest.page);
    await guest.page.getByRole('button', { name: 'Export IFC (with changes)', exact: true }).click();
    const download = guest.page.waitForEvent('download');
    await guest.page.getByRole('dialog').getByRole('button', { name: 'Export', exact: true }).click();
    const received = await download;
    const exported = join(info.outputDir, received.suggestedFilename());
    await received.saveAs(exported);
    await guest.context.close();

    const reopenedContext = await browser.newContext({ viewport: { width: 1600, height: 1200 } });
    const reopenedPage = await openViewer(reopenedContext, `${viewer.url}/`);
    reopenedPage.setDefaultTimeout(60_000);
    await reopenedPage.locator('#file-input-open').setInputFiles(exported);
    await reopenedPage.waitForFunction(() => [...globalThis.__ifc_lite_viewer_store__.getState().models.values()].some(model => model.loadState === 'complete'));
    const reopened = await observe(reopenedPage, created.guid);
    expect(reopened).toMatchObject({ type: 'IfcAnnotation', name: 'Shared PDF vector control', parts: 2 });
    expect(reopened.colors.sort()).toEqual(created.colors);
    expect(reopened.triangles).toEqual(created.triangles);
    const reopened2d = await native2dPixels(reopenedPage);
    expect(reopened2d.red).toBeGreaterThan(0);
    await shot(reopenedPage, info, 'room-export-reopened-native-2d.png');
    await reopenedContext.close();

    save(info, 'browser-run.json', JSON.stringify({
      browser: `${browser.browserType().name()} ${browser.version()}`, fixture: 'tests/models/various/issue-604-door.ifc',
      pdf: 'control-text-accepted.pdf', created, room: shared.provenance, joined, native2d,
      pick: picked,
      export: { filename: received.suggestedFilename(), reopened, native2d: reopened2d },
    }, null, 2), 'application/json');
  });
});
