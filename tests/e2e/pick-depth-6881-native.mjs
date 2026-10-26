/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Run with node --import <built-checkout>/node_modules/tsx/dist/loader.mjs,
// through ifc-fleet --kind service. Functional evidence only; no timing verdict.
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { boundEvaluations, tapDriverErrors, skipWhenFixturesMissing } from './pick-depth-6881-common.mjs';

const [root, output, receiptPath] = process.argv.slice(2);
if (!root || !output || !receiptPath) throw Error('Arguments: built checkout, new output directory, original build receipt');
const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
if (receipt.state !== 'completed' || receipt.exitCode !== 0 || !receipt.sourceUnchanged
  || receipt.cwd !== root) throw Error('Build receipt does not qualify this source');
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', timeout: 10000 }).trim();
const head = git('rev-parse', 'HEAD');
if (head !== receipt.sourceAfter.commit || git('status', '--porcelain')) throw Error('Source pin/cleanliness changed');
mkdirSync(output); // Never reuse an earlier attempt's evidence directory.
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const require = createRequire(`${root}/package.json`);
process.env.DEBUG = [process.env.DEBUG, 'pw:browser'].filter(Boolean).join(',');
const { chromium } = require('@playwright/test');
const { build } = createRequire(require.resolve('tsx'))('esbuild');
const { startStaticServer } = await import(`${root}/scripts/perf/browser-static-server.ts`);
const { closeBrowserWithTimeout } = await import(`${root}/scripts/perf/browser-cold-teardown.ts`);
const { probeMetadataRenderTrace, waitForMetadataRenderReadiness } = await import(`${root}/tests/benchmark/metadata-render-readiness.ts`);
const here = dirname(fileURLToPath(import.meta.url));
const { launchNativeChrome, readPhysicalSession, isPhysicalConsole } = await import(
  resolve(here, '../evidence/hidpi-navigation-6709/native-20261023/native-platform.mts'));
const observer = resolve(output, 'oracle.js');
const hover = resolve(output, 'hover.js');
const families = resolve(output, 'families.js');
const familyPagePath = resolve(output, 'families.html');
writeFileSync(familyPagePath, '<!doctype html><html><head><title>6881 raster invariants</title></head><body style="margin:0"><canvas id="witness" width="640" height="480" style="display:block;width:640px;height:480px"></canvas></body></html>');
const sourceInputs = {};
for (const [entry, outfile] of [['pick-depth-6881-observer.mjs', observer], ['pick-depth-6881-hover.mjs', hover], ['pick-depth-6881-families.mjs', families]]) {
  const result = await build({ entryPoints: [resolve(here, entry)], bundle: true, format: 'esm', outfile, metafile: true,
    alias: { '@ifc-lite/renderer': `${root}/packages/renderer/dist/index.js` },
    tsconfigRaw: { compilerOptions: { jsx: 'react-jsx' } }, nodePaths: [`${root}/apps/viewer/node_modules`, `${root}/node_modules`] });
  for (const name of Object.keys(result.metafile.inputs)) {
    const path = resolve(name), marker = Math.max(path.indexOf('/packages/'), path.indexOf('/apps/viewer/src/e2e/'));
    if (marker === -1) continue;
    const relative = path.slice(marker + 1), digest = hash(readFileSync(path));
    if (digest !== hash(readFileSync(`${root}/${relative}`))) throw Error(`Observer source differs from viewer source: ${relative}`);
    sourceInputs[relative] = digest;
  }
}
const fixtures = ['ara3d/AC20-FZK-Haus.ifc', 'buildingsmart/Building-Architecture.ifc'];
const manifest = JSON.parse(readFileSync(`${root}/tests/models/manifest.json`, 'utf8'));
const fixtureRoot = process.env.IFC_6881_FIXTURE_ROOT ?? `${root}/tests/models`;
await skipWhenFixturesMissing(output, fixtures.map(name => `${fixtureRoot}/${name}`));
const models = fixtures.map(name => {
  const expected = manifest.files.find(row => row.path === name);
  const path = `${fixtureRoot}/${name}`, bytes = readFileSync(path);
  if (hash(bytes) !== expected?.sha256) throw Error(`Public fixture identity mismatch: ${name}`);
  return { name, path, bytes: bytes.length, sha256: expected.sha256 };
});
const served = new Map();
const server = await startStaticServer({ port: 0, host: '127.0.0.1', root: () => `${root}/apps/viewer/dist`,
  extra: new Map([['/__6881/oracle.js', observer], ['/__6881/hover.js', hover], ['/__6881/families.js', families], ['/__6881/families.html', familyPagePath]]),
  onServe: (url, path) => served.set(url, { sha256: hash(readFileSync(path)), path }) });
const report = { head, buildReceipt: receipt.id, command: process.argv, fixturePins: models, sourceInputs,
  harness: Object.fromEntries(['pick-depth-6881-native.mjs', 'pick-depth-6881-observer.mjs', 'pick-depth-6881-hover.mjs', 'pick-depth-6881-families.mjs', 'pick-depth-6881-controls.mjs', 'pick-depth-6881-common.mjs'].map(name => [name, hash(readFileSync(resolve(here, name)))])),
  scope: 'Native same-render functional comparisons; no hover performance acceptance', runs: [], accepted: false };
let browser;
let activeRun;
let activePage;
const restoreStderr = tapDriverErrors(() => activeRun, 'gpuErrors');
try {
  const { runGeometryControls } = await import(resolve(here, 'pick-depth-6881-controls.mjs'));
  report.fingerprintControls = await runGeometryControls((await import(pathToFileURL(hover).href)).geometryWitness);
  report.session = readPhysicalSession();
  if (!isPhysicalConsole(report.session)) throw Error('Physical console admission refused');
  for (const dpr of [1, 2]) {
    const run = { dpr, errors: [], gpuErrors: [], cases: [] };
    activeRun = run;
    report.runs.push(run);
    browser = await launchNativeChrome(chromium);
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: dpr });
    const page = await context.newPage();
    activePage = page;
    boundEvaluations(page, 'Native page phase');
    page.setDefaultTimeout(30000);
    page.on('pageerror', error => run.errors.push(String(error)));
    const logs = []; run.console = logs; run.loads = [];
    page.on('console', message => logs.push(message.text()));
    await context.addInitScript(() => {
      globalThis.__6881Devices = [];
      const original = GPUAdapter.prototype.requestDevice;
      GPUAdapter.prototype.requestDevice = async function(...args) {
        const device = await original.apply(this, args), info = this.info;
        const record = { vendor: info.vendor, architecture: info.architecture, fallback: info.isFallbackAdapter, errors: [] };
        globalThis.__6881Devices.push(record);
        device.addEventListener('uncapturederror', event => record.errors.push(event.error.message));
        return device;
      };
    });
    await page.goto(`http://127.0.0.1:${server.address().port}/?perfTrace=1`, { timeout: 30000 });
    await page.getByRole('button', { name: 'Collapse sidebar to icons', exact: true }).click();
    const load = async (model, count) => {
      const attempt = { fixture: model.name, count };
      run.loads.push(attempt);
      await page.locator(count === 1 ? '#file-input-open' : '#file-input-add').setInputFiles(model.path);
      try {
      await waitForMetadataRenderReadiness({ trace: async () => {
        const probe = await probeMetadataRenderTrace(page); attempt.lastProbe = probe; return probe;
      }, logs: () => logs,
        canvasReady: async () => {
          attempt.publication = await page.evaluate(async count => (await import('/__6881/hover.js')).capturePublication(count), count);
          return attempt.publication.ready;
        },
        completionMode: count === 1 ? 'metadata-render' : 'load-root',
        now: () => performance.now(), pause: () => sleep(50), timeoutMs: 90000 });
      const trace = await probeMetadataRenderTrace(page);
      if (!trace.ended || trace.failed.length || !trace.done.includes('parser.complete') || !trace.done.includes('geometry.streamComplete')) throw Error('Authoritative load incomplete');
      return trace;
      } catch (error) {
        try {
          attempt.failure = await page.evaluate(() => {
            const state = globalThis.__ifc_lite_viewer_store__?.getState();
            const canvas = document.querySelector('canvas[data-viewport="main"]');
            return { trace: globalThis.__IFC_LITE_LOAD_TRACE__?.latest(),
              state: state && { loading: state.loading, streaming: state.geometryStreamingActive, error: state.error, progress: state.progress,
                models: [...state.models.values()].map(model => ({ id: model.id, loadState: model.loadState,
                  meshes: model.geometryResult?.meshes.length, triangles: model.geometryResult?.totalTriangles })) },
              canvas: canvas && { width: canvas.width, height: canvas.height }, stats: globalThis.__ifc_lite_render_stats__?.(),
              adapters: globalThis.__6881Devices, visibleText: document.body.innerText.slice(0, 12000) };
          });
          await page.screenshot({ path: `${output}/readiness-dpr${dpr}-models${count}.png`, timeout: 10000 });
        } catch (diagnosticError) { attempt.diagnosticError = String(diagnosticError); }
        throw error;
      }
    };
    run.primaryLoad = await load(models[0], 1);
    await page.bringToFront();
    run.adapters = await page.evaluate('globalThis.__6881Devices');
    if (!run.adapters.length || run.adapters.some(a => a.vendor !== 'nvidia' || a.fallback)) throw Error('Actual device request is not native NVIDIA');
    await page.evaluate(async () => (await import('/__6881/oracle.js')).installOracle());
    for (const count of [1, 2]) {
      if (count === 2) run.federatedLoad = await load(models[1], 2);
      await page.keyboard.press('Home');
      await sleep(1500);
      const geometryBefore = await page.evaluate(async () => (await import('/__6881/hover.js')).geometryWitness());
      const result = await page.evaluate(async count => {
        const api = globalThis.__6881, renderer = api.renderer, canvas = renderer.getCanvas();
        const rect = canvas.getBoundingClientRect(), state = globalThis.__ifc_lite_viewer_store__.getState();
        if (state.models.size !== count || state.loading || state.geometryStreamingActive) throw Error('Incomplete model publication');
        const before = api.samples.length;
        const points = [[0, 0], [rect.width - 1, rect.height - 1], [-5, -5], [rect.width + 5, rect.height + 5],
          ...[0.3, 0.5, 0.7].flatMap(y => [0.3, 0.5, 0.7].map(x => [rect.width * x, rect.height * y]))];
        api.label = 'serial-grid-and-borders';
        for (const [x, y] of points) await renderer.pick(x, y);
        api.label = 'overlapping-delivery';
        await Promise.all([renderer.pick(rect.width * 0.4, rect.height * 0.4), renderer.pick(rect.width * 0.6, rect.height * 0.6)]);
        const serialCount = points.length + 2;
        const modelIndices = [...new Set(renderer.getScene().getMeshes().map(mesh => mesh.modelIndex))];
        if (modelIndices.length !== count || modelIndices.some(index => !Number.isInteger(index))) throw Error('GPU model ownership census incomplete');
        const isolatedHits = [];
        for (const modelIndex of modelIndices) {
          const ids = new Set(renderer.getScene().getMeshes().filter(mesh => mesh.modelIndex === modelIndex).map(mesh => mesh.expressId));
          api.label = `isolated-model-${modelIndex}`;
          const hits = [];
          for (const [x, y] of points.slice(4)) {
            const hit = await renderer.pick(x, y, { isolatedIds: ids });
            if (hit) {
              // Instanced picks have no model/item channel in the existing
              // shader contract. Retain them in the raw oracle, but require
              // flat-mesh ownership witnesses for each federated model.
              if (hit.modelIndex !== undefined && hit.modelIndex !== modelIndex) throw Error('Isolation picked a different model');
              if (hit.modelIndex === modelIndex) hits.push(hit);
            }
          }
          if (!hits.length) throw Error('Predeclared isolated grid has no hit for a model');
          isolatedHits.push({ modelIndex, hits });
        }
        api.label = 'empty-isolation';
        await renderer.pick(rect.width / 2, rect.height / 2, { isolatedIds: new Set() });
        api.label = 'crop-excludes-model';
        if (await renderer.pickingManager.pick(rect.width / 2, rect.height / 2, undefined,
          { clipBox: { enabled: true, min: [1e9, 1e9, 1e9], max: [1e9 + 1, 1e9 + 1, 1e9 + 1] } })) throw Error('Excluded crop returned a hit');
        await api.drain();
        const samples = api.samples.slice(before);
        if (samples.length !== serialCount + modelIndices.length * 9 + 2 || !samples.some(s => s.actual)) throw Error('Insufficient actual GPU samples/hits');
        return { count, dpr: devicePixelRatio, rect: { width: rect.width, height: rect.height },
          models: [...state.models.values()].map(m => ({ id: m.id, idOffset: m.idOffset, loadState: m.loadState,
            meshes: m.geometryResult?.meshes.length, triangles: m.geometryResult?.totalTriangles })), isolatedHits, samples };
      }, count);
      result.geometryBefore = geometryBefore;
      result.geometryAfter = await page.evaluate(async () => (await import('/__6881/hover.js')).geometryWitness());
      if (JSON.stringify(result.geometryBefore) !== JSON.stringify(result.geometryAfter)) throw Error('Published geometry changed during picking');
      run.cases.push(result);
    }
    run.retirement = await page.evaluate('globalThis.__6881.retire()');
    run.faultControl = await page.evaluate(async () => {
      const { installOracle } = await import('/__6881/oracle.js');
      installOracle({ depthBitXor: 1 });
      const api = globalThis.__6881;
      let error;
      try { await api.renderer.pick(10, 10); } catch (failure) { error = String(failure); }
      const samples = api.samples.slice(), retired = await api.retire();
      if (!error?.includes('Same-render point pick mismatch') || samples.length !== 1 || samples[0].ok) throw Error('Corrupted-depth control did not reject');
      return { error, samples, retired };
    });
    await page.screenshot({ path: `${output}/federation-dpr${dpr}.png` });
    run.lifecycle = await page.evaluate(async includeLoss => (await import('/__6881/oracle.js')).runLifecycle({ includeLoss }), dpr === 2);
    run.adapters = await page.evaluate('globalThis.__6881Devices');
    if (run.errors.length || run.gpuErrors.length || run.adapters.some(a => a.errors.length)) throw Error('Page/GPU/driver errors observed');
    run.sessionAfter = readPhysicalSession();
    if (!isPhysicalConsole(run.sessionAfter)) throw Error('Physical session changed');
    const familyPage = await context.newPage();
    boundEvaluations(familyPage, 'Native page phase');
    familyPage.on('pageerror', error => run.errors.push(String(error)));
    await familyPage.goto(`http://127.0.0.1:${server.address().port}/__6881/families.html`);
    await familyPage.bringToFront();
    run.families = await familyPage.evaluate(async () => (await import('/__6881/families.js')).runFamilyControls());
    run.familyAdapters = await familyPage.evaluate('globalThis.__6881Devices');
    if (run.familyAdapters.some(a => a.vendor !== 'nvidia' || a.fallback || a.errors.length)
      || run.errors.length || run.gpuErrors.length) throw Error('Family witness page/GPU/driver health failed');
    await familyPage.close();
    const cleanupError = await closeBrowserWithTimeout(browser, 15000);
    if (cleanupError) throw Error(`Owned browser cleanup failed: ${cleanupError}`);
    browser = null;
    if (run.errors.length || run.gpuErrors.length) throw Error('Late page/GPU driver errors during native teardown');
    run.ok = true;
    activeRun = null;
  }
  report.accepted = true;
} catch (error) {
  report.error = String(error);
  if (activePage && !activePage.isClosed()) {
    try {
      activeRun.lastObservation = await activePage.evaluate(() => ({
        oracleSamples: globalThis.__6881?.samples,
        adapters: globalThis.__6881Devices,
        trace: globalThis.__IFC_LITE_LOAD_TRACE__?.latest(),
        stats: globalThis.__ifc_lite_render_stats__?.(),
      }));
      await activePage.screenshot({ path: `${output}/failure.png`, timeout: 10000 });
    } catch (diagnosticError) { report.diagnosticError = String(diagnosticError); }
  }
  process.exitCode = 1;
} finally {
  if (browser?.isConnected()) report.cleanupError = await closeBrowserWithTimeout(browser, 15000);
  restoreStderr();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  report.served = [...served.entries()];
  report.sourceAfter = { head: git('rev-parse', 'HEAD'), status: git('status', '--porcelain') };
  if (report.sourceAfter.head !== head || report.sourceAfter.status || report.cleanupError) report.accepted = false;
  writeFileSync(`${output}/result.json`, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ accepted: report.accepted, error: report.error, output }));
  if (!report.accepted) process.exitCode = 1;
}
