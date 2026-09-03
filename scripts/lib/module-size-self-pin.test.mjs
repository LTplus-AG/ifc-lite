#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Unit tests for the self-pin fixed point (#3727, #3693).
 *
 * The end-to-end shape -- `--update` then a plain run, both green -- is pinned
 * in `scripts/check-module-size.test.mjs` against the real script. What is here
 * is what that run reaches only indirectly or not at all: the loop's REFUSAL
 * when the file's size never settles (the real renderer converges too fast to
 * exercise it), and the scope join, which the end-to-end fixtures cannot
 * isolate because their stand-in self file is untracked and therefore already
 * in the change's scope.
 *
 * Run: node --test scripts/lib/module-size-self-pin.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MAX_SETTLE_PASSES,
  PIN_RE,
  SELF_REL,
  readSelfPin,
  renderPinBlock,
  repin,
  settleUpdate,
} from './module-size-self-pin.mjs';
import { countLines, parseAllowlist } from './module-size-ratchet.mjs';

/**
 * A file of `lines` real lines whose head is the pin block, followed by a
 * SECOND object literal. The second `};` is not decoration: it is what makes a
 * greedy PIN_RE observably wrong, and the real file will grow one the first
 * time anybody adds a const object below the pin.
 */
function selfSource(lines, scopes) {
  const head = ['const ALLOWLIST_DIGESTS = {', ...scopes.map((s) => `  '${s}': '1',`), '};'];
  const tail = ['const OTHER = {', "  'keep': 'me',", '};'];
  const fill = lines - head.length - tail.length;
  const body = Array.from({ length: fill }, (_, i) => `const l${i} = ${i};`);
  return `${[...head, ...body, ...tail].join('\n')}\n`;
}

test('repin replaces the block in place and leaves the rest of the file alone', () => {
  const text = selfSource(10, ['old']);
  const out = repin(text, new Map([['packages/a', '7']]));
  assert.match(out, /^const ALLOWLIST_DIGESTS = \{\n {2}'packages\/a': '7',\n\};$/m);
  assert.doesNotMatch(out, /'old'/);
  assert.match(out, /const l0 = 0;/);
});

test('a scope containing a substitution pattern is spliced literally, not expanded', () => {
  // `$&` is a replacement pattern in String.replace's string form, so a string
  // replacer would inject the matched block back into itself.
  const out = repin(selfSource(6, ['old']), new Map([['packages/$&', '1']]));
  assert.match(out, /'packages\/\$&': '1',/);
  assert.equal(out.match(/const ALLOWLIST_DIGESTS/g).length, 1);
});

test('renderPinBlock gives every scope its own line (#3291)', () => {
  const block = renderPinBlock(new Map([['apps/v', '1'], ['packages/a', '2']]));
  assert.equal(countLines(`${block}\n`), 4);
  assert.ok(PIN_RE.test(`${block}\n`));
});

test('readSelfPin answers null for a tree with no pin, and the text when there is one', () => {
  // The synthetic tree the harness builds under --root has no pin to move.
  // That is a documented case, and the caller keys "print instead of write" off
  // it, so an exception escaping here would abort a legitimate run.
  const dir = mkdtempSync(join(tmpdir(), 'self-pin-'));
  assert.equal(readSelfPin(dir).text, null, 'no file at all');
  mkdirSync(join(dir, 'scripts'), { recursive: true });
  writeFileSync(join(dir, SELF_REL), 'const x = 1;\n');
  assert.equal(readSelfPin(dir).text, null, 'a file with no pin block in it');
  writeFileSync(join(dir, SELF_REL), selfSource(6, ['packages/a']));
  assert.match(readSelfPin(dir).text, /ALLOWLIST_DIGESTS/);
});

test('settleUpdate records the self row at the size the rewrite PRODUCES', () => {
  // The defect: the row was written from the size measured before the block was
  // rewritten. One extra scope, one extra line, one stale row.
  // big.ts carries HEADROOM (measured 500, budget 520). Without it, in-scope and
  // out-of-scope re-recording produce the same number and the "nothing else was
  // annexed" assertion below cannot fail.
  const allowlist = parseAllowlist('520 packages/a/big.ts\n450 scripts/check-module-size.mjs\n', 'x');
  const files = [
    { rel: 'packages/a/big.ts', lines: 500 },
    { rel: 'apps/b/new.ts', lines: 401 },
    { rel: SELF_REL, lines: 450 },
  ];
  const settled = settleUpdate({
    files,
    allowlist,
    changed: new Set(['apps/b/new.ts']),
    self: { path: SELF_REL, text: selfSource(450, ['packages/a', 'scripts']) },
  });
  assert.equal(settled.plan.next.get(SELF_REL), 451);
  assert.equal(countLines(settled.selfText), 451);
  // The self file joined the scope because THIS RUN rewrote it. Nothing else
  // did: packages/a/big.ts was never touched, so it keeps its committed budget.
  assert.equal(settled.plan.next.get('packages/a/big.ts'), 520, 'its committed budget, headroom and all');
});

test('settleUpdate leaves the self row alone when the block length does not move', () => {
  // The counterweight: a run that does not change the scope count must not
  // annex its own row's headroom either. Nothing here is in scope.
  const allowlist = parseAllowlist('500 packages/a/big.ts\n450 scripts/check-module-size.mjs\n', 'x');
  const settled = settleUpdate({
    files: [
      { rel: 'packages/a/big.ts', lines: 500 },
      { rel: SELF_REL, lines: 440 },
    ],
    allowlist,
    changed: new Set(),
    self: { path: SELF_REL, text: selfSource(440, ['packages/a', 'scripts']) },
  });
  assert.equal(settled.passes, 1);
  assert.equal(settled.plan.next.get(SELF_REL), 450, 'the committed budget, not the measured 440');
});

test('settleUpdate settles on the first pass when there is no pin to move', () => {
  const settled = settleUpdate({
    files: [{ rel: 'packages/a/big.ts', lines: 500 }],
    allowlist: parseAllowlist('500 packages/a/big.ts\n', 'x'),
    changed: null,
    self: { path: SELF_REL, text: null },
  });
  assert.equal(settled.passes, 1);
  assert.equal(settled.selfText, null);
});

test('settleUpdate REFUSES rather than looping when the size never settles', () => {
  // The bound exists because an unbounded fixed-point iteration over a
  // self-referential file is a hang, and a hang is the one failure nothing
  // reports. `renderPinBlock` converges in three passes, so the only way to
  // exercise the refusal is to BE the future renderer the bound guards against:
  // one whose block length depends on something other than the scope count.
  let renders = 0;
  assert.throws(
    () =>
      settleUpdate({
        files: [{ rel: SELF_REL, lines: 500 }],
        allowlist: parseAllowlist('500 scripts/check-module-size.mjs\n', 'x'),
        changed: null,
        self: { path: SELF_REL, text: selfSource(500, ['packages/a']) },
        render: (digests) => {
          renders += 1;
          return `${renderPinBlock(digests)}${renders % 2 === 1 ? '\n// pad' : ''}`;
        },
      }),
    /after 8 passes/,
  );
  assert.equal(renders, MAX_SETTLE_PASSES);
});

test('the pin block match stops at its OWN closing brace, not a later one', () => {
  // Non-greedy is the whole reason `repin` does not swallow everything between
  // the pin block and the next `};` in the file. selfSource now carries a second
  // object below the block, so a greedy match is visible here.
  const out = repin(selfSource(12, ['packages/a']), new Map([['packages/b', '9']]));
  assert.match(out, /'packages\/b': '9',/);
  assert.match(out, /^const OTHER = \{$/m, 'the object below the pin must survive intact');
  assert.match(out, /^ {2}'keep': 'me',$/m);
});

test('settleUpdate settles on the first pass when the walk never measured the pinned file', () => {
  // The pin exists but no row of `files` names it: it was exempted, or the walk
  // did not reach it. There is nothing to feed back, so the answer is the plain
  // plan -- not a loop that runs to the bound and then reads a row that is not
  // there.
  const settled = settleUpdate({
    files: [{ rel: 'packages/a/big.ts', lines: 500 }],
    allowlist: parseAllowlist('500 packages/a/big.ts\n', 'x'),
    changed: null,
    self: { path: SELF_REL, text: selfSource(500, ['packages/a']) },
  });
  assert.equal(settled.passes, 1);
  assert.equal(settled.plan.next.get(SELF_REL), undefined);
  assert.match(settled.selfText, /'packages\/a':/);
});
