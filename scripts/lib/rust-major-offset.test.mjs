/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
/**
 * Unit tests for the Rust major-offset arithmetic and its readers.
 *
 * The gate's own end-to-end behaviour over synthetic trees lives in
 * scripts/check-rust-major-offset.test.mjs; this file covers the pieces both
 * that gate and `scripts/sync-versions.js` compute FROM, which is the pair
 * that must never disagree.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  applyMajorOffset,
  computeReleaseVersions,
  MIN_WORKSPACE_PACKAGES,
  parseSemver,
  readMajorOffset,
  scanWorkspaceVersions,
} from './rust-major-offset.mjs';

/** A tree with `count` public workspace packages, the highest at `maxVersion`. */
function makeTree(t, { offsetFile, maxVersion = '6.0.1', count = MIN_WORKSPACE_PACKAGES + 2, rootVersion } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'rust-major-offset-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'root', version: rootVersion ?? maxVersion }));
  mkdirSync(join(root, 'packages'));
  for (let i = 0; i < count; i++) {
    const dir = join(root, 'packages', `p${i}`);
    mkdirSync(dir);
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ name: `@ifc-lite/p${i}`, version: i === 0 ? maxVersion : '0.1.0' })
    );
  }
  if (offsetFile !== undefined) {
    writeFileSync(join(root, 'rust-major-offset.json'), offsetFile);
  }
  return root;
}

const VALID_OFFSET_1 = JSON.stringify({
  majorOffset: 1,
  reason: 'ifc-lite-processing MeshData gained a public field (#3210), which is a breaking Rust change under an npm minor.',
  refs: ['#3210', '#3216'],
});

test('applyMajorOffset shifts only the major, leaving minor and patch on npm', () => {
  assert.equal(applyMajorOffset('6.1.0', 1), '7.1.0');
  assert.equal(applyMajorOffset('6.0.1', 0), '6.0.1');
  assert.equal(applyMajorOffset('6.0.1', 2), '8.0.1');
});

test('applyMajorOffset refuses a version it cannot parse rather than producing NaN', () => {
  assert.throws(() => applyMajorOffset('6.1', 1), (err) => err.code === 'BAD_VERSION');
  assert.throws(() => applyMajorOffset('', 1), (err) => err.code === 'BAD_VERSION');
  assert.throws(() => applyMajorOffset('6.0.1-rc.1', 1), (err) => err.code === 'BAD_VERSION');
});

test('parseSemver accepts a plain triple and nothing else', () => {
  assert.deepEqual(parseSemver('10.20.30'), { major: 10, minor: 20, patch: 30 });
  assert.equal(parseSemver('1.2'), null);
  assert.equal(parseSemver('v1.2.3'), null);
  assert.equal(parseSemver(undefined), null);
});

test('readMajorOffset fails closed when the file is absent', (t) => {
  const root = makeTree(t, {});
  assert.throws(() => readMajorOffset(root), (err) => err.code === 'NO_OFFSET_FILE');
});

test('readMajorOffset fails closed on an empty or unparseable file', (t) => {
  assert.throws(() => readMajorOffset(makeTree(t, { offsetFile: '' })), (err) => err.code === 'BAD_JSON');
  assert.throws(() => readMajorOffset(makeTree(t, { offsetFile: '{oops' })), (err) => err.code === 'BAD_JSON');
});

test('readMajorOffset rejects an offset that is not a non-negative integer', (t) => {
  for (const bad of [{}, { majorOffset: '1' }, { majorOffset: -1 }, { majorOffset: 1.5 }, { majorOffset: null }]) {
    assert.throws(
      () => readMajorOffset(makeTree(t, { offsetFile: JSON.stringify(bad) })),
      (err) => err.code === 'BAD_OFFSET',
      `expected BAD_OFFSET for ${JSON.stringify(bad)}`
    );
  }
});

test('a non-zero offset must carry a reason and at least one ref', (t) => {
  assert.throws(
    () => readMajorOffset(makeTree(t, { offsetFile: JSON.stringify({ majorOffset: 1, refs: ['#1'] }) })),
    (err) => err.code === 'NO_REASON'
  );
  assert.throws(
    () => readMajorOffset(makeTree(t, { offsetFile: JSON.stringify({ majorOffset: 1, reason: 'x', refs: ['#1'] }) })),
    (err) => err.code === 'NO_REASON'
  );
  assert.throws(
    () =>
      readMajorOffset(
        makeTree(t, { offsetFile: JSON.stringify({ majorOffset: 1, reason: 'a'.repeat(40), refs: [] }) })
      ),
    (err) => err.code === 'NO_REFS'
  );
});

test('offset 0 needs no reason — there is nothing to justify', (t) => {
  const root = makeTree(t, { offsetFile: JSON.stringify({ majorOffset: 0 }) });
  assert.equal(readMajorOffset(root).majorOffset, 0);
});

test('scanWorkspaceVersions refuses a scan that found (almost) nothing', (t) => {
  const root = makeTree(t, { offsetFile: VALID_OFFSET_1, count: 1 });
  assert.throws(() => scanWorkspaceVersions(root), (err) => err.code === 'PACKAGE_FLOOR');
});

test('computeReleaseVersions keeps npm on its own version and lifts only the crates', (t) => {
  const root = makeTree(t, { offsetFile: VALID_OFFSET_1, maxVersion: '6.1.0' });
  const got = computeReleaseVersions(root);
  assert.equal(got.npmVersion, '6.1.0');
  assert.equal(got.crateVersion, '7.1.0');
  assert.equal(got.majorOffset, 1);
  assert.ok(got.scanned >= MIN_WORKSPACE_PACKAGES);
});

test('computeReleaseVersions still takes the highest version, root package included', (t) => {
  const root = makeTree(t, { offsetFile: JSON.stringify({ majorOffset: 0 }), maxVersion: '6.0.1', rootVersion: '9.9.9' });
  assert.equal(computeReleaseVersions(root).npmVersion, '9.9.9');
  assert.equal(computeReleaseVersions(root).crateVersion, '9.9.9');
});

test('a private package cannot drag the release version up', (t) => {
  const root = makeTree(t, { offsetFile: JSON.stringify({ majorOffset: 0 }) });
  const dir = join(root, 'packages', 'secret');
  mkdirSync(dir);
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'secret', private: true, version: '99.0.0' }));
  assert.equal(computeReleaseVersions(root).npmVersion, '6.0.1');
});
