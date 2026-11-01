/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  PLACEHOLDER, REQUIRED_NOTICES, expectedType, fillSourceTag, headersFor, missingNotices, noticeSourceProblems,
  previewHostConfig, responseProblems, rewriteFor, servedEngineFiles,
} from './retained-preview.mjs';

const config = previewHostConfig();
const assets = paths => paths.map(path => ({ path }));

test('engine files map to the driver contract, as the dev middleware serves them', () => {
  const served = servedEngineFiles(assets(['smlib/worker.mjs', 'smlib/node/client.mjs', 'pkg-retained/ifc-lite.js',
    'LICENSES/SMLib/LICENSE', 'THIRD_PARTY_NOTICES.txt', 'stray.txt']));
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
