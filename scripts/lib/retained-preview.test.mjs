/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { plan, deploy } from '../deploy-retained-preview.mjs';
import { test } from 'node:test';
import {
  assertManifestIdentity, PLACEHOLDER, REQUIRED_NOTICES, expectedType, fillSourceTag, headersFor, missingNotices, noticeSourceProblems,
  previewHostConfig, responseProblems, rewriteFor, servedEngineFiles,
} from './retained-preview.mjs';

const config = previewHostConfig();
const assets = paths => paths.map(path => ({ path }));

test('engine files map to the driver contract, as the dev middleware serves them', () => {
  const served = servedEngineFiles(assets(['smlib/worker.mjs', 'smlib/node/client.mjs', 'pkg-retained/ifc-lite.js',
    'LICENSES/SMLib/LICENSE', 'THIRD_PARTY_NOTICES.txt']));
  assert.deepEqual(served.map(f => f.url), ['/retained-engine/engine-manifest.json', '/smlib/worker.mjs', '/smlib/node/client.mjs',
    '/retained-engine/pkg-retained/ifc-lite.js', '/retained-engine/LICENSES/SMLib/LICENSE', '/retained-engine/THIRD_PARTY_NOTICES.txt']);
  for (const bad of ['../x', 'smlib/../../x', 'a//b', 'smlib\\x']) assert.throws(() => servedEngineFiles(assets([bad])), /Unsafe/);
});

test('a missing notice is named; the full set is complete', () => {
  assert.deepEqual(missingNotices(assets(REQUIRED_NOTICES)), []);
  assert.deepEqual(missingNotices(assets(REQUIRED_NOTICES.filter(p => p !== 'smlib/LICENSE'))), ['smlib/LICENSE']);
});

test('notice source URL: exact tag required, placeholder always reported', () => {
  const template = `IFC-Lite covered source is available under MPL-2.0 at ${PLACEHOLDER}.\nRelease owner: replace <tag> before staging.\n`;
  const filled = fillSourceTag(template, 'v27.1.1');
  assert.deepEqual(noticeSourceProblems(filled, 'v27.1.1'), []);
  assert.match(noticeSourceProblems(filled, 'v27.1.2').join(), /no covered-source URL/);
  assert.match(noticeSourceProblems(template, 'v27.1.1').join(), /placeholder/);
  assert.match(noticeSourceProblems(template, undefined).join(), /placeholder/);
  assert.match(noticeSourceProblems(filled, 'main').join(), /not a root/);
  assert.throws(() => fillSourceTag(template, 'server-v1.0.0'), /not a root/);
  assert.throws(() => fillSourceTag('no url', 'v1.2.3'), /placeholder/);
});

test('every response is cross-origin isolated; engine MIME types are explicit', () => {
  for (const path of ['/', '/index.html', '/smlib/worker.mjs', '/retained-engine/LICENSES/ifc-lite/LICENSE', '/nope']) {
    const h = headersFor(config, path);
    assert.equal(h['Cross-Origin-Opener-Policy'], 'same-origin', path);
    assert.equal(h['Cross-Origin-Embedder-Policy'], 'credentialless', path);
    assert.equal(h['X-Content-Type-Options'], 'nosniff', path);
  }
  assert.equal(headersFor(config, '/smlib/ifclite_smlib_browser.wasm')['Content-Type'], 'application/wasm');
  assert.match(headersFor(config, '/retained-engine/pkg-retained/ifc-lite.js')['Content-Type'], /^text\/javascript/);
  assert.match(headersFor(config, '/retained-engine/LICENSES/SMLib/LICENSE')['Content-Type'], /^text\/plain/);
  assert.match(headersFor(config, '/smlib/LICENSE')['Content-Type'], /^text\/plain/);
  assert.equal(headersFor(config, '/smlib/worker.mjs')['Cache-Control'], 'no-cache');
});

test('the SPA fallback never answers an engine URL', () => {
  assert.equal(rewriteFor(config, '/'), '/index.html');
  assert.equal(rewriteFor(config, '/some/route'), '/index.html');
  for (const path of ['/smlib/worker.mjs', '/retained-engine/LICENSES/missing', '/retained-engine/pkg-retained/x', '/assets/a.js']) {
    assert.equal(rewriteFor(config, path), null, path);
  }
});

test('nothing builds on the host and production config is not reused', () => {
  assert.equal(config.buildCommand, 'true');
  assert.equal(config.installCommand, 'true');
  assert.equal(config.ignoreCommand, 'exit 1', 'a dashboard Ignored Build Step must not cancel the preview');
  assert.equal(config.framework, null);
  assert.equal(config.outputDirectory, 'public');
  assert.equal(JSON.stringify(config).includes('railway.app'), false);
});

test('response problems name status, isolation and type', () => {
  const ok = { 'cross-origin-opener-policy': 'same-origin', 'cross-origin-embedder-policy': 'credentialless', 'x-content-type-options': 'nosniff',
    'content-type': 'application/wasm' };
  assert.deepEqual(responseProblems({ url: '/a.wasm', status: 200, headers: ok, expectType: expectedType('/a.wasm') }), []);
  const bad = responseProblems({ url: '/a.wasm', status: 404, headers: { 'content-type': 'text/html' }, expectType: expectedType('/a.wasm') });
  assert.equal(bad.length, 5);
  assert.match(expectedType('/x/LICENSE').source, /text/);
});

// PR #8550 review regressions: exact source identity, real tags, and deploy refusal.
test('source notice rejects tag prefixes, suffixes and subpaths', () => {
  for (const suffix of ['0', '-rc1', '/other', '?other', '#other']) {
    assert.match(noticeSourceProblems(`https://github.com/LTplus-AG/ifc-lite/tree/v27.1.1${suffix}`, 'v27.1.1').join(), /no covered-source URL/);
  }
  assert.deepEqual(noticeSourceProblems('Source: https://github.com/LTplus-AG/ifc-lite/tree/v27.1.1.', 'v27.1.1'), []);
});

test('served manifest must match preview identity even without an explicit pin', () => {
  const identity = { engineManifestSha256: 'engine-A' };
  assert.doesNotThrow(() => assertManifestIdentity(identity, 'engine-A'));
  assert.throws(() => assertManifestIdentity(identity, 'engine-B'), /preview identity/);
  assert.throws(() => assertManifestIdentity(null, 'engine-B'), /preview identity/);
  assert.throws(() => assertManifestIdentity(identity, 'engine-A', 'engine-B'), /expected/);
});

test('release build refuses a branch with the release tag name before building', () => {
  const dir = mkdtempSync(join(tmpdir(), 'retained-tag-'));
  try {
    mkdirSync(join(dir, 'scripts'));
    cpSync(new URL('../build-retained-preview.sh', import.meta.url), join(dir, 'scripts/build-retained-preview.sh'));
    writeFileSync(join(dir, 'scripts/retained-notices.mjs'), 'process.exit(0);');
    const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
    git('init', '--initial-branch=v27.1.1');
    git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-m', 'fixture');
    const result = spawnSync('bash', ['scripts/build-retained-preview.sh', '--sdk', '/unused-sdk', '--emsdk', '/unused-emsdk',
      '--work', join(dir, 'work'), '--source-tag', 'v27.1.1'], { cwd: dir, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: dir } });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /HEAD is not v27.1.1/);
    assert.doesNotMatch(result.stdout + result.stderr, /pnpm|cmake/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('deploy refuses a rehearsal before reading credentials or making requests', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'retained-deploy-'));
  try {
    mkdirSync(join(dir, 'public'));
    writeFileSync(join(dir, 'public/retained-preview.json'), JSON.stringify({ schema: 'ifc-lite.retained-preview/1', publishable: false }));
    assert.throws(() => plan(dir, 'v27.1.1'), /rehearsal build/);
    await assert.rejects(deploy({ dir, sourceTag: 'v27.1.1', dryRun: true }), /rehearsal build/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('deploy uses bodyless GET polling and never includes an API response in errors', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'retained-api-'));
  try {
    mkdirSync(join(dir, 'public'));
    writeFileSync(join(dir, 'public/retained-preview.json'), JSON.stringify({ schema: 'ifc-lite.retained-preview/1', publishable: true, sourceTag: 'v27.1.1' }));
    writeFileSync(join(dir, 'vercel.json'), '{}');
    const requests = [];
    t.mock.method(globalThis, 'fetch', async (url, options) => {
      requests.push({ url, options });
      if (url.includes('/v13/deployments?')) return new Response(JSON.stringify({ id: 'fixture', url: 'fixture.invalid', readyState: 'QUEUED' }));
      if (options.method === 'GET') return new Response(JSON.stringify({ readyState: 'READY' }));
      return new Response('{}');
    });
    t.mock.method(globalThis, 'setTimeout', fn => { queueMicrotask(fn); return 0; });
    const result = await deploy({ dir, sourceTag: 'v27.1.1', token: 'fixture-credential' });
    assert.equal(result.target, 'preview');
    const poll = requests.find(({ options }) => options.method === 'GET');
    assert.ok(poll);
    assert.equal(Object.hasOwn(poll.options, 'body'), false);
    const creation = requests.find(({ url }) => url.includes('/v13/deployments?'));
    assert.equal(Object.hasOwn(JSON.parse(creation.options.body), 'target'), false);
    globalThis.fetch = async () => new Response('fixture-credential', { status: 401 });
    await assert.rejects(deploy({ dir, sourceTag: 'v27.1.1', token: 'fixture-credential' }), error => {
      assert.match(error.message, /HTTP 401/);
      assert.doesNotMatch(error.message, /fixture-credential/);
      return true;
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// PR #8550: a manifest entry must never disappear from builder/smoke coverage.
test('8550: an unsupported manifest asset fails closed rather than being omitted', () => {
  assert.throws(() => servedEngineFiles(assets(['smlib/worker.mjs', 'stray.txt'])), /Unsupported engine asset path.*stray\.txt/);
});
