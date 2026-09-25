#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Regression harness for scripts/check-icon-button-adoption.mjs (#5811).
 * Black-box: the CLI runs with `spawnSync` against a synthetic components tree
 * and a synthetic baseline, so nothing here reads the checker's own source.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const CHECKER = join(dirname(fileURLToPath(import.meta.url)), 'check-icon-button-adoption.mjs');

/** A multi-line icon button whose handler holds `=>` and a commented apostrophe. */
const ICON_BUTTON = `<Button
  onClick={() => {
    // don't stop at this apostrophe
    go();
  }}
  size="icon-xs"
>
  <X />
</Button>`;
const TEXT_BUTTON = '<Button size="sm">Text</Button>';

function withTree(files, baseline, fn) {
  const root = mkdtempSync(join(tmpdir(), 'icon-button-adoption-'));
  try {
    const components = join(root, 'apps', 'viewer', 'src', 'components');
    for (const [rel, body] of Object.entries(files)) {
      mkdirSync(dirname(join(components, rel)), { recursive: true });
      writeFileSync(join(components, rel), body);
    }
    writeFileSync(join(root, 'baseline.json'), JSON.stringify(baseline));
    fn(() => spawnSync(process.execPath, [CHECKER, '--root', root, '--baseline', join(root, 'baseline.json')], { encoding: 'utf8' }));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('a file matching its row passes; text buttons and components/ui are not counted', () => {
  withTree({
    'viewer/Panel.tsx': `${ICON_BUTTON}\n${TEXT_BUTTON}`,
    'ui/icon-button.tsx': ICON_BUTTON,
  }, { 'viewer/Panel.tsx': 1 }, (run) => {
    const r = run();
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /OK/);
  });
});

test('a NEW icon-sized <Button> fails and names the file', () => {
  withTree({ 'viewer/Fresh.tsx': ICON_BUTTON }, {}, (run) => {
    const r = run();
    assert.equal(r.status, 1);
    assert.match(r.stderr, /viewer\/Fresh\.tsx: 1 \(allowed 0\)/);
    assert.match(r.stderr, /IconButton/);
  });
});

test('a removed one fails until its row is lowered (no slack)', () => {
  withTree({ 'viewer/Panel.tsx': TEXT_BUTTON }, { 'viewer/Panel.tsx': 1 }, (run) => {
    const r = run();
    assert.equal(r.status, 1);
    assert.match(r.stderr, /viewer\/Panel\.tsx: 0 \(baseline 1\)/);
  });
});

test('a tree with no components fails closed', () => {
  withTree({}, {}, (run) => {
    const r = run();
    assert.equal(r.status, 1);
    assert.match(r.stderr, /cannot scan|scans nothing/);
  });
});
