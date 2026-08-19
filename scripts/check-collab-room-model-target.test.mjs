#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Regression harness for scripts/check-collab-room-model-target.mjs.
 *
 * That guard is the designated catcher for the room-model corruption its unit
 * tests deliberately do not cover, so a hole in the guard is a hole in the
 * only thing watching those paths. This file's job is one specific hole a
 * CodeRabbit CLI run found and this guard's own review missed:
 * `blankNoise` left template-literal contents unblanked, so a backtick string
 * spelling the required call (e.g. inside a debug log) satisfied the
 * required-call half of a check with no real call anywhere in the region.
 *
 * Method matches scripts/check-clash-degenerate-reason-parity.test.mjs:
 * mutate a copy of the REAL source in a temp tree outside the repo and run
 * the UNMODIFIED checker against it via `--root`. Every mutation anchor is
 * asserted to exist in the real input first, so a drifted anchor fails the
 * suite instead of quietly testing nothing.
 *
 * Run: node --test scripts/check-collab-room-model-target.test.mjs
 * (wired as a step of the CI node-test job in .github/workflows/test.yml).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPTS = dirname(fileURLToPath(import.meta.url));
const ROOT = join(SCRIPTS, '..');
const CHECKER = join(SCRIPTS, 'check-collab-room-model-target.mjs');

const COLLAB_REL = 'apps/viewer/src/store/slices/collabSlice.ts';
const MUTATION_REL = 'apps/viewer/src/store/slices/mutationSlice.ts';

const realCollab = readFileSync(join(ROOT, COLLAB_REL), 'utf8');
const realMutation = readFileSync(join(ROOT, MUTATION_REL), 'utf8');

/**
 * Writes a (possibly mutated) two-file tree to a temp dir and runs the
 * checker on it via `--root`. The checker only ever reads these two files by
 * their fixed relative path, so nothing else needs to exist in the tree.
 */
function runOn({ collab = realCollab, mutation = realMutation }) {
  const dir = mkdtempSync(join(tmpdir(), 'collab-room-model-target-'));
  try {
    for (const [rel, content] of [[COLLAB_REL, collab], [MUTATION_REL, mutation]]) {
      const abs = join(dir, rel);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, content);
    }
    const r = spawnSync(process.execPath, [CHECKER, '--root', dir], { encoding: 'utf8' });
    return { status: r.status, out: `${r.stdout}${r.stderr}` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Asserts an anchor really exists before a mutation is built on it. */
function replaceOnce(source, anchor, replacement) {
  assert.ok(source.includes(anchor), `mutation anchor drifted, not found in source: ${anchor}`);
  return source.replace(anchor, replacement);
}

test('the unmutated repo passes', () => {
  const { status, out } = runOn({});
  assert.equal(status, 0, out);
  assert.match(out, /check-collab-room-model-target: OK/);
});

test('RED: a template literal spelling the required call, with the real call deleted, must not satisfy the guard', () => {
  // This is exactly the CodeRabbit-found hole: `blankNoise` used to leave
  // template-literal contents unblanked, so a backtick string containing
  // `roomStoreFor(get(), modelId)` satisfied the required-call half of the
  // `mirrorEntityRemove` check with no real call anywhere in the region.
  // Confirmed against the PRE-FIX checker (git history) that this exact
  // mutation was accepted (exit 0) before `blankNoise` blanked quasi text.
  const collab = replaceOnce(
    realCollab,
    'mirrorEntityRemove: (modelId, entityId) => {\n' +
      '    // Room model only — see `mirrorPlacementEdit`.\n' +
      '    const session = get().collabSession;\n' +
      '    const store = roomStoreFor(get(), modelId);\n' +
      '    if (!session || !store || !docApi) return;',
    'mirrorEntityRemove: (modelId, entityId) => {\n' +
      '    // Room model only — see `mirrorPlacementEdit`.\n' +
      '    const session = get().collabSession;\n' +
      '    const debugMsg = `would call roomStoreFor(get(), modelId) here`;\n' +
      '    const store = null;\n' +
      '    if (!session || !store || !docApi) return;',
  );
  const { status, out } = runOn({ collab });
  assert.equal(status, 1, out);
  assert.match(out, /no `roomStoreFor\(get\(\), modelId\)` in .*collabSlice\.ts/);
});

// eslint-disable-next-line no-template-curly-in-string -- documentation text, not a real interpolation
test('a `${...}` interpolation inside a template literal is scanned as real code, not blanked away', () => {
  // The other half of the same fix: quasi TEXT is prose and gets blanked, but
  // an interpolation is a live expression, so a banned shape hidden inside
  // `${...}` must still be caught. Reproduces this in `mirrorEntityRemove`,
  // whose ban list includes bare `.activeModelId`.
  const collab = replaceOnce(
    realCollab,
    'mirrorEntityRemove: (modelId, entityId) => {\n' +
      '    // Room model only — see `mirrorPlacementEdit`.\n' +
      '    const session = get().collabSession;\n' +
      '    const store = roomStoreFor(get(), modelId);\n' +
      '    if (!session || !store || !docApi) return;',
    'mirrorEntityRemove: (modelId, entityId) => {\n' +
      '    // Room model only — see `mirrorPlacementEdit`.\n' +
      '    const session = get().collabSession;\n' +
      // eslint-disable-next-line no-template-curly-in-string -- mutation payload: a real template literal in the SOURCE UNDER TEST
      '    const debugMsg = `active is ${get().activeModelId}`;\n' +
      '    const store = roomStoreFor(get(), modelId);\n' +
      '    if (!session || !store || !docApi) return;',
  );
  const { status, out } = runOn({ collab });
  assert.equal(status, 1, out);
  assert.match(out, /collab mirrorEntityRemove resolves the room's model as the ACTIVE model/);
  assert.match(out, /\.activeModelId/);
});

test('a real string that merely CONTAINS a backtick character is still blanked as a string, not left as code', () => {
  // Sanity check on the state machine: an ordinary single-quoted string
  // holding a literal backtick character must not be misread as opening a
  // template literal (which would desync quote/backtick tracking for the
  // rest of the file and could hide or fabricate a hit).
  const collab = replaceOnce(
    realCollab,
    'mirrorEntityRemove: (modelId, entityId) => {\n' +
      '    // Room model only — see `mirrorPlacementEdit`.\n' +
      '    const session = get().collabSession;',
    'mirrorEntityRemove: (modelId, entityId) => {\n' +
      "    const backtickInAString = 'a lone ` character';\n" +
      '    // Room model only — see `mirrorPlacementEdit`.\n' +
      '    const session = get().collabSession;',
  );
  const { status, out } = runOn({ collab });
  assert.equal(status, 0, out);
  assert.match(out, /check-collab-room-model-target: OK/);
});
