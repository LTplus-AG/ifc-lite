#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Deployment smoke for the retained-only hosted preview (#7955). Takes a URL; read-only.
//
//   node scripts/smoke-retained-preview.mjs --url https://<preview>.vercel.app \
//     [--source-tag v27.1.1] [--expect-engine-manifest-sha256 HEX] [--fixture model.ifc] \
//     [--out summary.json] [--channel chrome | --browser-executable PATH] [--rehearsal]
//   node scripts/smoke-retained-preview.mjs --production --url https://www.ifclite.com \
//     [--lock apps/viewer/retained-engine.lock.json] [--source-tag vX.Y.Z] ...
//
// --production checks a production-shaped deployment (the viewer built as
// VITE_RETAINED_GEOMETRY=lazy with the engine installed by
// scripts/install-retained-engine.mjs): the identity is
// /retained-engine/deployment.json (compared field by field with --lock), the
// startup graph is checked over HTTP, and retained is chosen the way a user does,
// through the saved Settings choice, with no `?kernel=` parameter.
//
// Steps (each pass/fail in the JSON summary; exit 1 on any failure):
//   identity        /retained-preview.json is served, publishable unless --rehearsal, tag matches
//                   (--production: /retained-engine/deployment.json matches the tag and --lock)
//   startup-graph   --production only: index.html's entry, modulepreloads and their static
//                   imports, as served, carry no retained code signature
//   engine-assets   every engine-manifest file is served at its contract URL with the
//                   manifest's sha256, COOP/COEP/nosniff and the right MIME type; a
//                   missing engine URL is a 404, not the SPA's index.html
//   notices         all licence/notice texts are served as text; IFC-Lite notices carry
//                   the exact covered-source tag URL (placeholder only under --rehearsal)
//   retained-frame  fresh Chrome: crossOriginIsolated, `?kernel=retained` (--production: the
//                   saved Settings choice) + the real file input publishes retained products
//                   and draws the first retained frame (the #8413 page instrumentation and assertions)
//   default-exact   fresh Chrome, no kernel parameter: the same model loads exact, with no
//                   request to /smlib/ or /retained-engine/ and no downloaded JS carrying
//                   retained code
// The default fixture is the committed tests/fixtures/cli-retained/layered-wall.ifc.

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertManifestIdentity } from './lib/retained-preview.mjs';
import { isMainEntry } from './lib/is-main-entry.mjs';
import { REQUIRED_NOTICES, SOURCE_URL_NOTICES, expectedType, missingNotices, noticeSourceProblems, responseProblems, servedEngineFiles } from './lib/retained-preview.mjs';
import { assertMilestones, assertViewerRetained } from './perf/retained-qual-assert.mjs';
import { INIT_SCRIPT, PAGE_KEY } from './perf/retained-qual-viewer-page.mjs';
import { launchFresh } from './perf/retained-qual-browser.mjs';
import { CODE_SIGNATURES, staticImports } from './check-viewer-retained-free.mjs';
import { eagerScripts } from './perf-ratchet/measure-bundle.mjs';
import { DEPLOYMENT_PATH, DEPLOYMENT_SCHEMA, GEOMETRY_KERNEL_SETTING_KEY, readLock } from './lib/retained-engine-artifact.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_FIXTURE = join(REPO, 'tests/fixtures/cli-retained/layered-wall.ifc');
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

async function get(origin, path) {
  const response = await fetch(new URL(path, origin), { redirect: 'manual', cache: 'no-store' });
  const bytes = Buffer.from(await response.arrayBuffer());
  return { status: response.status, headers: Object.fromEntries([...response.headers].map(([k, v]) => [k.toLowerCase(), v])), bytes };
}

export function engineAssetResponseProblems(url, source, response) {
  const typed = /\.(wasm|m?js|json|md|txt)$/.test(url) || source.startsWith('LICENSES/') || REQUIRED_NOTICES.includes(source);
  return responseProblems({ url, ...response, expectType: typed ? expectedType(url) : undefined });
}

const readModel = () => {
  const state = globalThis.__ifc_lite_viewer_store__.getState();
  const model = [...state.models.values()][0], rg = model?.retainedGeometry;
  return { error: state.error ?? null, models: state.models.size, loadState: model?.loadState ?? null, loading: state.loading,
    summary: rg ? { kernel: rg.kernel, candidates: rg.candidates, started: rg.started, published: rg.published, completeness: rg.completeness,
      failure: rg.failure ?? null, refused: rg.refused.map(r => ({ expressId: r.expressId, code: r.code })) } : null,
    meshCount: model?.geometryResult?.meshes?.length ?? 0,
    spans: globalThis.__IFC_LITE_LOAD_TRACE__?.latest?.()?.spans.map(s => s.name) ?? [],
    crossOriginIsolated: globalThis.crossOriginIsolated };
};

async function retainedFrame({ origin, fixture, options, servedManifestSha256 }) {
  const browser = await launchFresh({ gpu: 'swiftshader', channel: options.channel, executable: options.executable, headed: false });
  try {
    const { page } = browser;
    await page.addInitScript(INIT_SCRIPT);
    if (options.production) {
      // A returning user who chose Retained in Settings: no parameter, only the saved choice.
      await page.addInitScript(key => localStorage.setItem(key, 'retained'), GEOMETRY_KERNEL_SETTING_KEY);
    }
    await page.goto(new URL(options.production ? '/?perfTrace=1' : '/?perfTrace=1&kernel=retained', origin).href);
    await page.waitForFunction(() => Boolean(globalThis.__ifc_lite_viewer_store__), null, { timeout: 120000 });
    if (await page.evaluate(() => globalThis.crossOriginIsolated) !== true) throw new Error('crossOriginIsolated is not true');
    await page.locator('#file-input-open').waitFor({ state: 'attached', timeout: 60000 });
    await page.locator('#file-input-open').setInputFiles(fixture);
    await page.waitForFunction(key => { const q = globalThis[key];
      if (q.errors.length || globalThis.__ifc_lite_viewer_store__.getState().error) return true;
      return q.terminalMs !== null && (q.firstRetainedFrameMs !== null || performance.now() - q.terminalMs > 30000); },
    PAGE_KEY, { timeout: Number(options.timeoutMs), polling: 100 });
    const m = await page.evaluate(key => ({ ...globalThis[key] }), PAGE_KEY);
    const state = await page.evaluate(readModel);
    if (m.errors.length) throw new Error(`page instrumentation: ${m.errors.join('; ')}`);
    assertViewerRetained({ state, requests: browser.requests, spans: state.spans, servedManifestSha256,
      expectedManifestSha256: options.expectManifest ?? servedManifestSha256 });
    assertMilestones(m);
    return { crossOriginIsolated: state.crossOriginIsolated, candidates: state.summary.candidates, published: state.summary.published,
      refused: state.summary.refused.length, completeness: state.summary.completeness, meshes: state.meshCount,
      firstRetainedFrameMs: m.firstRetainedFrameMs - m.loadChangeMs, drawCallsAtFirstFrame: m.drawCallsAtFirstFrame,
      engineRequests: browser.requests.filter(url => /\/(smlib|retained-engine)\//.test(url)).length, pageErrors: browser.pageErrors };
  } finally { await browser.close(); }
}

async function defaultExact({ origin, fixture, options }) {
  const browser = await launchFresh({ gpu: 'swiftshader', channel: options.channel, executable: options.executable, headed: false });
  try {
    const { page } = browser;
    const retainedJs = [], bodies = [];
    page.on('response', response => {
      if (!/\.m?js(\?|$)/.test(response.url())) return;
      bodies.push(response.body().then(body => {
        if (CODE_SIGNATURES.some(signature => body.includes(signature))) retainedJs.push(response.url());
      }, () => undefined));
    });
    await page.goto(new URL('/', origin).href);
    await page.waitForFunction(() => Boolean(globalThis.__ifc_lite_viewer_store__), null, { timeout: 120000 });
    await page.locator('#file-input-open').waitFor({ state: 'attached', timeout: 60000 });
    await page.locator('#file-input-open').setInputFiles(fixture);
    await page.waitForFunction(() => { const s = globalThis.__ifc_lite_viewer_store__.getState(), m = [...s.models.values()][0];
      return Boolean(s.error) || (!s.loading && m?.loadState === 'complete'); }, null, { timeout: Number(options.timeoutMs), polling: 100 });
    const state = await page.evaluate(readModel);
    const engineRequests = browser.requests.filter(url => /\/(smlib|retained-engine)\//.test(url));
    await Promise.all(bodies);
    const problems = [];
    if (state.error) problems.push(`viewer error ${JSON.stringify(state.error)}`);
    if (state.models !== 1 || state.loadState !== 'complete') problems.push(`models=${state.models} loadState=${state.loadState}`);
    if (state.summary) problems.push(`default load carries retainedGeometry (kernel ${state.summary.kernel})`);
    if (state.meshCount <= 0) problems.push('exact load produced no meshes');
    if (engineRequests.length) problems.push(`default load requested ${engineRequests.length} engine URL(s): ${engineRequests[0]}`);
    if (state.crossOriginIsolated !== true) problems.push('crossOriginIsolated is not true');
    if (retainedJs.length) problems.push(`default load downloaded retained code: ${retainedJs.slice(0, 3).join(', ')}`);
    if (problems.length) throw new Error(problems.join('; '));
    return { meshes: state.meshCount, crossOriginIsolated: true, engineRequests: 0, retainedJsDownloads: 0, pageErrors: browser.pageErrors };
  } finally { await browser.close(); }
}

/** --production identity: the deployment record the installer wrote, bound to the tag and the lock. */
export async function productionIdentity(origin, options) {
  const response = await get(origin, `/${DEPLOYMENT_PATH}`);
  if (response.status !== 200) throw new Error(`/${DEPLOYMENT_PATH} HTTP ${response.status}`);
  const identity = JSON.parse(response.bytes.toString('utf8'));
  if (identity.schema !== DEPLOYMENT_SCHEMA) throw new Error(`schema ${identity.schema}`);
  if (options.sourceTag && identity.sourceTag !== options.sourceTag) throw new Error(`built for ${identity.sourceTag}, expected ${options.sourceTag}`);
  if (options.lock) {
    const lock = readLock(resolve(options.lock));
    for (const key of ['sourceTag', 'sourceCommit', 'archiveSha256', 'engineManifestSha256', 'sdkRevision']) {
      if (identity[key] !== lock[key]) throw new Error(`deployment ${key} ${identity[key]} != lock ${lock[key]}`);
    }
  }
  return identity;
}

/** --production: what the browser loads at startup, as served, is retained-free. */
export async function startupGraph(origin) {
  const page = await get(origin, '/');
  if (page.status !== 200) throw new Error(`/ HTTP ${page.status}`);
  const html = page.bytes.toString('utf8');
  const seen = new Set(), queue = eagerScripts(html).eager.map(url => new URL(url, origin).href), problems = [];
  while (queue.length) {
    const url = queue.pop();
    if (seen.has(url) || new URL(url).origin !== origin) continue;
    seen.add(url);
    const response = await get(origin, new URL(url).pathname);
    if (response.status !== 200) { problems.push(`${url}: HTTP ${response.status}`); continue; }
    const code = response.bytes.toString('utf8');
    for (const signature of CODE_SIGNATURES) if (code.includes(signature)) problems.push(`${url}: carries ${signature}`);
    for (const specifier of staticImports(code)) queue.push(new URL(specifier, url).href);
  }
  if (problems.length) throw new Error(problems.slice(0, 8).join('; '));
  return { startupChunks: seen.size };
}

export async function smoke(options) {
  const origin = new URL(options.url).origin;
  const steps = [];
  const step = async (name, fn) => {
    try { steps.push({ step: name, status: 'pass', detail: await fn() }); }
    catch (error) { steps.push({ step: name, status: 'fail', detail: error instanceof Error ? error.message : String(error) }); }
  };
  const fixture = resolve(options.fixture ?? DEFAULT_FIXTURE);
  let manifest = null, servedManifestSha256 = null, identity = null;

  await step('identity', async () => {
    if (options.production) return (identity = await productionIdentity(origin, options));
    const response = await get(origin, '/retained-preview.json');
    if (response.status !== 200) throw new Error(`/retained-preview.json HTTP ${response.status}`);
    identity = JSON.parse(response.bytes.toString('utf8'));
    if (identity.schema !== 'ifc-lite.retained-preview/1') throw new Error(`schema ${identity.schema}`);
    if (!options.rehearsal && identity.publishable !== true) throw new Error('preview is a rehearsal build (publishable=false)');
    if (options.sourceTag && identity.sourceTag !== options.sourceTag) throw new Error(`built for ${identity.sourceTag}, expected ${options.sourceTag}`);
    return identity;
  });

  await step('engine-assets', async () => {
    const raw = await get(origin, '/retained-engine/engine-manifest.json');
    const problems = responseProblems({ url: '/retained-engine/engine-manifest.json', ...raw, expectType: expectedType('.json') });
    if (problems.length) throw new Error(problems.join('; '));
    manifest = JSON.parse(raw.bytes.toString('utf8'));
    servedManifestSha256 = sha256(raw.bytes);
    assertManifestIdentity(identity, servedManifestSha256, options.expectManifest);
    const byPath = new Map(manifest.assets.map(a => [a.path, a]));
    let checked = 0;
    for (const { source, url } of servedEngineFiles(manifest.assets)) {
      if (source === 'engine-manifest.json') continue;
      const response = await get(origin, url);
      problems.push(...engineAssetResponseProblems(url, source, response));
      if (response.status === 200 && sha256(response.bytes) !== byPath.get(source).sha256) problems.push(`${url}: sha256 differs from the manifest`);
      checked++;
    }
    for (const url of ['/smlib/does-not-exist.mjs', '/retained-engine/pkg-retained/missing.wasm', '/retained-engine/LICENSES/missing']) {
      const response = await get(origin, url);
      if (response.status !== 404) problems.push(`${url}: HTTP ${response.status}, expected 404`);
      if (/text\/html/.test(response.headers['content-type'] ?? '')) problems.push(`${url}: served HTML (SPA fallback)`);
    }
    if (problems.length) throw new Error(problems.slice(0, 12).join('; '));
    return { servedManifestSha256, sdkRevision: manifest.sdk?.revision ?? null, qualified: manifest.qualified,
      buildAttestation: manifest.buildAttestation, filesVerified: checked };
  });

  await step('notices', async () => {
    if (!manifest) throw new Error('no engine manifest');
    const missing = missingNotices(manifest.assets);
    if (missing.length) throw new Error(`manifest lacks ${missing.join(', ')}`);
    const urls = servedEngineFiles(manifest.assets).filter(({ source }) => REQUIRED_NOTICES.includes(source));
    const problems = [], served = [];
    for (const { source, url } of urls) {
      const response = await get(origin, url);
      problems.push(...responseProblems({ url, ...response, expectType: /^text\/plain\b/ }));
      if (SOURCE_URL_NOTICES.includes(source)) {
        const found = noticeSourceProblems(response.bytes.toString('utf8'), options.sourceTag);
        const tolerated = options.rehearsal && found.every(p => p.includes('placeholder'));
        if (found.length && !tolerated) problems.push(...found.map(p => `${url}: ${p}`));
      }
      served.push(url);
    }
    if (problems.length) throw new Error(problems.join('; '));
    return { served, sourceTag: options.sourceTag ?? null, placeholderTolerated: Boolean(options.rehearsal) };
  });

  if (options.production) await step('startup-graph', () => startupGraph(origin));
  await step('retained-frame', () => retainedFrame({ origin, fixture, options, servedManifestSha256 }));
  await step('default-exact', () => defaultExact({ origin, fixture, options }));

  const failed = steps.filter(s => s.status === 'fail');
  return { schema: 'ifc-lite.retained-preview-smoke/1', url: origin, at: new Date().toISOString(), rehearsal: Boolean(options.rehearsal),
    production: Boolean(options.production),
    fixture: { path: fixture, sha256: sha256(readFileSync(fixture)) }, status: failed.length ? 'fail' : 'pass', steps };
}

function parse(argv) {
  const map = { '--url': 'url', '--source-tag': 'sourceTag', '--expect-engine-manifest-sha256': 'expectManifest', '--fixture': 'fixture',
    '--out': 'out', '--channel': 'channel', '--browser-executable': 'executable', '--timeout-ms': 'timeoutMs', '--lock': 'lock' };
  const options = { channel: 'chrome', timeoutMs: 300000 };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--rehearsal') { options.rehearsal = true; continue; }
    if (argv[i] === '--production') { options.production = true; continue; }
    const name = map[argv[i]];
    if (!name || argv[i + 1] === undefined) throw new Error(`unknown or incomplete option ${argv[i]}`);
    options[name] = argv[++i];
  }
  if (!options.url) throw new Error('Usage: node scripts/smoke-retained-preview.mjs --url URL [--source-tag vX.Y.Z] [--expect-engine-manifest-sha256 HEX] [--out FILE] [--rehearsal]');
  if (options.production && options.rehearsal) throw new Error('--production serves only published engines; --rehearsal does not apply');
  if (options.lock && !options.sourceTag) options.sourceTag = readLock(resolve(options.lock)).sourceTag;
  if (!options.rehearsal && !options.sourceTag) throw new Error('--source-tag vX.Y.Z is required (or --rehearsal for a local run)');
  return options;
}

if (isMainEntry(import.meta.url)) {
  try {
    const options = parse(process.argv.slice(2));
    const summary = await smoke(options);
    if (options.out) writeFileSync(options.out, `${JSON.stringify(summary, null, 2)}\n`);
    for (const s of summary.steps) console.log(`${s.status.padEnd(4)} ${s.step}${s.status === 'fail' ? `: ${s.detail}` : ''}`);
    console.log(`retained preview smoke: ${summary.status} (${summary.url})`);
    process.exitCode = summary.status === 'pass' ? 0 : 1;
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
