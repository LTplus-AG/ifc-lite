#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Untimed acceptance only; invoke INSIDE one ifc-gpu-check, after a root build.
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:net';
import { access, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir, hostname, platform, release, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from '@playwright/test';

const HERE = dirname(fileURLToPath(import.meta.url));
const checkoutIndex = process.argv.indexOf('--checkout');
const ROOT = checkoutIndex < 0 ? resolve(HERE, '../../..') : resolve(process.argv[checkoutIndex + 1] ?? '.');
const SPECS = ['command-palette-ux', 'command-palette-access', 'command-palette-access-extension']
  .map(name => `tests/e2e/${name}.e2e.spec.ts`);
const CAPTURES = {
  matrix: ['tests/ui-scenes/command-palette/capture-matrix.mjs',
    'command-palette,palette-browse,palette-annot,palette-narrow,palette-empty,palette-short'],
  contexts: ['tests/ui-scenes/command-palette-access/capture-contexts.mjs',
    'access-unloaded-hide,access-loaded-hide,access-selected-hide,access-selected-hide-run,access-history,access-settings-privacy'],
  flows: ['tests/ui-scenes/command-palette-access/capture-flows.mjs',
    'flow-settings-privacy,flow-narrow-display,flow-hidden-wall,flow-measure-quantities,flow-blank-wall,flow-camera-corner'],
};
let activeChild;
let interrupted = false;
const shellQuote = value => "'" + value.replaceAll("'", "'\"'\"'") + "'";
const sha = data => createHash('sha256').update(data).digest('hex');
const git = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
const json = async path => JSON.parse(await readFile(path, 'utf8'));
const save = (path, data) => writeFile(path, JSON.stringify(data, null, 2) + '\n');

function parse(argv) {
  const opts = { mode: 'all', dist: join(ROOT, 'apps/viewer/dist') };
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (!['--mode', '--expected-source', '--build-receipt', '--dist', '--out', '--chrome', '--checkout'].includes(key))
      throw new Error(`Unknown option ${key}`);
    if (!argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error(`${key} requires a value`);
    opts[key.slice(2)] = argv[++i];
  }
  if (!opts.out || !opts['build-receipt'] || !/^[a-f0-9]{40}$/.test(opts['expected-source'] ?? ''))
    throw new Error('Required: --expected-source FULL_SHA --build-receipt FILE --out NEW_DIRECTORY');
  if (!['all', 'e2e', ...Object.keys(CAPTURES)].includes(opts.mode)) throw new Error('Invalid mode');
  return opts;
}

async function unusedPort() {
  const server = createServer();
  await new Promise((ok, fail) => { server.once('error', fail); server.listen(0, '127.0.0.1', ok); });
  const port = server.address().port;
  await new Promise((ok, fail) => server.close(error => error ? fail(error) : ok()));
  return port; // strictPort + reuseExistingServer:false below fail closed on a race.
}

async function executable(explicit) {
  if (explicit) { await access(explicit, constants.X_OK); return realpath(explicit); }
  const base = join(homedir(), '.t3/tools/chrome-headless-shell/linux64');
  const versions = (await readdir(base)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).reverse();
  for (const version of versions) {
    const path = join(base, version, 'chrome-headless-shell');
    try { await access(path, constants.X_OK); return realpath(path); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  throw new Error('No approved Linux headless-shell; use --chrome /absolute/executable');
}

async function startBrowser(opts, manifest) {
  if (process.env.IFC_GPU_CDP_URL) {
    manifest.browser = { ownership: 'helper-managed; disconnect only', cdp: process.env.IFC_GPU_CDP_URL };
    return { cdp: process.env.IFC_GPU_CDP_URL, close: async () => {} };
  }
  if (platform() !== 'linux' || release().toLowerCase().includes('microsoft'))
    throw new Error('PC/WSL requires helper-provided IFC_GPU_CDP_URL; Linux launch is Pop only');
  const path = await executable(opts.chrome ?? process.env.IFC_GPU_CHROME_PATH);
  // Helper supplies whitespace-separated flags. JSON permits arguments with spaces.
  const raw = process.env.IFC_GPU_CHROME_ARGS;
  if (!raw) throw new Error('IFC_GPU_CHROME_ARGS missing: run inside the existing GPU helper');
  const args = raw.startsWith('[') ? JSON.parse(raw) : raw.trim().split(/\s+/);
  if (!Array.isArray(args) || args.some(arg => typeof arg !== 'string' ||
      /swiftshader|llvmpipe|softpipe|user-data-dir|remote-debugging|disable-gpu/i.test(arg)))
    throw new Error('Unsafe/software/ownership Chrome flags refused');
  const profile = await mkdtemp(join(tmpdir(), 'palette-browser-'));
  let context;
  try {
    // 1.64 uses a pipe for its owner connection; the additional port is for
    // independent capture/spec CDP clients. Chromium writes DevToolsActivePort.
    context = await chromium.launchPersistentContext(profile, {
      executablePath: path, headless: true, args: [...args, '--remote-debugging-port=0'],
      timeout: 60000,
    });
    const deadline = Date.now() + 15000;
    let endpoint;
    while (Date.now() < deadline) {
      try { endpoint = (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).trim().split('\n'); break; }
      catch (error) {
        if (error.code !== 'ENOENT') throw error;
        await new Promise(ok => setTimeout(ok, 100));
      }
    }
    if (!endpoint || !/^\d+$/.test(endpoint[0]) || !endpoint[1]?.startsWith('/devtools/browser/'))
      throw new Error('Owned browser did not publish a valid CDP endpoint');
    const cdp = `http://127.0.0.1:${endpoint[0]}`;
    manifest.browser = { ownership: 'runner', executable: path, args, profile, cdp };
    return { cdp, close: async () => { await context.close(); await rm(profile, { recursive: true }); } };
  } catch (error) {
    await context?.close();
    await rm(profile, { recursive: true });
    throw error;
  }
}

async function probe(cdp) {
  const browser = await chromium.connectOverCDP(cdp);
  let context;
  try {
    context = await browser.newContext();
    const page = await context.newPage();
    await page.route('http://localhost/palette-gpu-proof', route => route.fulfill({
      contentType: 'text/html', body: '<!doctype html><title>Owned GPU proof</title>',
    }));
    await page.goto('http://localhost/palette-gpu-proof');
    return await page.evaluate(async () => {
      const adapter = await navigator.gpu?.requestAdapter();
      if (!adapter) throw new Error('No WebGPU adapter');
      const info = adapter.info;
      const proof = { vendor: info.vendor, architecture: info.architecture,
        device: info.device, description: info.description,
        fallback: info.isFallbackAdapter ?? adapter.isFallbackAdapter };
      if (proof.fallback !== false || /swiftshader|llvmpipe|softpipe|software|lavapipe/i.test(JSON.stringify(proof)) ||
          !/nvidia|amd|intel|apple|qualcomm|0x10de|0x1002|0x8086/i.test(proof.vendor))
        throw new Error(`Physical adapter not established: ${JSON.stringify(proof)}`);
      const device = await adapter.requestDevice();
      try {
        const texture = device.createTexture({ size: [1, 1], format: 'rgba8unorm',
          usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
        const buffer = device.createBuffer({ size: 256, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
        const encoder = device.createCommandEncoder();
        const pass = encoder.beginRenderPass({ colorAttachments: [{ view: texture.createView(),
          clearValue: [0, 1, 0, 1], loadOp: 'clear', storeOp: 'store' }] });
        pass.end();
        encoder.copyTextureToBuffer({ texture }, { buffer, bytesPerRow: 256 }, [1, 1]);
        device.queue.submit([encoder.finish()]);
        await buffer.mapAsync(GPUMapMode.READ);
        const pixel = [...new Uint8Array(buffer.getMappedRange()).slice(0, 4)];
        buffer.unmap(); buffer.destroy(); texture.destroy();
        if (pixel.join(',') !== '0,255,0,255') throw new Error(`GPU readback failed: ${pixel}`);
        return { ...proof, pixel };
      } finally { device.destroy(); }
    });
  } finally { await context?.close(); await browser.close(); } // CDP disconnect
}

async function command(argv, env, out, manifest) {
  const entry = { argv, started: new Date().toISOString(), status: 'running' };
  manifest.commands.push(entry);
  await save(join(out, 'manifest.json'), manifest);
  const child = spawn(argv[0], argv.slice(1), { cwd: ROOT, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  activeChild = child;
  const chunks = [];
  for (const stream of [child.stdout, child.stderr]) stream.on('data', data => {
    chunks.push(data); process.stderr.write(data);
  });
  const result = await new Promise(ok => {
    let spawnError;
    child.once('error', error => { spawnError = String(error); });
    child.once('close', (exit, signal) => ok({ exit, signal, error: spawnError }));
  });
  activeChild = undefined;
  Object.assign(entry, result, { status: result.exit === 0 ? 'passed' : 'failed', ended: new Date().toISOString() });
  await writeFile(join(out, `command-${manifest.commands.length}.log`), Buffer.concat(chunks));
  await save(join(out, 'manifest.json'), manifest);
  if (result.exit !== 0 || interrupted) throw new Error(`Required command failed: ${JSON.stringify(entry)}`);
}

function outcomes(report) {
  return (report.suites ?? []).flatMap(suite => [
    ...outcomes(suite), ...(suite.specs ?? []).flatMap(spec => (spec.tests ?? []).map(test => ({
      file: spec.file, title: spec.title, project: test.projectName, status: test.status,
      expectedStatus: test.expectedStatus, results: (test.results ?? []).map(result => ({
        status: result.status, errors: result.errors, attachments: result.attachments,
      })),
    }))),
  ]);
}

async function main() {
  const opts = parse(process.argv.slice(2));
  const out = resolve(opts.out);
  await mkdir(out); // Exclusive owned evidence directory; never erase an earlier run.
  const manifest = { version: 1, status: 'partial', untimed: true, started: new Date().toISOString(),
    host: { hostname: hostname(), platform: platform(), release: release() }, expectedSource: opts['expected-source'],
    runnerDirectory: HERE, checkout: ROOT, commands: [], attempted: [], requested: opts.mode === 'all' ? ['e2e', ...Object.keys(CAPTURES)] : [opts.mode], completed: [],
    skips: [], outcomes: [] };
  let browser;
  let scratch;
  const onSignal = signal => {
    interrupted = true;
    manifest.interrupted = signal;
    if (activeChild?.pid) {
      try { process.kill(-activeChild.pid, 'SIGINT'); }
      catch (error) { if (error.code !== 'ESRCH') console.error(error); }
    } else if (browser) {
      browser.close().catch(error => console.error(`Signal cleanup: ${error}`));
    }
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  try {
    manifest.source = { sha: git('rev-parse', 'HEAD'), tree: git('rev-parse', 'HEAD^{tree}'),
      status: git('status', '--porcelain'), diffSha256: sha(git('diff', 'HEAD', '--binary')) };
    const allowed = new Set(['run-browser.mjs', 'attach-gpu.mjs', 'browser-scenarios.md']
      .map(name => `tests/ui-scenes/command-palette-access/${name}`));
    manifest.runnerFiles = Object.fromEntries(await Promise.all([...allowed].map(async path =>
      [path, sha(await readFile(join(HERE, path.split('/').at(-1))))])));
    const dirty = [...git('diff', 'HEAD', '--name-only').split('\n'),
      ...git('ls-files', '--others', '--exclude-standard').split('\n')].filter(Boolean);
    if (dirty.some(path => !allowed.has(path))) throw new Error('Unrelated dirty source: rebuild committed candidate');
    if (manifest.source.sha !== manifest.expectedSource) throw new Error('Expected source SHA differs from HEAD');
    const dist = await realpath(resolve(opts.dist));
    const indexHash = sha(await readFile(join(dist, 'index.html')));
    const receiptPath = resolve(opts['build-receipt']);
    const receiptBytes = await readFile(receiptPath);
    const receipt = JSON.parse(receiptBytes);
    manifest.dist = { path: dist, indexSha256: indexHash, receiptPath, receiptSha256: sha(receiptBytes), receipt };
    if (receipt.sourceSha !== manifest.source.sha || receipt.sourceTree !== manifest.source.tree ||
        receipt.distIndexSha256 !== indexHash || await realpath(receipt.dist) !== dist || receipt.exit !== 0 ||
        JSON.stringify(receipt.command) !== JSON.stringify(['pnpm', 'build:e2e']) || !receipt.rootValidationReceipt)
      throw new Error('Matching root build receipt required; paths/filenames alone do not establish provenance');
    // Store the linked root-validation receipt identity; coordinator interprets its coverage.
    manifest.rootValidation = { path: resolve(receipt.rootValidationReceipt),
      sha256: sha(await readFile(resolve(receipt.rootValidationReceipt))) };
    browser = await startBrowser(opts, manifest);
    const closeOwned = browser.close;
    let closing;
    browser.close = () => closing ??= closeOwned();
    if (interrupted) throw new Error('Interrupted before GPU probe');
    manifest.adapter = await probe(browser.cdp);
    scratch = await mkdtemp(join(tmpdir(), 'palette-runner-'));
    const env = { ...process.env, IFC_GPU_CDP_URL: browser.cdp,
      NODE_OPTIONS: [process.env.NODE_OPTIONS, `--import=${pathToFileURL(join(HERE, 'attach-gpu.mjs')).href}`].filter(Boolean).join(' ') };
    for (const mode of manifest.requested) {
      if (interrupted) throw new Error('Interrupted');
      manifest.attempted.push(mode);
      if (mode === 'e2e') {
        const port = await unusedPort();
        const config = join(scratch, 'playwright.config.ts');
        // Retain project's assertions, timeouts, screenshots and traces. Only
        // transport, preview ownership and evidence paths differ from root config.
        await writeFile(config, `import base from ${JSON.stringify(join(ROOT, 'playwright.config.ts'))};
export default { ...base, testDir: ${JSON.stringify(join(ROOT, 'tests'))},
  outputDir: ${JSON.stringify(join(out, 'test-results'))},
  webServer: { ...base.webServer, cwd: ${JSON.stringify(ROOT)}, command: ${JSON.stringify(`pnpm --filter @ifc-lite/viewer exec vite preview --outDir ${shellQuote(dist)} --host 127.0.0.1 --port ${port} --strictPort`)},
    url: 'http://127.0.0.1:${port}', port: undefined, reuseExistingServer: false },
  projects: base.projects.filter(p => p.name === 'viewer-e2e-ci').map(p => ({ ...p,
    use: { ...p.use, baseURL: 'http://127.0.0.1:${port}' } })) };
`);
        env.PLAYWRIGHT_PORT = String(port);
        env.PLAYWRIGHT_JSON_OUTPUT_FILE = join(out, 'e2e.json');
        try {
          await command(['pnpm', 'exec', 'playwright', 'test', '--config', config,
            '--project=viewer-e2e-ci', '--workers=1', '--reporter=json', ...SPECS], env, out, manifest);
        } finally {
          try {
            const report = await json(env.PLAYWRIGHT_JSON_OUTPUT_FILE);
            manifest.outcomes = outcomes(report);
            manifest.skips = manifest.outcomes.filter(test => test.results.some(result => result.status === 'skipped'));
          } catch (error) { manifest.reportError = String(error); }
        }
        if (manifest.outcomes.length !== 22 || manifest.skips.length ||
            SPECS.some((spec, i) => manifest.outcomes.filter(test => test.file?.endsWith(spec.split('/').at(-1))).length !== [11, 10, 1][i]) ||
            manifest.outcomes.some(test => test.status !== 'expected' || test.expectedStatus !== 'passed'))
          throw new Error('Expected exactly 22 passing cases without skips; inspect e2e.json');
      } else {
        const [script, scenes] = CAPTURES[mode];
        const captureOut = join(out, mode);
        try {
          await command([process.execPath, script, '--dist', dist, '--out', captureOut,
            '--label', manifest.source.sha, '--cdp', browser.cdp, '--themes', 'light,dark', '--scenes', scenes], env, out, manifest);
        } finally {
          try { manifest[mode] = await json(join(captureOut, 'manifest.json')); }
          catch (error) { manifest[`${mode}ReportError`] = String(error); }
        }
        const capture = manifest[mode];
        const expected = scenes.split(',').flatMap(scene => ['light', 'dark'].map(theme => `${scene}.${theme}`)).sort();
        const actual = capture.results.map(result => `${result.scene}.${result.theme}`).sort();
        if (capture.distIndexSha256 !== indexHash || capture.failures.length || JSON.stringify(actual) !== JSON.stringify(expected) ||
            capture.results.some(result => result.pageErrors.length)) throw new Error(`${mode}: incomplete or failed capture`);
      }
      manifest.completed.push(mode);
      await save(join(out, 'manifest.json'), manifest);
    }
    if (sha(await readFile(join(dist, 'index.html'))) !== indexHash || git('rev-parse', 'HEAD') !== manifest.source.sha ||
        git('status', '--porcelain') !== manifest.source.status ||
        sha(git('diff', 'HEAD', '--binary')) !== manifest.source.diffSha256) throw new Error('Source or artifact changed during run');
    for (const [path, hash] of Object.entries(manifest.runnerFiles)) {
      if (sha(await readFile(join(HERE, path.split('/').at(-1)))) !== hash) throw new Error(`Runner source changed: ${path}`);
    }
    if (interrupted) throw new Error('Interrupted');
    manifest.status = 'passed';
  } catch (error) {
    manifest.status = 'failed'; manifest.error = String(error); process.exitCode = 1;
    console.error(error);
  } finally {
    manifest.notRun = manifest.requested.filter(mode => !manifest.attempted.includes(mode));
    try { await browser?.close(); }
    catch (error) { manifest.cleanupError = String(error); manifest.status = 'failed'; process.exitCode = 1; }
    if (scratch) await rm(scratch, { recursive: true });
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    manifest.ended = new Date().toISOString();
    await save(join(out, 'manifest.json'), manifest);
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
