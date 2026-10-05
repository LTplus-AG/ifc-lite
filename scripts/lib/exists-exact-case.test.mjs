/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Tests for scripts/lib/exists-exact-case.mjs. On a case-insensitive host (macOS
 * default) plain `existsSync('Deploy')` is true for `deploy/`; these assertions
 * hold on every host, and fail there if the helper regresses to `existsSync`.
 *
 * Run: `node --test scripts/lib/exists-exact-case.test.mjs`
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createExistsExactCase } from './exists-exact-case.mjs';

function withTree(fn) {
  const root = mkdtempSync(join(tmpdir(), 'exists-exact-case-'));
  try {
    mkdirSync(join(root, 'deploy', 'Nested'), { recursive: true });
    writeFileSync(join(root, 'README.md'), '');
    writeFileSync(join(root, 'deploy', 'Nested', 'File.txt'), '');
    fn(createExistsExactCase(root));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('a path that matches the file on disk exactly exists', () => {
  withTree((exists) => {
    assert.equal(exists('README.md'), true);
    assert.equal(exists('deploy'), true);
    assert.equal(exists('deploy/Nested/File.txt'), true);
    assert.equal(exists('./deploy/../README.md'), true);
  });
});

test('a path differing only by letter case does not exist, in any component', () => {
  withTree((exists) => {
    assert.equal(exists('readme.md'), false);
    assert.equal(exists('Deploy'), false);
    assert.equal(exists('deploy/nested/File.txt'), false);
    assert.equal(exists('deploy/Nested/file.txt'), false);
  });
});

test('a path that is absent altogether does not exist', () => {
  withTree((exists) => {
    assert.equal(exists('nope'), false);
    assert.equal(exists('deploy/Nested/File.txt/deeper'), false);
  });
});
