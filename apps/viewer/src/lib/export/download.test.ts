/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { sanitizeFilename, buildExportFilename } from './download.js';

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

/**
 * Regression coverage for `buildExportFilename` (#1930 review): the download
 * filename must keep the exporter's extension even when the base name is
 * long enough to hit `sanitizeFilename`'s default 60-char cap, and the
 * total length must never exceed `maxLength` even for a pathological
 * extension string.
 */
describe('buildExportFilename', () => {
  it('joins a short base name and extension unchanged', () => {
    assert.equal(buildExportFilename('model', 'csv'), 'model.csv');
  });

  it('normalises an extension without a leading dot', () => {
    assert.equal(buildExportFilename('model', 'csv'), buildExportFilename('model', '.csv'));
  });

  // The bug: sanitizing `${baseName}${ext}` as one string, THEN slicing to
  // maxLength, truncates from the right and can cut the extension off
  // entirely for a long model name. Budgeting the stem so `stem.ext` fits
  // must always leave the extension intact.
  it('keeps the extension intact when the base name alone would exceed maxLength', () => {
    const longName = 'a'.repeat(80);
    const result = buildExportFilename(longName, 'csv', 60);

    assert.ok(result.endsWith('.csv'), `expected ${result} to end with .csv`);
    assert.ok(result.length <= 60, `expected ${result} length <= 60, got ${result.length}`);
  });

  it('keeps a longer extension intact too, budgeting the stem around it', () => {
    const longName = 'building-architecture-full-federated-export-name'.repeat(3);
    const result = buildExportFilename(longName, 'ifcxml', 60);

    assert.ok(result.endsWith('.ifcxml'), `expected ${result} to end with .ifcxml`);
    assert.ok(result.length <= 60, `expected ${result} length <= 60, got ${result.length}`);
  });

  it('still routes both the stem and extension through sanitizeFilename', () => {
    // Path separators and control-ish characters are OS-unsafe in either half.
    const result = buildExportFilename('some/model:name', 'c/sv');
    assert.ok(!result.includes('/'), `expected ${result} to have no path separators`);
    assert.ok(!result.includes(':'), `expected ${result} to have no colon`);
  });

  // A pathological (or malicious) extension can't be allowed to consume the
  // whole maxLength budget and push the total past it — that was reported
  // against the first version of this helper: `buildExportFilename('model',
  // 'x'.repeat(80), 60)` came back at length 62, violating its own contract.
  it('never exceeds maxLength even when the extension itself is absurdly long', () => {
    const result = buildExportFilename('model', 'x'.repeat(80), 60);

    assert.ok(result.length <= 60, `expected ${result} length <= 60, got ${result.length}`);
    // The stem must still get a meaningful, non-empty budget.
    assert.ok(!result.startsWith('.'), `expected a non-empty stem, got ${result}`);
  });
});
