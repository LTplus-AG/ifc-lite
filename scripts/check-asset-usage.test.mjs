/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Tests for scripts/lib/asset-usage.mjs, the detection logic behind
 * check-asset-usage.mjs (#4111). Runs entirely against synthetic asset/corpus
 * lists, never against this checkout's own apps/viewer/public, so a future
 * change to the repo's real assets can never make these vacuously pass —
 * same reasoning as check-refwalk-guards.test.mjs's synthetic Rust trees.
 *
 * Run: `node --test scripts/check-asset-usage.test.mjs`
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { findUnreferencedAssets } from './lib/asset-usage.mjs';

test('a file mentioned by basename elsewhere in the repo is referenced', () => {
  const { unreferenced } = findUnreferencedAssets({
    assetPaths: ['logo.png'],
    corpusFiles: [{ path: 'apps/viewer/src/App.tsx', content: 'src="/logo.png"' }],
    allowlist: [],
  });
  assert.deepEqual(unreferenced, []);
});

test('a file nothing mentions is reported unreferenced', () => {
  const { unreferenced } = findUnreferencedAssets({
    assetPaths: ['favicon-16x16.png'],
    corpusFiles: [{ path: 'apps/viewer/index.html', content: '<link href="/favicon-32x32.png">' }],
    allowlist: [],
  });
  assert.deepEqual(unreferenced, ['favicon-16x16.png']);
});

test('an allowlisted convention-fetched file with no reference is not reported', () => {
  const { unreferenced, allowlisted } = findUnreferencedAssets({
    assetPaths: ['favicon.ico', 'robots.txt'],
    corpusFiles: [{ path: 'apps/viewer/index.html', content: 'nothing here mentions either' }],
    allowlist: ['favicon.ico', 'robots.txt'],
  });
  assert.deepEqual(unreferenced, []);
  assert.deepEqual(allowlisted.sort(), ['favicon.ico', 'robots.txt']);
});

test('an allowlist row for a file that IS referenced does not suppress anything spuriously', () => {
  // Allowlisting a file that turns out to be referenced anyway is harmless —
  // referenced files are never reported regardless of the allowlist.
  const { unreferenced, allowlisted } = findUnreferencedAssets({
    assetPaths: ['manifest.json'],
    corpusFiles: [{ path: 'apps/viewer/index.html', content: '<link rel="manifest" href="/manifest.json">' }],
    allowlist: ['manifest.json'],
  });
  assert.deepEqual(unreferenced, []);
  assert.deepEqual(allowlisted, []); // referenced, so never even reaches the allowlist branch
});

test('a nested path is matched by its root-absolute form', () => {
  const { unreferenced } = findUnreferencedAssets({
    assetPaths: ['oauth/bcf/callback.html'],
    corpusFiles: [{ path: 'vercel.json', content: '"destination": "/oauth/bcf/callback.html"' }],
    allowlist: [],
  });
  assert.deepEqual(unreferenced, []);
});

test('a nested path is matched by its bare scan-relative form', () => {
  const { unreferenced } = findUnreferencedAssets({
    assetPaths: ['samples/hello-wall.ifc'],
    corpusFiles: [{ path: 'apps/viewer/src/samples.ts', content: "loadSample('samples/hello-wall.ifc')" }],
    allowlist: [],
  });
  assert.deepEqual(unreferenced, []);
});

test('empty asset list reports nothing (not a vacuous pass the CLI would hide)', () => {
  const { unreferenced, allowlisted } = findUnreferencedAssets({ assetPaths: [], corpusFiles: [], allowlist: [] });
  assert.deepEqual(unreferenced, []);
  assert.deepEqual(allowlisted, []);
});

test('a substring match inside an unrelated word still counts (permissive by design)', () => {
  // Documents the known false-negative direction: this is a substring search,
  // not a parsed reference graph, and it is meant to err this way — see the
  // "WHAT IT CANNOT SEE" note in check-asset-usage.mjs.
  const { unreferenced } = findUnreferencedAssets({
    assetPaths: ['icon.png'],
    corpusFiles: [{ path: 'notes.md', content: 'this word contains icon.png as a substring, not a real link' }],
    allowlist: [],
  });
  assert.deepEqual(unreferenced, []);
});
