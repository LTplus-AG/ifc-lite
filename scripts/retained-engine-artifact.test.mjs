/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// #7955 production retained engine: pack -> lock -> fetch/verify -> install into a
// lazy viewer dist -> serve with the repository's own vercel.json -> production smoke
// helpers. Fixture engine bytes are inert; every check on them is the real one.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { packRetainedEngine } from './pack-retained-engine.mjs';
import { ContractMismatch, fetchRetainedEngine } from './fetch-retained-engine.mjs';
import { installRetainedEngine } from './install-retained-engine.mjs';
import { checkRetainedLazy, staticImports } from './check-viewer-retained-free.mjs';
import { createPreviewServer } from './serve-retained-preview.mjs';
import { productionIdentity, startupGraph } from './smoke-retained-preview.mjs';
import { REQUIRED_NOTICES, SOURCE_URL_NOTICES, responseProblems } from './lib/retained-preview.mjs';
import { archiveUrl, contractProblems, lockProblems, readLock } from './lib/retained-engine-artifact.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const TAG = 'v1.2.3';
const COMMIT = 'a'.repeat(40);
const SDK = 'c9c5979f04cea8c38213004d4f04df0dcfb40d05';
const DTS = 'export class RetainedModelSession { run(): Promise<void>; }\n';
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

/** A temporary root; `defer` disposers run in reverse, in the same hook, before the root goes. */
function scratch(t, deferred = []) {
  const root = mkdtempSync(join(tmpdir(), 'retained-artifact-'));
  t.after(async () => {
    for (const dispose of deferred.reverse()) await dispose();
    rmSync(root, { recursive: true, force: true });
  });
  return root;
}

function sub(root, name) {
  const path = join(root, name);
  mkdirSync(path, { recursive: true });
  return path;
}

function engineFixture(root, { tag = TAG, dts = DTS } = {}) {
  const engine = join(root, 'engine');
  const files = {
    'pkg-retained/ifc-lite.js': 'export default async function init() {}\n',
    'pkg-retained/ifc-lite_bg.wasm': '\0asm inert',
    'pkg-retained/ifc-lite.d.ts': dts,
    'smlib/worker.mjs': 'self.onmessage = () => {};\n',
    'smlib/ifclite_smlib_browser.wasm': '\0asm inert',
    'LICENSES/toolchain/Emscripten-LICENSE': 'MIT\n',
  };
  for (const path of REQUIRED_NOTICES) {
    files[path] = SOURCE_URL_NOTICES.includes(path)
      ? `Source: https://github.com/LTplus-AG/ifc-lite/tree/${tag}\n` : `notice ${path}\n`;
  }
  const assets = [];
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(engine, dirname(path)), { recursive: true });
    writeFileSync(join(engine, path), content);
    assets.push({ path, bytes: Buffer.byteLength(content), sha256: sha256(content) });
  }
  writeFileSync(join(engine, 'engine-manifest.json'), JSON.stringify({ format: 'ifc-lite.retained-engine/1', qualified: false,
    buildAttestation: false, sdk: { revision: SDK }, capabilities: null, assets }));
  return engine;
}

function repoFixture(root, dts = DTS) {
  const repo = join(root, 'repo');
  mkdirSync(join(repo, 'packages/wasm/pkg-retained'), { recursive: true });
  writeFileSync(join(repo, 'packages/wasm/pkg-retained/ifc-lite.d.ts'), dts);
  return repo;
}

const INDEX_HTML = '<!doctype html><script type="module" src="/assets/index-a.js"></script><link rel="modulepreload" href="/assets/vendor-b.js">';

/** A lazy viewer dist: entry + modulepreload + a static import, retained code only behind import(). */
function distFixture(root, { leak = false } = {}) {
  const dist = join(root, 'apps/viewer/dist');
  mkdirSync(join(dist, 'assets'), { recursive: true });
  writeFileSync(join(dist, 'index.html'), INDEX_HTML);
  writeFileSync(join(dist, 'assets/index-a.js'), 'import{x}from"./vendor-b.js";import"./shared-c.js";const l=()=>import("./retained-d.js");');
  writeFileSync(join(dist, 'assets/vendor-b.js'), 'export const x=1;');
  writeFileSync(join(dist, 'assets/shared-c.js'), leak ? 'const u="/smlib/worker.mjs";export{};' : 'export{};');
  writeFileSync(join(dist, 'assets/retained-d.js'), 'new Worker(new URL("/retained-engine/pkg-retained/ifc-lite.js",self.location.origin));');
  return dist;
}

function packed(root, options = {}) {
  const engine = engineFixture(root, options);
  const out = join(root, `ifc-lite-retained-engine-${TAG}.tar.gz`), lockOut = join(root, 'lock.json');
  const lock = packRetainedEngine({ engine, sourceTag: TAG, sourceCommit: COMMIT, out, lockOut });
  return { engine, out, lockOut, lock };
}

test('#7955 a lock pins the tag release asset and every hash', () => {
  const good = { schema: 'ifc-lite.retained-engine-lock/1', sourceTag: TAG, sourceCommit: COMMIT, url: archiveUrl(TAG),
    archiveSha256: 'b'.repeat(64), archiveBytes: 10, engineManifestSha256: 'c'.repeat(64), sdkRevision: SDK };
  assert.deepEqual(lockProblems(good), []);
  assert.match(lockProblems({ ...good, url: 'https://example.com/engine.tar.gz' }).join(), /release asset/);
  assert.match(lockProblems({ ...good, sourceTag: 'main' }).join(), /vX\.Y\.Z/);
  assert.match(lockProblems({ ...good, archiveSha256: 'x' }).join(), /archiveSha256/);
  assert.equal(archiveUrl(TAG), `https://github.com/LTplus-AG/ifc-lite/releases/download/${TAG}/ifc-lite-retained-engine-${TAG}.tar.gz`);
});

test('#7955 the committed viewer lock pins a published release asset', () => {
  const path = join(REPO, 'apps/viewer/retained-engine.lock.json');
  assert.ok(existsSync(path), 'ifclite.com builds retained from apps/viewer/retained-engine.lock.json');
  const lock = readLock(path);
  assert.equal(lock.url, archiveUrl(lock.sourceTag), 'the lock names its own tag release asset');
  assert.equal(lock.sdkRevision, SDK, 'the lock was packed against the pinned SMLib SDK revision');
});

test('#7955 packing is deterministic and refuses notices that do not name the tag', t => {
  const root = scratch(t);
  const first = packed(sub(root, 'a'));
  const second = packed(sub(root, 'b'));
  assert.equal(first.lock.archiveSha256, second.lock.archiveSha256, 'same engine bytes, same archive');
  assert.equal(first.lock.sdkRevision, SDK);
  assert.deepEqual(lockProblems(JSON.parse(readFileSync(first.lockOut, 'utf8'))), []);
  assert.throws(() => packed(sub(root, 'c'), { tag: 'v9.9.9' }), /no covered-source URL/);
});

test('#7955 fetch verifies hash, inventory, notices and the API contract before handing out an engine', async t => {
  const root = scratch(t);
  const { out: archive, lockOut, lock } = packed(root);
  const repo = repoFixture(root);
  const engine = join(root, 'fetched');
  let requested;
  await fetchRetainedEngine({ lock: lockOut, out: engine, repo, get: async url => { requested = url; return readFileSync(archive); } });
  assert.equal(requested, lock.url, 'downloads exactly the pinned release asset');
  assert.equal(readFileSync(join(engine, 'pkg-retained/ifc-lite.d.ts'), 'utf8'), DTS);
  assert.deepEqual(contractProblems(engine, repo), []);

  const tampered = Buffer.from(readFileSync(archive)); tampered[tampered.length - 9] ^= 1;
  await assert.rejects(fetchRetainedEngine({ lock: lockOut, out: join(root, 'x'), repo, get: async () => tampered }), /does not match the lock/);
  assert.equal(existsSync(join(root, 'x')), false);

  const drifted = repoFixture(sub(root, 'drift'), DTS.replace('void', 'number'));
  await assert.rejects(fetchRetainedEngine({ lock: lockOut, out: join(root, 'y'), repo: drifted, archive }),
    error => error instanceof ContractMismatch && /differs from the checkout/.test(error.message));
  assert.equal(existsSync(join(root, 'y')), false, 'a mismatched engine is never handed out');
});

test('#7955 lazy-graph guard: retained code only behind dynamic imports', async t => {
  assert.deepEqual(staticImports('import{a}from"./x.js";import"./y.js";export*from"./w.js";()=>import("./lazy.js")'), ['./x.js', './y.js', './w.js']);
  const root = scratch(t);
  const graph = await checkRetainedLazy(distFixture(join(root, 'ok')));
  assert.deepEqual(graph.eager, ['assets/index-a.js', 'assets/shared-c.js', 'assets/vendor-b.js']);
  assert.deepEqual(graph.lazy, ['assets/retained-d.js']);
  await assert.rejects(checkRetainedLazy(distFixture(join(root, 'leak'), { leak: true })), /Startup chunk assets\/shared-c\.js contains \/smlib\/worker\.mjs/);
  const exact = distFixture(join(root, 'exact'));
  rmSync(join(exact, 'assets/retained-d.js'));
  await assert.rejects(checkRetainedLazy(exact), /not a VITE_RETAINED_GEOMETRY=lazy build/);
});

test('#7955 install + the repository vercel.json serve the engine isolated, typed, 404 on misses; production smoke helpers pass', async t => {
  const deferred = [];
  const root = scratch(t, deferred);
  const { out: archive, lockOut, lock } = packed(root);
  const engine = join(root, 'fetched');
  await fetchRetainedEngine({ lock: lockOut, out: engine, repo: repoFixture(root), archive });
  const site = join(root, 'site');
  const dist = distFixture(site);
  await assert.rejects(installRetainedEngine({ dist: distFixture(join(root, 'leaky'), { leak: true }), engine, lock: lockOut }), /Startup chunk/);
  assert.equal(existsSync(join(root, 'leaky/apps/viewer/dist/smlib')), false, 'nothing is copied into a leaking dist');
  const result = await installRetainedEngine({ dist, engine, lock: lockOut });
  assert.equal(result.lazyRetainedChunks, 1);
  assert.ok(existsSync(join(dist, 'smlib/worker.mjs')) && existsSync(join(dist, 'retained-engine/pkg-retained/ifc-lite.js')));
  await assert.rejects(installRetainedEngine({ dist, engine, lock: lockOut }), /already exists/);

  cpSync(join(REPO, 'vercel.json'), join(site, 'vercel.json'));
  const server = createPreviewServer(site, { production: true });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  deferred.push(() => new Promise(resolve => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const get = async path => {
    const response = await fetch(new URL(path, origin), { redirect: 'manual' });
    return { status: response.status, headers: Object.fromEntries([...response.headers].map(([k, v]) => [k.toLowerCase(), v])), body: await response.text() };
  };
  const worker = await get('/smlib/worker.mjs');
  assert.deepEqual(responseProblems({ url: '/smlib/worker.mjs', ...worker, expectType: /^text\/javascript\b/ }), []);
  const notice = await get('/retained-engine/LICENSES/SMLib/LICENSE');
  assert.deepEqual(responseProblems({ url: 'LICENSE', ...notice, expectType: /^text\/plain\b/ }), []);
  for (const missing of ['/retained-engine/LICENSES/missing', '/smlib/missing.mjs', '/retained-engine/pkg-retained/x']) {
    const response = await get(missing);
    assert.equal(response.status, 404, missing);
    assert.doesNotMatch(response.headers['content-type'] ?? '', /html/, `${missing} must not be the SPA`);
  }
  const route = await get('/some/route');
  assert.equal(route.status, 200);
  assert.equal(route.body, INDEX_HTML, 'app routes still fall back to index.html');
  assert.equal(route.headers['cross-origin-embedder-policy'], 'credentialless');

  const identity = await productionIdentity(origin, { sourceTag: TAG, lock: lockOut });
  assert.equal(identity.archiveSha256, lock.archiveSha256);
  assert.deepEqual(await startupGraph(origin), { startupChunks: 3 });
});
