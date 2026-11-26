/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { sanitizeFilename, buildExportFilename, modelExportFilename, stripExtension } from './download.js';

describe('sanitizeFilename', () => {
  it('prefixes Windows reserved device names, with or without an extension part', () => {
    assert.strictEqual(sanitizeFilename('CON'), '_CON');
    assert.strictEqual(sanitizeFilename('nul'), '_nul');
    assert.strictEqual(sanitizeFilename('Com1.model'), '_Com1.model');
    assert.strictEqual(sanitizeFilename('NUL .model'), '_NUL .model');
    assert.strictEqual(modelExportFilename('AUX.ifc', 'pdf'), '_AUX.pdf');
    assert.strictEqual(sanitizeFilename('CONSTRUCTION'), 'CONSTRUCTION');
    assert.strictEqual(sanitizeFilename('COM10'), 'COM10');
  });

  it('never leaves half a surrogate pair when truncating (#11442)', () => {
    const name = `${'a'.repeat(59)}\u{20000}\u{20000}`;
    const out = sanitizeFilename(name);
    assert.strictEqual(out, 'a'.repeat(59));
  });

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

describe('stripExtension', () => {
  it('drops the last extension only and leaves a dotless name alone', () => {
    assert.strictEqual(stripExtension('model.ifc'), 'model');
    assert.strictEqual(stripExtension('a.b.ifczip'), 'a.b');
    assert.strictEqual(stripExtension('my model.ifc'), 'my model');
    assert.strictEqual(stripExtension('noext'), 'noext');
  });

  // #4444: a room recipient's second copy of one file is listed as
  // "name.ifc (2)". Stripping ".ifc (2)" as one extension made both copies
  // export under the same filename; the copy suffix has to survive.
  it('keeps a copy suffix that follows the extension', () => {
    assert.strictEqual(stripExtension('AC20-FZK-Haus.ifc (2)'), 'AC20-FZK-Haus (2)');
    assert.strictEqual(stripExtension('model.ifc (12)'), 'model (12)');
    assert.strictEqual(stripExtension('Haus (2)'), 'Haus (2)');
    assert.notStrictEqual(stripExtension('AC20-FZK-Haus.ifc (2)'), stripExtension('AC20-FZK-Haus.ifc'));
  });
});

/**
 * #5833: the one name every model export downloads under, whichever surface
 * started it.
 */
describe('modelExportFilename', () => {
  it('drops the source extension and appends the suffix and the export extension', () => {
    assert.equal(modelExportFilename('Haus.ifc', 'glb'), 'Haus.glb');
    assert.equal(modelExportFilename('Haus.ifc', '.glb', '_visible'), 'Haus_visible.glb');
    assert.equal(modelExportFilename('AC20-FZK-Haus.ifczip', 'csv', '_entities'), 'AC20-FZK-Haus_entities.csv');
  });

  it('keeps a copy suffix, so two copies of one file download under two names (#4444)', () => {
    assert.equal(modelExportFilename('Haus.ifc (2)', 'kmz'), 'Haus -2.kmz');
  });

  it('falls back to "model" for a name with nothing usable in it', () => {
    assert.equal(modelExportFilename('', 'glb'), 'model.glb');
    assert.equal(modelExportFilename('???.ifc', 'glb'), 'model.glb');
  });

  it('truncates a long model name before the suffix, keeping suffix and extension', () => {
    const result = modelExportFilename(`${'a'.repeat(80)}.ifc`, 'ifc', '_visible');
    assert.ok(result.endsWith('_visible.ifc'), result);
    assert.ok(result.length <= 60, `${result} is ${result.length} chars`);
  });
});

describe('reserved-name prefix stays inside the length cap (#11442)', () => {
  it('keeps the fallback safe and nonempty when the length is NaN (#11442)', () => {
    assert.strictEqual(sanitizeFilename('CON', { maxLength: NaN }), 'file');
    assert.strictEqual(sanitizeFilename('model', { maxLength: NaN, fallback: 'NUL.txt' }), '_NUL.txt');
    assert.equal(sanitizeFilename('CON', { maxLength: NaN, fallback: 'x'.repeat(80) }).length, 60);
  });

  it('fits the fallback when a supplementary letter cannot fit the stem budget', () => {
    const name = '\u{20000}';
    assert.strictEqual(sanitizeFilename(name, { maxLength: 1 }), 'f');
    assert.strictEqual(buildExportFilename(name, 'csv', 5), 'f.csv');
    assert.strictEqual(sanitizeFilename(name, { maxLength: 1, fallback: name }), '_');
  });

  it('sanitizeFilename never exceeds maxLength once the prefix is added', () => {
    assert.strictEqual(sanitizeFilename('CON', { maxLength: 3 }), '_CO');
    const out = sanitizeFilename(`CON.${'x'.repeat(100)}`);
    assert.ok(out.length <= 60 && out.startsWith('_CON.'), `${out} is ${out.length}`);
  });

  it('buildExportFilename keeps the whole name within the cap', () => {
    const out = buildExportFilename(`CON.${'x'.repeat(100)}`, 'csv');
    assert.ok(out.length <= 60 && out.endsWith('.csv'), `${out} is ${out.length}`);
  });

  it('modelExportFilename keeps the full suffix', () => {
    const out = modelExportFilename(`NUL.${'y'.repeat(100)}.ifc`, 'glb', '_visible');
    assert.ok(out.endsWith('_visible.glb'), out);
    assert.ok(out.length <= 60, `${out} is ${out.length}`);
    assert.ok(out.startsWith('_NUL.'), out);
  });

  it('never prefixes an extension, only the stem', () => {
    assert.strictEqual(buildExportFilename('x', 'prn'), 'x.prn');
    assert.strictEqual(buildExportFilename('report', '.CON'), 'report.CON');
  });

  it('treats superscript-digit COM/LPT names as reserved', () => {
    for (const n of ['COM¹', 'COM²', 'COM³', 'LPT¹', 'LPT²', 'LPT³']) {
      assert.strictEqual(sanitizeFilename(n), `_${n}`);
    }
  });
});
