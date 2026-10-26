/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { withRestoredSource } from './restored-source.mjs';

test('qualification restores exact bytes after success or failure (#8133)', () => {
  const root = mkdtempSync(join(tmpdir(), 'restored-source-')), path = join(root, 'source');
  const original = Buffer.from([0, 255, 13, 10]), failure = new Error('witness failed');
  try {
    writeFileSync(path, original);
    assert.equal(withRestoredSource(path, () => { writeFileSync(path, 'mutant'); return 42; }), 42);
    assert.deepEqual(readFileSync(path), original);
    assert.throws(() => withRestoredSource(path, () => {
      writeFileSync(path, 'mutant'); throw failure;
    }), error => error === failure);
    assert.deepEqual(readFileSync(path), original);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('restoration failures remain visible alongside qualification failures (#8133)', () => {
  const root = mkdtempSync(join(tmpdir(), 'restored-source-')), path = join(root, 'source');
  const failure = new Error('witness failed');
  try {
    for (const operationFails of [false, true]) {
      rmSync(path, { recursive: true, force: true }); writeFileSync(path, 'original');
      assert.throws(() => withRestoredSource(path, () => {
        rmSync(path); mkdirSync(path);
        if (operationFails) throw failure;
      }), error => operationFails
        ? error instanceof AggregateError && error.errors[0] === failure && error.errors[1].code === 'EISDIR'
        : error.code === 'EISDIR');
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
