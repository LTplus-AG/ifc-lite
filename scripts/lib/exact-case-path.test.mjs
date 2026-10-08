/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * scripts/lib/exact-case-path.mjs (#7026): a path counts only under the
 * spelling the repository tracks it by.
 *
 * Wrong-case paths have to be tested on EVERY host, and a real directory
 * cannot do that: on Linux a wrong-case lookup fails for the filesystem's own
 * reasons, so a predicate degraded to "it resolves" would still pass. Two
 * things make these tests bite everywhere:
 *   - the rule is driven with an injected directory lookup, so the answer
 *     comes from NAMES, never from what the host's filesystem resolves;
 *   - the real-repository test takes its names from `git ls-files`, which
 *     spells every path the same on every host.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSpelledExactly } from './exact-case-path.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** A directory lookup over a fixed tree: `{ '': [...], 'ops': [...] }`. Unknown directories cannot be listed. */
const lookup = (tree) => (dir) => (dir in tree ? new Set(tree[dir]) : null);

const TREE = {
  '': ['NOTES.md', 'ops', 'tools-x'],
  ops: ['Nested', 'compose.yml'],
  'ops/Nested': ['File.txt'],
  'tools-x': ['check.mjs'],
};

test('a path spelled as its directory entries spell it is accepted, at any depth', () => {
  const spelled = createSpelledExactly('/unused', lookup(TREE));
  for (const p of ['NOTES.md', 'ops', 'ops/compose.yml', 'ops/Nested/File.txt', './ops/Nested', 'tools-x/check.mjs']) {
    assert.equal(spelled(p), true, p);
  }
});

test('a path that differs only in letter case is rejected, in any component', () => {
  const spelled = createSpelledExactly('/unused', lookup(TREE));
  for (const p of ['notes.md', 'Ops', 'Ops/compose.yml', 'ops/nested/File.txt', 'ops/Nested/file.txt', 'TOOLS-X/check.mjs']) {
    assert.equal(spelled(p), false, p);
  }
});

test('a name the directory does not hold at all is rejected', () => {
  const spelled = createSpelledExactly('/unused', lookup(TREE));
  assert.equal(spelled('nope'), false);
  assert.equal(spelled('ops/nope.yml'), false);
});

test('a directory that cannot be listed does not veto what is under it', () => {
  // `tools-x/check.mjs` is a file, so "listing" it yields null; the rule cannot
  // show a case difference there and leaves the answer to the existence check.
  const spelled = createSpelledExactly('/unused', lookup(TREE));
  assert.equal(spelled('tools-x/check.mjs/deeper'), true);
});

test('each directory is looked up once however many paths are asked', () => {
  const asked = [];
  const spelled = createSpelledExactly('/unused', (dir) => {
    asked.push(dir);
    return lookup(TREE)(dir);
  });
  for (let i = 0; i < 5; i += 1) {
    spelled('ops/Nested/File.txt');
    spelled('ops/compose.yml');
  }
  assert.deepEqual(asked.sort(), ['', 'ops', 'ops/Nested']);
});

test('the default lookup reads real directories and returns their exact names', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'exact-case-path-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'ops', 'Nested'), { recursive: true });
  writeFileSync(join(root, 'NOTES.md'), '');
  writeFileSync(join(root, 'ops', 'Nested', 'File.txt'), '');
  const spelled = createSpelledExactly(root);
  assert.equal(spelled('NOTES.md'), true);
  assert.equal(spelled('ops/Nested/File.txt'), true);
  // True on every host. On a case-insensitive one `existsSync` says these exist.
  assert.equal(spelled('notes.md'), false);
  assert.equal(spelled('Ops'), false);
  assert.equal(spelled('ops/nested/File.txt'), false);
});

test('the real repository: every tracked path is accepted, and wrong-case variants of tracked names are rejected', () => {
  const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: REPO, encoding: 'utf8', maxBuffer: 1 << 28 }).split('\0').filter(Boolean);
  assert.ok(tracked.length > 1000, 'git ls-files returned the tracked tree');

  // The lookup is built from the tracked names alone: the tracked-path contract,
  // with no filesystem in the loop.
  const tree = { '': new Set() };
  for (const path of tracked) {
    const parts = path.split('/');
    for (let i = 0; i < parts.length; i += 1) {
      const dir = parts.slice(0, i).join('/');
      (tree[dir] ??= new Set()).add(parts[i]);
    }
  }
  const spelled = createSpelledExactly(REPO, (dir) => tree[dir] ?? null);

  const rejectedTracked = tracked.filter((path) => !spelled(path));
  assert.deepEqual(rejectedTracked, []);

  // The two strings the gate misread on macOS, and a flipped-case variant of
  // every 97th tracked path (a variant that is itself tracked would be a case
  // collision, which #6983's gate forbids; skip it rather than assume).
  assert.equal(spelled('Deploy'), false);
  assert.equal(spelled('readme.md'), false);
  const trackedSet = new Set(tracked);
  let variants = 0;
  for (let i = 0; i < tracked.length; i += 97) {
    const flipped = tracked[i].replace(/[a-zA-Z]/, (c) => (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase()));
    if (flipped === tracked[i] || trackedSet.has(flipped)) continue;
    variants += 1;
    assert.equal(spelled(flipped), false, flipped);
  }
  assert.ok(variants > 50, `only ${variants} wrong-case variants were exercised`);
});
