/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { sanitizeFilename } from './download.js';

describe('sanitizeFilename', () => {
  it('preserves uppercase letters (issue #1299)', () => {
    assert.strictEqual(sanitizeFilename('DRAWINGS'), 'DRAWINGS');
    assert.strictEqual(sanitizeFilename('MyList'), 'MyList');
  });

  it('preserves dot-separated classification codes (issue #1299)', () => {
    assert.strictEqual(sanitizeFilename('000.000'), '000.000');
    assert.strictEqual(sanitizeFilename('DOC 000.000 REV-A'), 'DOC 000.000 REV-A');
  });

  it('keeps underscores, hyphens and spaces', () => {
    assert.strictEqual(sanitizeFilename('A_B-C D'), 'A_B-C D');
  });

  it('replaces path separators and reserved characters with a hyphen', () => {
    assert.strictEqual(sanitizeFilename('a/b\\c'), 'a-b-c');
    assert.strictEqual(sanitizeFilename('a:b*c?d'), 'a-b-c-d');
  });

  it('collapses whitespace runs to a single space', () => {
    assert.strictEqual(sanitizeFilename('a   b\t c'), 'a b c');
  });

  it('trims leading/trailing separators and dots', () => {
    assert.strictEqual(sanitizeFilename('  .name.  '), 'name');
    assert.strictEqual(sanitizeFilename('---x---'), 'x');
  });

  it('keeps leading/trailing underscores (only space/dot/hyphen are trimmed)', () => {
    assert.strictEqual(sanitizeFilename('_my_list_'), '_my_list_');
  });

  it('keeps non-ASCII letters', () => {
    assert.strictEqual(sanitizeFilename('Brücke Ö'), 'Brücke Ö');
  });

  it('uses the provided fallback for empty or fully-stripped input', () => {
    assert.strictEqual(sanitizeFilename(''), 'file');
    assert.strictEqual(sanitizeFilename('   '), 'file');
    assert.strictEqual(sanitizeFilename('***'), 'file');
    assert.strictEqual(sanitizeFilename('', { fallback: 'list' }), 'list');
    assert.strictEqual(sanitizeFilename('***', { fallback: 'model' }), 'model');
  });

  it('caps the length at maxLength (default 60)', () => {
    assert.strictEqual(sanitizeFilename('X'.repeat(100)).length, 60);
    assert.strictEqual(sanitizeFilename('X'.repeat(100), { maxLength: 40 }).length, 40);
  });
});
