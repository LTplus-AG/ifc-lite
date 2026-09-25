#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Regression harness for scripts/check-native-dialogs.mjs (#5813).
 * Black-box: the CLI runs with `spawnSync` against a synthetic source tree,
 * so nothing here reads the checker's own source.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const CHECKER = join(dirname(fileURLToPath(import.meta.url)), 'check-native-dialogs.mjs');

function withTree(files, fn) {
  const root = mkdtempSync(join(tmpdir(), 'native-dialogs-'));
  try {
    const src = join(root, 'apps', 'viewer', 'src');
    for (const [rel, body] of Object.entries(files)) {
      mkdirSync(dirname(join(src, rel)), { recursive: true });
      writeFileSync(join(src, rel), body);
    }
    fn(() => spawnSync(process.execPath, [CHECKER, '--root', root], { encoding: 'utf8' }));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('prose, strings, method calls and declarations are not calls', () => {
  withTree({
    'Panel.tsx': [
      '// replaces window.confirm("x") and alert()',
      '/* prompt( */',
      "const help = 'press confirm() to go';",
      'const tpl = `alert(${1})`;',
      'await confirmDialog({ title: t("x") });',
      'dialog.confirm(); form.prompt ( );',
      'function prompt(x: string) { return x; }',
    ].join('\n'),
  }, (run) => {
    const r = run();
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /OK/);
  });
});

test('bare and window/globalThis calls fail and name file and line', () => {
  withTree({
    'a.tsx': 'const ok = 1;\nif (!confirm(msg)) return;',
    'b.ts': 'const n = window.prompt(q, "");',
    'c.ts': 'globalThis . alert (e);',
  }, (run) => {
    const r = run();
    assert.equal(r.status, 1);
    assert.match(r.stderr, /apps\/viewer\/src\/a\.tsx:2 {2}confirm\(\)/);
    assert.match(r.stderr, /apps\/viewer\/src\/b\.ts:1 {2}prompt\(\)/);
    assert.match(r.stderr, /apps\/viewer\/src\/c\.ts:1 {2}alert\(\)/);
    assert.match(r.stderr, /confirmDialog/);
  });
});

test('test files are not scanned (they may stub the globals)', () => {
  withTree({ 'x.ts': 'export {};', 'x.test.ts': 'alert("stub");' }, (run) => {
    assert.equal(run().status, 0);
  });
});

test('a tree with no sources fails closed', () => {
  withTree({}, (run) => {
    const r = run();
    assert.equal(r.status, 1);
    assert.match(r.stderr, /cannot scan|scans nothing/);
  });
});
