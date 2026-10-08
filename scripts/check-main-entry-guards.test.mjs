/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Tests for scripts/lib/main-entry-guards.mjs, the detector behind
 * check-main-entry-guards.mjs. Synthetic sources only.
 *
 * Run: `node --test scripts/check-main-entry-guards.test.mjs`
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findHandRolledMainGuards } from './lib/main-entry-guards.mjs';

const scan = (src, file = 'scripts/x.mjs') => findHandRolledMainGuards([file], () => src);

// The template-literal spelling of the bad guard, as SOURCE TEXT for the
// scanner. Assembled so that no string in this file carries a literal
// placeholder, which the linter rightly reads as a forgotten template string.
const FILE_URL_OF = (argv) => 'file://$' + `{${argv}}`;

test('flags every hand-rolled shape that this repo actually carried', () => {
  const shapes = [
    "if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();",
    "if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {",
    "if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {",
    "if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {",
    "if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {",
    'const isMain = process.argv[1] && import.meta.url === `' + FILE_URL_OF('process.argv[1]') + '`;',
  ];
  for (const shape of shapes) assert.equal(scan(shape).length, 1, shape);
});

test('accepts isMainEntry, an endsWith guard, and comments that quote the bad shape', () => {
  assert.deepEqual(scan("if (isMainEntry(import.meta.url)) main();"), []);
  assert.deepEqual(scan("if (process.argv[1] && process.argv[1].endsWith('x.mjs')) main();"), []);
  assert.deepEqual(scan('// not `import.meta.url === `' + FILE_URL_OF('process.argv[1]') + '``, see is-main-entry'), []);
  assert.deepEqual(scan(' * `import.meta.url === ' + FILE_URL_OF('argv[1]') + '` is wrong'), []);
});

test('a realpath around only the module path does not exempt the guard (#7025 review)', () => {
  assert.equal(scan('if (process.argv[1] === realpathSync(fileURLToPath(import.meta.url))) main();').length, 1);
  assert.equal(scan('if (realpathSync(\n  fileURLToPath(import.meta.url)\n) === process.argv[1]) main();').length, 1);
  // Resolving argv is what matters: node has already resolved import.meta.url.
  assert.deepEqual(scan('if (realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) main();'), []);
  assert.deepEqual(scan('if (realpathSync(resolve(process.argv[1])) === fileURLToPath(import.meta.url)) main();'), []);
});

test('accepts a comparison that realpaths both sides', () => {
  assert.deepEqual(scan('process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));'), []);
});

test('ignores non-source files, test files and the helper itself', () => {
  const bad = "if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();";
  assert.deepEqual(scan(bad, 'docs/notes.md'), []);
  assert.deepEqual(scan(bad, 'scripts/lib/is-main-entry.mjs'), []);
  assert.deepEqual(scan(bad, 'scripts/lib/is-main-entry.test.mjs'), []);
});

test('reports file and 1-based line', () => {
  const hits = scan("a();\nb();\nif (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();");
  assert.equal(hits[0].line, 3);
  assert.equal(hits[0].file, 'scripts/x.mjs');
});

test('flags a guard split over several lines and the argv.at(1) spelling', () => {
  const split = "if (\n  process.argv[1] ===\n  fileURLToPath(import.meta.url)\n) main();";
  assert.equal(scan(split).length, 1);
  assert.equal(scan("if (process.argv.at(1) === fileURLToPath(import.meta.url)) main();").length, 1);
});

test('flags a guard a formatter has broken into one token per line (#7025 review)', () => {
  const broken = "if (process.argv[1] && resolve(\n  process.argv[1]\n)\n===\nfileURLToPath(import.meta.url)) main();";
  assert.equal(scan(broken).length, 1);
  const wide = "const isMain =\n  process.argv[1] !== undefined\n  && pathToFileURL(\n    process.argv[1],\n  ).href\n  ===\n  import.meta.url;";
  assert.equal(scan(wide).length, 1);
  // The statement ends at its terminator: a location comparison in the NEXT statement is unrelated.
  assert.deepEqual(scan("const a = process.argv[1];\n\n\nif (import.meta.url === other) {}"), []);
});

test('a multi-line guard that routes through isMainEntry or realpath is accepted', () => {
  assert.deepEqual(scan("if (\n  process.argv[1] &&\n  isMainEntry(import.meta.url) === true\n) main();"), []);
  assert.deepEqual(scan("const a = process.argv[1];\nif (realpathSync(a) === realpathSync(fileURLToPath(import.meta.url))) main();"), []);
});

test('argv use far from any self-location comparison is not flagged', () => {
  const src = "const [, , cmd] = process.argv;\nconst x = process.argv[1];\nlet a;\nlet b;\nlet c;\nif (import.meta.url === other) {}";
  assert.deepEqual(scan(src), []);
});

test('a commented-out guard next to live code that compares a location is not flagged', () => {
  // The argv mention is prose; the live line beside it compares import.meta.url with something else.
  const src = "// was: process.argv[1] === fileURLToPath(import.meta.url)\nif (import.meta.url === expectedUrl) register();";
  assert.deepEqual(scan(src), []);
});

test('comparing argv[1] with something that is not the module location is not flagged', () => {
  assert.deepEqual(scan("if (process.argv[1] === '--help') usage();"), []);
  assert.deepEqual(scan("const same = process.argv[1] === other.path;"), []);
});


test('a comment mentioning the helper cannot exempt a broken guard (#7025 review)', () => {
  assert.equal(scan('if (process.argv[1] === fileURLToPath(import.meta.url)) main(); // TODO: use isMainEntry').length, 1);
  assert.equal(scan('if (process.argv[1] /* isMainEntry */ === fileURLToPath(import.meta.url)) main();').length, 1);
});

test('a realpath path cannot be directly compared with a module URL (#7025 review)', () => {
  assert.equal(scan('if (realpathSync(process.argv[1]) === import.meta.url) main();').length, 1);
});

test('the command checks tracked paths outside its current directory (#7025 review)', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'main-guard-cwd-'));
  t.after(() => rmSync(root, {recursive:true,force:true}));
  const scripts = dirname(fileURLToPath(import.meta.url));
  mkdirSync(join(root, 'scripts/lib'), {recursive:true});
  mkdirSync(join(root, 'tools'), {recursive:true});
  for (const file of ['check-main-entry-guards.mjs', 'lib/main-entry-guards.mjs', 'lib/overlay-palette.mjs']) {
    cpSync(join(scripts,file),join(root,'scripts',file));
  }
  writeFileSync(join(root,'tools/broken.mjs'), 'if (process.argv[1] === fileURLToPath(import.meta.url)) main();');
  for (const args of [['init','-q'],['add','.']]) {
    assert.equal(spawnSync('git',args,{cwd:root}).status,0);
  }
  const run = spawnSync(process.execPath,['check-main-entry-guards.mjs'],{cwd:join(root,'scripts'),encoding:'utf8'});
  assert.equal(run.status,1,run.stdout+run.stderr);
  assert.match(run.stderr,/tools\/broken.mjs/);
});
