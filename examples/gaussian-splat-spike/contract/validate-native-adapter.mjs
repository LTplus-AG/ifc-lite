/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
// #8564 internal, unqualified native Gaussian adapter: browser GPU witness.
// Correctness evidence only; never timing, hardware performance or production
// qualification. Serialize GPU use:
//   ~/build-workers/ifc-gpu-check -- node examples/gaussian-splat-spike/contract/validate-native-adapter.mjs \
//     [--backend=auto|swiftshader|hardware] [--allow-pending-adapter]
//     [--demo [--capture=seem]] [--ifc-regression=/abs/base/checkout] [--scenes=a,b]
//     [--real-glass=/abs/k-layer/checkout]  (FZK-Haus + capture behind a window; needs prepare.mjs fixtures)
// auto = hardware when IFC_GPU_CDP_URL is set (ifc-gpu-check exports it for
// Windows Chrome on the PC GPU), else Playwright Chromium on SwiftShader.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { chromium } from '@playwright/test';
import { isHardwareAdapter } from '../../../scripts/perf/hardware-adapter.mjs';
import { judge } from './native-adapter-acceptance.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const repo = resolve(root, '../..');
const args = process.argv.slice(2);
const flag = name => args.includes(name);
const requested = args.find(a => a.startsWith('--backend='))?.slice('--backend='.length) ?? 'auto';
const backend = requested === 'auto' ? (process.env.IFC_GPU_CDP_URL ? 'hardware' : 'swiftshader') : requested;
if (!['swiftshader', 'hardware'].includes(backend)) throw new Error(`Unknown --backend=${requested}`);
if (backend === 'hardware' && !process.env.IFC_GPU_CDP_URL) throw new Error('--backend=hardware needs IFC_GPU_CDP_URL; run under ~/build-workers/ifc-gpu-check');
const option = name => args.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const regressionBase = option('ifc-regression');
const realGlassRoot = option('real-glass');
const output = resolve(process.env.SPLAT_SPIKE_EVIDENCE ?? '/tmp/ifc-splat-8564-native-adapter');
await mkdir(output, { recursive: true });
const SWIFTSHADER = ['--enable-unsafe-webgpu', '--enable-features=Vulkan', '--use-vulkan=swiftshader', '--use-angle=swiftshader',
  '--disable-vulkan-surface', '--ignore-gpu-blocklist', '--enable-gpu'];

// Source binding: the commit plus a hash of every modified or untracked file
// (the harness itself is untracked while under review), so a run is reviewable.
const git = (...argv) => execFileSync('git', argv, { cwd: repo, encoding: 'utf8' }).trim();
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
async function hashFile(path) {
  const info = await stat(resolve(repo, path)).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  return info?.isFile() ? sha256(await readFile(resolve(repo, path))) : null;
}
// Not trimmed: the first line's leading status space is significant.
const porcelain = execFileSync('git', ['status', '--porcelain=v1', '--untracked-files=all'], { cwd: repo, encoding: 'utf8' }).split('\n').filter(Boolean);
const worktreeFiles = [];
for (const line of porcelain) {
  const path = line.slice(3).split(' -> ').at(-1);
  worktreeFiles.push({ status: line.slice(0, 2), path, sha256: await hashFile(path) });
}
const contract = 'examples/gaussian-splat-spike/contract';
const harnessFiles = [];
for (const name of (await readdir(resolve(repo, contract))).filter(n => n.startsWith('native-adapter-') || n === 'validate-native-adapter.mjs').sort()) {
  harnessFiles.push({ path: `${contract}/${name}`, sha256: await hashFile(`${contract}/${name}`) });
}
const harnessDigest = sha256(harnessFiles.map(f => `${f.path}:${f.sha256}`).join('\n')).slice(0, 8);
const sourceCommit = git('rev-parse', 'HEAD');
const stamp = `${sourceCommit.slice(0, 10)}-h${harnessDigest}`;
const lumaSplats = JSON.parse(await readFile(resolve(repo, 'packages/renderer/node_modules/@luma.gl/splats/package.json'), 'utf8'));
const evidence = {
  issue: 8564, kind: realGlassRoot ? 'real-glass' : regressionBase ? 'ifc-regression' : flag('--demo') ? `demo-smoke${option('capture') ? `-${option('capture')}` : ''}` : 'witness',
  productionReady: false, qualification: 'internal-unqualified',
  mode: backend === 'hardware' ? 'hardware GPU correctness (Windows Chrome over CDP)' : 'SwiftShader correctness only',
  backend, sourceCommit, worktreeDirty: porcelain.length > 0,
  source: { commit: sourceCommit, gitStatusPorcelain: porcelain, worktreeFiles, harness: { digest: harnessDigest, files: harnessFiles } },
  upstream: { '@luma.gl/splats': lumaSplats.version, installedPatch: 'patches/@luma.gl__splats@9.4.2.patch (depthConvention + depth-interval hook)' },
  startedAt: new Date().toISOString(),
};

const aliases = { '@ifc-lite/spatial': resolve(repo, 'packages/spatial/src/index.ts'), '@ifc-lite/load-trace': resolve(repo, 'packages/load-trace/src/index.ts') };
async function startServer(configFile) {
  const server = await createServer({
    root, logLevel: 'warn', ...(configFile ? { configFile } : { configFile: false, resolve: { alias: aliases } }),
    optimizeDeps: { noDiscovery: true, include: [] },
    server: { host: '127.0.0.1', port: 0, strictPort: false, fs: { allow: [repo] } },
  });
  await server.listen();
  return server;
}

async function openPage(browser) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  const log = { pageErrors: [], consoleErrors: [], consoleWarnings: [], failedRequests: [] };
  page.on('pageerror', error => log.pageErrors.push(error.stack ?? error.message));
  page.on('console', message => {
    if (message.type() === 'error') log.consoleErrors.push(message.text().slice(0, 600));
    else if (message.type() === 'warning' && log.consoleWarnings.length < 40) log.consoleWarnings.push(message.text().slice(0, 300));
  });
  page.on('requestfailed', request => log.failedRequests.push(`${request.url()} ${request.failure()?.errorText ?? ''}`));
  return { context, page, log };
}

const withTimeout = (promise, ms, what) => Promise.race([promise,
  new Promise((_, reject) => setTimeout(() => reject(new Error(`${what} timed out after ${ms / 1000}s`)), ms).unref())]);

async function runWitness(browser) {
  const server = await startServer(null);
  const { context, page, log } = await openPage(browser);
  try {
    const scenes = option('scenes');
    await page.goto(`${server.resolvedUrls.local[0]}contract/native-adapter-witness.html${scenes ? `?scenes=${encodeURIComponent(scenes)}` : ''}`);
    await page.waitForFunction(() => Boolean(window.nativeAdapterWitness), undefined, { timeout: 120000 });
    const outcome = await withTimeout(page.evaluate(() => window.nativeAdapterWitness), 15 * 60000, 'witness');
    evidence.browserLog = log;
    if (outcome.error) throw new Error(`Witness page failed: ${outcome.error}`);
    const { images, ...result } = outcome.result;
    for (const [name, base64] of Object.entries(images)) await writeFile(resolve(output, `native-adapter-${backend}-${stamp}-${name}.png`), Buffer.from(base64, 'base64'));
    evidence.images = Object.keys(images).map(name => `native-adapter-${backend}-${stamp}-${name}.png`);
    evidence.environment = result.environment;
    evidence.adapterAvailable = result.adapterAvailable;
    const verdict = judge(result, { allowPendingAdapter: flag('--allow-pending-adapter') });
    const extra = [
      { name: 'no page errors', pass: log.pageErrors.length === 0, detail: log.pageErrors },
      { name: 'no browser console errors', pass: log.consoleErrors.length === 0, detail: log.consoleErrors },
      { name: 'no failed requests', pass: log.failedRequests.length === 0, detail: log.failedRequests },
      ...(backend === 'hardware' ? [{ name: 'hardware run used a non-software adapter', pass: isHardwareAdapter(result.environment.adapterInfo), detail: result.environment.adapterInfo }] : []),
    ].map(({ pass, detail, ...rest }) => ({ ...rest, pass, ...(pass ? {} : { detail }) }));
    verdict.checks.push(...extra);
    verdict.failed.push(...extra.filter(c => !c.pass));
    verdict.total = verdict.checks.length;
    verdict.pass = verdict.failed.length === 0;
    evidence.status = !verdict.pass ? 'fail' : result.adapterAvailable ? 'pass' : 'baseline-only (adapter API missing)';
    evidence.verdict = { pass: verdict.pass, total: verdict.total, failed: verdict.failed };
    if (scenes) evidence.scenesRequested = scenes.split(',');
    evidence.checks = verdict.checks.map(c => `${c.pass ? 'PASS' : 'FAIL'} ${c.name}`);
    evidence.scenes = result.scenes;
    evidence.consoleErrorsInPage = result.consoleErrors;
    if (!verdict.pass) process.exitCode = 1;
  } finally {
    await context.close();
    await server.close();
  }
}

let browser;
try {
  browser = backend === 'hardware'
    ? await chromium.connectOverCDP(process.env.IFC_GPU_CDP_URL)
    : await chromium.launch({ headless: true, ...(process.env.NATIVE_ADAPTER_CHANNEL ? { channel: process.env.NATIVE_ADAPTER_CHANNEL } : {}), args: SWIFTSHADER });
  evidence.browser = { version: browser.version(), channel: backend === 'hardware' ? 'windows-chrome-cdp' : process.env.NATIVE_ADAPTER_CHANNEL ?? 'playwright-chromium' };
  if (realGlassRoot) {
    const { runRealGlass } = await import('./native-adapter-real-glass-check.mjs');
    Object.assign(evidence, await runRealGlass({ browser, openPage, output, backend, stamp, repo, kLayerRoot: resolve(realGlassRoot) }));
    if (evidence.status !== 'pass') process.exitCode = 1;
  } else if (regressionBase) {
    const { runIfcRegression } = await import('./native-adapter-ifc-regression-check.mjs');
    Object.assign(evidence, await runIfcRegression({ browser, openPage, output, backend, stamp, repo, baseRoot: resolve(regressionBase) }));
    if (evidence.status !== 'pass') process.exitCode = 1;
  } else if (flag('--demo')) {
    const { runDemo } = await import('./native-adapter-demo-check.mjs');
    Object.assign(evidence, await runDemo({ browser, openPage, output, backend, stamp, capture: option('capture'),
      allowPendingAdapter: flag('--allow-pending-adapter') }));
    if (evidence.status !== 'pass' && !evidence.status.startsWith('baseline-only')) process.exitCode = 1;
  } else {
    await runWitness(browser);
  }
} catch (error) {
  evidence.status = 'error';
  evidence.failure = error.stack ?? String(error);
  process.exitCode = 1;
} finally {
  await browser?.close();
  evidence.finishedAt = new Date().toISOString();
  const file = resolve(output, `native-adapter-${evidence.kind}-${backend}-${stamp}.json`);
  await writeFile(file, JSON.stringify(evidence, null, 2) + '\n');
  console.log(JSON.stringify({ status: evidence.status, evidence: file, failed: evidence.verdict?.failed?.map(c => c.name) ?? evidence.failure ?? null,
    checks: evidence.verdict ? `${evidence.verdict.total - evidence.verdict.failed.length}/${evidence.verdict.total}` : undefined }, null, 2));
}
