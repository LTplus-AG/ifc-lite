/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { test, expect, type Page, type TestInfo } from '@playwright/test';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { rendererColorFrame } from './federation-control-triplet.rendering';
import { watchGpuDeviceLoss } from './gpu-device-loss';
import type { RuleSetFile } from '@ifc-lite/rules';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const ARCHITECTURE = join(ROOT, 'apps/viewer/public/samples/building-architecture.ifc');
const REVISION = join(ROOT, 'apps/viewer/public/samples/building-architecture-rev-b.ifc');
const SNOWDON = join(ROOT, 'tests/models/various/01_Snowdon_Towers_Sample_Structural(1).ifc');
const SNOWDON_SHA256 = 'fab102eb5f9152bc7053d7e4920a8b75d0d34683c834078f0735c88308eb00a4';
const RULE_NAME = 'Name requirement 6490';
let viewerUrl: string;
let cacheDir: string | undefined;
let server: { listen(): Promise<void>; close(): Promise<void>; resolvedUrls: { local: string[] } | null } | undefined;

test.beforeAll(async () => {
  const require = createRequire(join(ROOT, 'apps/viewer/package.json'));
  const { createServer } = await import(pathToFileURL(require.resolve('vite')).href);
  cacheDir = await mkdtemp(join(tmpdir(), 'ifc-validation-colors-'));
  const created: NonNullable<typeof server> = await createServer({ root: join(ROOT, 'apps/viewer'), cacheDir, logLevel: 'error', server: { host: '127.0.0.1', port: 0 } });
  server = created;
  await created.listen();
  viewerUrl = created.resolvedUrls?.local[0] ?? '';
  if (!viewerUrl) throw new Error('Validation browser server did not expose its URL');
});
test.afterAll(async () => {
  try { await server?.close(); }
  finally { if (cacheDir) await rm(cacheDir, { recursive: true, force: true }); }
});

function ruleSet(instanced: boolean): RuleSetFile {
  return { version: 1, name: '6490 color restoration', rules: [{
    id: 'names-6490', name: RULE_NAME,
    applicability: { authoredAs: 'chips', groups: [{ combinator: 'AND', rules: [{
      kind: 'ifcType', op: 'in', values: instanced ? ['IfcColumn', 'IfcBeam', 'IfcWall'] : ['IfcWall'],
    }] }] },
    requirement: { kind: 'element', block: { authoredAs: 'chips', groups: [{ combinator: 'AND', rules: [{
      kind: 'name', op: instanced ? 'notContains' : 'contains', value: instanced ? 'W' : 'right',
    }] }] } },
  }] };
}

async function loadModels(page: Page, files: string[]): Promise<void> {
  await page.goto(viewerUrl);
  await page.evaluate(() => {
    // Revit's grid axes arrive asynchronously. Hold that independent overlay
    // constant so the before/after raster measures model-color restoration.
    const state = globalThis.__ifc_lite_viewer_store__.getState();
    if (state.typeVisibility.ifcGrid) state.toggleTypeVisibility('ifcGrid');
  });
  for (const file of files) {
    const name = basename(file);
    const loaded = page.waitForEvent('console', { predicate: message => message.text().includes(`[ifc-lite] Added model ${name}`), timeout: 120000 });
    await page.locator('#file-input-add').setInputFiles(file);
    await loaded;
  }
  await page.waitForFunction(() => !!globalThis.__ifc_lite_capture_color_frame__);
  expect(await page.evaluate(() => globalThis.__ifc_lite_viewer_store__.getState().typeVisibility.ifcGrid),
    'grid presentation remains off after loading every model').toBe(false);
  await page.evaluate(() => globalThis.__ifc_lite_viewer_store__.getState().cameraCallbacks.fitAll?.());
}

async function openRules(page: Page, instanced: boolean, bothHighlights = true): Promise<void> {
  await page.evaluate(({ file, both }) => {
    const state = globalThis.__ifc_lite_viewer_store__.getState();
    state.setValidationRuleSetDraft(file);
    state.setValidationRuleSetEditing(true);
    state.setIdsDisplayOptions({ highlightFailed: true, highlightPassed: both });
    state.showWorkspacePanel('validation');
    state.setSidebarActivePanel('validation');
  }, { file: ruleSet(instanced), both: bothHighlights });
  await expect(page.getByRole('button', { name: 'Run', exact: true })).toBeVisible();
}

async function frame(page: Page, info: TestInfo, name: string) {
  await page.waitForFunction(() => globalThis.__ifc_lite_viewer_store__.getState().pendingColorUpdates === null);
  await page.waitForTimeout(400); // camera fit and the submitted color-overlay frame settle
  const png = await rendererColorFrame(page);
  const pixels = await page.evaluate(async (base64) => {
    const image = await createImageBitmap(await (await fetch(`data:image/png;base64,${base64}`)).blob());
    const canvas = new OffscreenCanvas(image.width, image.height);
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Cannot decode renderer-owned color pixels');
    context.drawImage(image, 0, 0);
    const rgba = context.getImageData(0, 0, image.width, image.height).data;
    let red = 0, green = 0;
    for (let i = 0; i < rgba.length; i += 4) {
      if (rgba[i]! > 70 && rgba[i]! > rgba[i + 1]! * 1.7 && rgba[i]! > rgba[i + 2]! * 1.7) red++;
      if (rgba[i + 1]! > 70 && rgba[i + 1]! > rgba[i]! * 1.7 && rgba[i + 1]! > rgba[i + 2]! * 1.7) green++;
    }
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', rgba));
    const sha256 = [...digest].map(byte => byte.toString(16).padStart(2, '0')).join('');
    image.close();
    return { sha256, red, green, width: canvas.width, height: canvas.height,
      gridsVisible: globalThis.__ifc_lite_viewer_store__.getState().typeVisibility.ifcGrid };
  }, png.toString('base64'));
  await writeFile(info.outputPath(`${name}.png`), png);
  return pixels;
}

async function renderedResults(page: Page) {
  return page.evaluate(async ({ rendererModule, idModule }) => {
    const { getGlobalRenderer }: typeof import('../../apps/viewer/src/hooks/useBCF') = await import(rendererModule);
    const { toGlobalIdFromModels }: typeof import('../../apps/viewer/src/store/globalId') = await import(idModule);
    const renderer = getGlobalRenderer();
    if (!renderer) throw new Error('Viewport renderer is unavailable');
    const scene = renderer.getScene(), state = globalThis.__ifc_lite_viewer_store__.getState();
    const frame = renderer.getFrameStats();
    if (!frame) throw new Error('Viewport has not submitted a render frame');
    const report = state.idsValidationReport;
    if (!report) throw new Error('Actual information validation did not produce a report');
    const entities = report.specificationResults.flatMap(spec => spec.entityResults.map(entity => {
      const globalId = toGlobalIdFromModels(state.models, entity.modelId, entity.expressId);
      const ref = state.resolveGlobalIdFromModels(globalId);
      return { globalId, expressId: entity.expressId, modelId: entity.modelId, passed: entity.passed,
        instanced: scene.isInstancedEntity(globalId), resolvedModelId: ref?.modelId, resolvedExpressId: ref?.expressId };
    }));
    return { entities, models: state.models.size, summary: report.summary, frame,
      overrides: [...(scene.getColorOverrides() ?? [])] };
  }, { rendererModule: '/src/hooks/useBCF.ts', idModule: '/src/store/globalId.ts' });
}

for (const instanced of [false, true]) for (const federated of [false, true]) {
  test(`#6490 restores red and green ${instanced ? 'Revit instanced and ordinary' : 'SketchUp ordinary'} geometry with ${federated ? 'two models' : 'one model'}`, async ({ page }, info) => {
    test.skip(instanced && !existsSync(SNOWDON), 'Real Revit fixture absent; run pnpm fixtures');
    if (instanced) expect(createHash('sha256').update(await readFile(SNOWDON)).digest('hex')).toBe(SNOWDON_SHA256);
    const gpu = await watchGpuDeviceLoss(page);
    await gpu.requireLiveGpu('validation color restoration', async () => {
      await page.setViewportSize({ width: 1600, height: 1000 });
      await loadModels(page, instanced ? (federated ? [ARCHITECTURE, SNOWDON] : [SNOWDON]) : (federated ? [ARCHITECTURE, REVISION] : [ARCHITECTURE]));
      await openRules(page, instanced);
      const native = await frame(page, info, 'native');
      await page.getByRole('button', { name: 'Run', exact: true }).click();
      await expect(page.getByRole('button', { name: 'Restore original colors', exact: true })).toBeVisible();
      const painted = await frame(page, info, 'validation');
      const results = await renderedResults(page);
      expect(results.models).toBe(federated ? 2 : 1);
      expect(results.summary.totalEntitiesPassed).toBeGreaterThan(0);
      expect(results.summary.totalEntitiesFailed).toBeGreaterThan(0);
      expect(results.frame.drawCalls).toBeGreaterThan(0);
      expect(painted.sha256, 'actual submitted raster changed when validation painted').not.toBe(native.sha256);
      expect(painted.red, 'failed objects visibly paint red').toBeGreaterThan(native.red);
      expect(painted.green, 'passed objects visibly paint green').toBeGreaterThan(native.green);
      for (const entity of results.entities) {
        expect(entity.resolvedModelId).toBe(entity.modelId);
        expect(entity.resolvedExpressId).toBe(entity.expressId);
      }
      if (instanced) {
        expect(results.entities.filter(entity => entity.instanced && !entity.passed).length).toBeGreaterThan(0);
        expect(results.entities.filter(entity => !entity.instanced && !entity.passed).length).toBeGreaterThan(0);
        expect(results.frame.instancedDrawn).toBeGreaterThan(0);
        if (federated) expect(results.entities.filter(entity => entity.instanced && !entity.passed).every(entity => entity.globalId !== entity.expressId)).toBe(true);
      }
      await page.getByRole('button', { name: 'Restore original colors', exact: true }).click();
      await expect(page.getByRole('button', { name: 'Show validation colors', exact: true })).toBeVisible();
      const restored = await frame(page, info, 'restored');
      expect(restored.sha256, 'all actual GPU RGBA bytes return to the native frame').toBe(native.sha256);
      expect((await renderedResults(page)).overrides).toEqual([]);
      await writeFile(info.outputPath('color-restoration.json'), JSON.stringify({ native, painted, restored, results }, null, 2));
    });
  });
}

test('#6490 Per Spec colors restore failed objects and clearing isolation keeps them restored', async ({ page }, info) => {
  const gpu = await watchGpuDeviceLoss(page);
  await gpu.requireLiveGpu('Per Spec color restoration', async () => {
    await page.setViewportSize({ width: 1600, height: 1000 });
    await loadModels(page, [ARCHITECTURE]);
    await openRules(page, false, false); // genuine default: passed highlights off
    const native = await frame(page, info, 'native');
    await page.getByRole('button', { name: 'Run', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Restore original colors', exact: true })).toBeVisible();
    await page.getByRole('combobox', { name: 'Isolate scope' }).click();
    await page.getByRole('option', { name: 'Per Spec', exact: true }).click();
    await page.getByRole('button', { name: new RegExp(RULE_NAME) }).click();
    const painted = await frame(page, info, 'per-spec-validation');
    expect(painted.red).toBeGreaterThan(native.red);
    expect(painted.green).toBeGreaterThan(native.green);
    await page.getByRole('button', { name: 'Restore original colors', exact: true }).click();
    const isolatedRestored = await frame(page, info, 'per-spec-restored');
    expect(isolatedRestored.red).toBe(0);
    expect(isolatedRestored.green).toBe(0);
    await page.getByRole('button', { name: 'Clear isolation (show all)', exact: true }).click();
    const restored = await frame(page, info, 'restored');
    expect(restored.sha256).toBe(native.sha256);
    expect((await renderedResults(page)).overrides).toEqual([]);
    await writeFile(info.outputPath('per-spec-restoration.json'), JSON.stringify({ native, painted, isolatedRestored, restored }, null, 2));
  });
});
