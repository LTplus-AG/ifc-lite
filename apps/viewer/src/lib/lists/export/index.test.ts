/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { sanitizeFilename } from './index.js';

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

  it('replaces path separators and reserved characters', () => {
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

  it('falls back to "list" for empty or all-stripped input', () => {
    assert.strictEqual(sanitizeFilename(''), 'list');
    assert.strictEqual(sanitizeFilename('   '), 'list');
    assert.strictEqual(sanitizeFilename('***'), 'list');
  });

  it('caps the length at 60 characters', () => {
    const long = 'X'.repeat(100);
    assert.strictEqual(sanitizeFilename(long).length, 60);
  });

  it('keeps non-ASCII letters', () => {
    assert.strictEqual(sanitizeFilename('Brücke Ö'), 'Brücke Ö');
  });
});
