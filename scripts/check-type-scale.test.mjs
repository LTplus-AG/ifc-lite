#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CHECKER = join(dirname(fileURLToPath(import.meta.url)), 'check-type-scale.mjs');
const SOURCE = 'apps/viewer/src/Widget.tsx';

function run(root, ...args) {
  return spawnSync(process.execPath, [CHECKER, '--root', root, ...args], { encoding: 'utf8' });
}

function writeSource(root, classes) {
  writeFileSync(join(root, SOURCE), `export function Widget() { return <div className="${classes}" />; }\n`);
}

test('#5821 type-scale ratchet catches increases and requires a lower baseline after fixes', () => {
  const root = mkdtempSync(join(tmpdir(), 'type-scale-'));
  try {
    mkdirSync(join(root, 'apps/viewer/src'), { recursive: true });
    mkdirSync(join(root, 'scripts'), { recursive: true });
    const baseline = join(root, 'scripts/type-scale-baseline.json');
    writeSource(root, 'text-[9px] hover:text-[10.5px] text-xs');

    assert.equal(run(root, '--update').status, 0);
    assert.deepEqual(JSON.parse(readFileSync(baseline, 'utf8')), { [SOURCE]: 2 });
    assert.equal(run(root).status, 0);

    writeSource(root, 'text-[9px] hover:text-[10.5px] text-[12px]');
    assert.match(run(root).stderr, /increase: .*Widget\.tsx: 2 -> 3/);
    assert.notEqual(run(root).status, 0);
    assert.notEqual(run(root, '--update').status, 0, 'an ordinary update cannot raise the allowance');
    assert.deepEqual(JSON.parse(readFileSync(baseline, 'utf8')), { [SOURCE]: 2 });

    writeSource(root, 'text-[9px] text-xs');
    assert.match(run(root).stderr, /lower baseline: .*Widget\.tsx: 2 -> 1/);
    assert.notEqual(run(root).status, 0, 'a fixed occurrence leaves no slack');
    assert.equal(run(root, '--update').status, 0);
    assert.deepEqual(JSON.parse(readFileSync(baseline, 'utf8')), { [SOURCE]: 1 });
    assert.equal(run(root).status, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
