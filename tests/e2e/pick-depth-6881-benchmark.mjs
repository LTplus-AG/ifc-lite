/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// #6881 manual physical-console cohort. Invoke only under exclusive benchmark
// admission, after successful same-render functional controls. No sample replay.
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, readdirSync, lstatSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { sameSampleIdentity } from './pick-depth-6881-identity.mjs';
import { awaitQuietHost } from './pick-depth-6881-host.mjs';
import { boundEvaluations, tapDriverErrors, skipWhenFixturesMissing } from './pick-depth-6881-common.mjs';

const [configuration, output] = process.argv.slice(2);
if (!configuration || !output) throw Error('Arguments: frozen cohort configuration, new output directory');
const config = JSON.parse(readFileSync(configuration, 'utf8'));
if (!Array.isArray(config.scenarios) || !config.scenarios.length) throw Error('Frozen configuration declares no scenarios');
const hash = value => createHash('sha256').update(value).digest('hex');
const inventory = (directory, prefix = '') => readdirSync(directory).flatMap(name => {
  const path = `${directory}/${name}`, relative = `${prefix}${name}`, stat = lstatSync(path);
  if (stat.isSymbolicLink()) throw Error('Frozen distribution contains a symlink');
  return stat.isDirectory() ? inventory(path, `${relative}/`) : [relative];
});
if (!config.functional?.accepted || hash(readFileSync(config.functional.path)) !== config.functional.sha256
  || !JSON.parse(readFileSync(config.functional.path, 'utf8')).accepted) throw Error('Successful current-source functional qualification required');
const verify = () => {
  for (const arm of Object.values(config.arms)) {
    const git = (...args) => execFileSync('git', args, { cwd: arm.checkout, encoding: 'utf8', timeout: 10000 }).trim();
    if (git('rev-parse', 'HEAD') !== arm.head || git('status', '--porcelain')) throw Error('Source identity changed');
    if (arm.producerReceipt?.state !== 'completed' || arm.producerReceipt.exitCode !== 0 || !arm.producerReceipt.sourceUnchanged
      || arm.producerReceipt.sourceAfter.commit !== arm.head) throw Error('Successful original source build receipt absent');
    const paths = arm.files.map(file => file.path), required = ['ifc-lite_bg.wasm', 'ifc-lite.js', 'ifc-lite.d.ts'].map(name => `packages/wasm/pkg/${name}`);
    if (!paths.length || new Set(paths).size !== paths.length || !paths.includes('apps/viewer/dist/index.html')
      || required.some(path => !paths.includes(path)) || paths.some(path => path.startsWith('/') || path.split('/').includes('..'))) throw Error('Incomplete/invalid frozen file inventory');
    const observed = inventory(`${arm.buildRoot}/apps/viewer/dist`).map(path => `apps/viewer/dist/${path}`);
    if (JSON.stringify(observed.sort()) !== JSON.stringify(paths.filter(path => path.startsWith('apps/viewer/dist/')).sort())) throw Error('Distribution inventory differs from its frozen manifest');
    for (const file of arm.files) if (hash(readFileSync(`${arm.buildRoot}/${file.path}`)) !== file.sha256) throw Error('Frozen served artifact changed');
    if (arm.files.find(file => file.path === required[0]).sha256 !== arm.wasmSha256) throw Error('Engine identity field does not match its actual bytes');
  }
};
verify();
if (config.arms.base.wasmSha256 !== config.arms.branch.wasmSha256) throw Error('A/B must use identical engine bytes');
const root = config.arms.branch.checkout;
const require = createRequire(`${root}/package.json`);
process.env.DEBUG = [process.env.DEBUG, 'pw:browser'].filter(Boolean).join(',');
const { chromium } = require('@playwright/test');
const { build } = createRequire(require.resolve('tsx'))('esbuild');
const { startStaticServer } = await import(`${root}/scripts/perf/browser-static-server.ts`);
const { closeBrowserWithTimeout } = await import(`${root}/scripts/perf/browser-cold-teardown.ts`);
const { probeMetadataRenderTrace, waitForMetadataRenderReadiness } = await import(`${root}/tests/benchmark/metadata-render-readiness.ts`);
const { interleavedSchedule, summarizeSamples } = await import(`${root}/scripts/perf/frame-gpu-summary.ts`);
const here = dirname(fileURLToPath(import.meta.url));
const { launchNativeChrome, readPhysicalSession, isPhysicalConsole, readHostAdmission } = await import(
  resolve(here, '../evidence/hidpi-navigation-6709/native-20261023/native-platform.mts'));
mkdirSync(output);
await skipWhenFixturesMissing(output, config.scenarios.flatMap(scenario => scenario.fixtures.map(fixture => fixture.path)));
const tap = `${output}/hover.js`;
await build({ entryPoints: [resolve(here, 'pick-depth-6881-hover.mjs')], bundle: true, format: 'esm', outfile: tap });
let current = config.arms.base.buildRoot;
const server = await startStaticServer({ port: 0, host: '127.0.0.1', root: () => `${current}/apps/viewer/dist`,
  extra: new Map([['/__6881/hover.js', tap]]) });
const origin = `http://127.0.0.1:${server.address().port}`;
const records = [], references = new Map();
const report = { configSha256: hash(readFileSync(configuration)), scope: 'Mounted viewer hover, 5 interleaved pairs per public-model scenario at DPR1; no loading-speed claim',
  harness: Object.fromEntries(['pick-depth-6881-benchmark.mjs', 'pick-depth-6881-hover.mjs', 'pick-depth-6881-observer.mjs', 'pick-depth-6881-identity.mjs', 'pick-depth-6881-host.mjs', 'pick-depth-6881-common.mjs'].map(name => [name, hash(readFileSync(resolve(here, name)))])),
  accepted: false, probe: config.probe === true, records, summary: [] };
const median = values => {
  const sorted = values.slice().sort((a, b) => a - b), middle = sorted.length >> 1;
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
// A scenario may declare its own pointer positions as fractions of the canvas;
// the default is the 3 x 3 grid. A probe run records every sample and gates only
// per-sample integrity, so the stability of candidate positions can be measured
// before a cohort freezes them. It is never an accepted cohort.
const probe = config.probe === true;
const validPositions = positions => Array.isArray(positions) && positions.length > 0 && positions.every(position => Array.isArray(position)
  && position.length === 2 && position.every(value => Number.isFinite(value) && value > 0 && value < 1))
  && new Set(positions.map(position => position.join(','))).size === positions.length;
for (const scenario of config.scenarios) if (scenario.positions !== undefined && !validPositions(scenario.positions)) throw Error(`Invalid hover positions for ${scenario.name}`);
const defaultPositions = [0.3, 0.5, 0.7].flatMap(y => [0.3, 0.5, 0.7].map(x => [x, y]));
const p95 = values => {
  if (!values.length) throw Error('p95 of an empty sample');
  return values.slice().sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1];
};
let browser, active;
const restoreStderr = tapDriverErrors(() => active, 'driverErrors');
try {
  const deadline = Date.now() + 25 * 60 * 1000;
  for (const scenario of config.scenarios) for (const sample of interleavedSchedule(5, true)) {
    if (Date.now() > deadline) throw Error('Cohort exceeded its fixed deadline');
    const record = { scenario: scenario.name, ...sample, ok: false, rows: [], errors: [], driverErrors: [] };
    active = record; records.push(record);
    try {
      record.hostBefore = await awaitQuietHost(readHostAdmission); record.sessionBefore = readPhysicalSession();
      if (!record.hostBefore.quiet || !isPhysicalConsole(record.sessionBefore)) throw Error('Idle/physical host admission refused');
      current = config.arms[sample.side].buildRoot;
      browser = await launchNativeChrome(chromium);
      const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
      const page = await context.newPage(); page.setDefaultTimeout(30000);
      boundEvaluations(page, 'Hover page phase');
      page.on('pageerror', error => record.errors.push(String(error)));
      const logs = []; page.on('console', message => logs.push(message.text()));
      await context.addInitScript(() => {
        globalThis.__6881Health = { adapters: [], interruptions: 0, errors: [] };
        const original = GPUAdapter.prototype.requestDevice;
        GPUAdapter.prototype.requestDevice = async function(...args) {
          globalThis.__6881Health.adapters.push({ vendor: this.info.vendor, fallback: this.info.isFallbackAdapter });
          const device = await original.apply(this, args);
          device.addEventListener('uncapturederror', event => globalThis.__6881Health.errors.push(event.error.message));
          device.lost.then(info => globalThis.__6881Health.errors.push(`Device lost: ${info.reason}`));
          return device;
        };
        for (const name of ['blur', 'visibilitychange']) addEventListener(name, () => {
          if (globalThis.__6881Health.measuring && (document.visibilityState !== 'visible' || !document.hasFocus())) globalThis.__6881Health.interruptions++;
        });
      });
      await page.goto(`${origin}/?perfTrace=1`, { timeout: 30000 });
      await page.getByRole('button', { name: 'Collapse sidebar to icons', exact: true }).click();
      record.loads = [];
      for (let index = 0; index < scenario.fixtures.length; index++) {
        const fixture = scenario.fixtures[index];
        if (hash(readFileSync(fixture.path)) !== fixture.sha256) throw Error('Fixture bytes changed');
        await page.locator(index ? '#file-input-add' : '#file-input-open').setInputFiles(fixture.path);
        await waitForMetadataRenderReadiness({ trace: () => probeMetadataRenderTrace(page), logs: () => logs,
          completionMode: index ? 'load-root' : 'metadata-render',
          canvasReady: async () => (await page.evaluate(async count => (await import('/__6881/hover.js')).capturePublication(count), index + 1)).ready,
          now: () => performance.now(), pause: () => sleep(50), timeoutMs: 90000 });
        const completion = await probeMetadataRenderTrace(page);
        if (!completion?.ended || completion.failed.length || !completion.done.includes('parser.complete') || !completion.done.includes('geometry.streamComplete')) throw Error('Authoritative metadata/geometry completion missing');
        const trace = await page.evaluate('globalThis.__IFC_LITE_LOAD_TRACE__.latest()');
        // cacheTier describes the write policy, not a hit/miss enum. Each
        // sample owns a fresh browser/profile, and the loader must use WASM.
        if (trace.attrs.loadPath !== 'wasm' || !['none', 'source', 'mesh-only'].includes(trace.attrs.cacheTier)
          || trace.end === null) throw Error('Fresh-profile WASM load certificate absent');
        record.loads.push({ attrs: trace.attrs, start: trace.start, end: trace.end });
      }
      await page.bringToFront(); await page.keyboard.press('Home'); await sleep(1500);
      await page.mouse.move(0, 0);
      record.geometryBefore = await page.evaluate(async () => (await import('/__6881/hover.js')).geometryWitness());
      await page.evaluate(async () => {
        globalThis.__ifc_lite_viewer_store__.setState({ hoverTooltipsEnabled: true });
        (await import('/__6881/hover.js')).installHoverTap();
      });
      await sleep(300);
      const rect = await page.locator('canvas[data-viewport="main"]').boundingBox();
      if (!rect || rect.width <= 0 || rect.height <= 0) throw Error('Canvas dimensions absent');
      record.viewport = rect;
      await page.evaluate(() => {
        if (document.visibilityState !== 'visible' || !document.hasFocus()) throw Error('Foreground missing');
        globalThis.__6881Health.measuring = true;
      });
      const positions = scenario.positions ?? defaultPositions;
      for (const [x, y] of positions) {
        await page.mouse.move(rect.x + rect.width * x, rect.y + rect.height * y); await sleep(300);
      }
      record.hover = await page.evaluate('globalThis.__6881Hover.take()');
      if (record.hover.inputs.length !== positions.length || record.hover.picks.length !== positions.length) throw Error('Declared hover inputs did not each reach the actual GPU picker');
      const commits = [];
      for (let index = 0; index < positions.length; index++) {
        const pick = record.hover.picks[index], input = record.hover.inputs[index];
        if (pick.input !== index || pick.error || !Number.isFinite(pick.ms) || pick.ms <= 0) throw Error('Hover/pick pairing failed');
        const [,, width, height] = pick.texelInput;
        const expectedBytes = sample.side === 'branch' ? 256 : 256 + Math.ceil(width * 4 / 256) * 256 * height;
        if (pick.maps.reduce((sum, map) => sum + map.size, 0) !== expectedBytes) throw Error('Readback allocation evidence differs from the declared mechanism');
        if (pick.result) {
          const commit = input.commits.at(-1);
          if (!commit || commit.entityId !== pick.result.expressId || commit.modelIndex !== pick.result.modelIndex
            || JSON.stringify(commit.worldXYZ) !== JSON.stringify(pick.result.worldXYZ)) throw Error('GPU result did not reach mounted hover state');
          commits.push(commit.ms);
        }
      }
      if (!commits.length) throw Error('No actual mounted hover hits');
      const signature = { geometry: record.geometryBefore, viewport: rect,
        picks: record.hover.picks.map(pick => ({ result: pick.result, matrix: pick.matrix, cameraWorld: pick.cameraWorld, texelInput: pick.texelInput })) };
      const reference = references.get(scenario.name);
      if (!probe && reference && !sameSampleIdentity(reference, signature)) throw Error('Geometry/camera/texel/ID/item/world identity differs between samples');
      if (!reference) references.set(scenario.name, signature); // First sample only: the world tolerance does not compose.
      record.retirement = await page.evaluate('globalThis.__6881Hover.retire()');
      record.geometryAfter = await page.evaluate(async () => (await import('/__6881/hover.js')).geometryWitness());
      if (JSON.stringify(record.geometryBefore) !== JSON.stringify(record.geometryAfter)) throw Error('Hover changed geometry publication');
      record.hostAfter = await awaitQuietHost(readHostAdmission); record.sessionAfter = readPhysicalSession();
      record.health = await page.evaluate('({...globalThis.__6881Health, visibility:document.visibilityState, focused:document.hasFocus(), dpr:devicePixelRatio})');
      if (!record.hostAfter.quiet || !isPhysicalConsole(record.sessionAfter) || Math.abs(record.health.dpr - 1) > 1e-6
        || record.health.visibility !== 'visible' || !record.health.focused || record.health.interruptions
        || !record.health.adapters.length || record.health.adapters.some(a => a.vendor !== 'nvidia' || a.fallback)
        || record.health.errors.length || record.errors.length || record.driverErrors.length) throw Error('Final host/browser/GPU health refused');
      record.rows = [['pointer-to-hover-median-ms', median(commits)], ['pointer-to-hover-p95-ms', p95(commits)], ['GPU-picker-median-ms', median(record.hover.picks.map(pick => pick.ms))],
        ['mapped-bytes-per-pick', median(record.hover.picks.map(pick => pick.maps.reduce((sum, map) => sum + map.size, 0)))]]
        .map(([metric, value]) => ({ fixture: scenario.name, scenario: 'hover', metric, value }));
      record.ok = true;
    } catch (error) { record.error = String(error); throw error; }
    finally {
      if (browser?.isConnected()) {
        record.cleanupError = await closeBrowserWithTimeout(browser, 15000); browser = null;
        if (record.cleanupError) record.ok = false;
      }
      if (record.driverErrors.length) record.ok = false;
      appendFileSync(`${output}/runs.jsonl`, JSON.stringify(record) + '\n');
      active = null;
    }
    if (!record.ok) throw Error('Sample teardown/driver health failed');
  }
  verify();
  if (!probe) {
    report.summary = summarizeSamples(records);
    if (records.length !== config.scenarios.length * 10 || report.summary.some(row => row.pairs !== 5)) throw Error('Incomplete paired cohort');
    report.accepted = true;
  }
} catch (error) { report.error = String(error); process.exitCode = 1; }
finally {
  restoreStderr();
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  writeFileSync(`${output}/result.json`, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ accepted: report.accepted, error: report.error, output, summary: report.summary }));
}
