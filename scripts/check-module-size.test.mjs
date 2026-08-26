#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Black-box regression harness for scripts/check-module-size.mjs.
 *
 * Method mirrors scripts/check-server-bin-targets.test.mjs: each case builds a
 * synthetic tree in a temp dir outside the repo, runs the UNMODIFIED checker
 * against it via `--root` / `--allowlist` / `--digests`, and asserts the exit
 * code AND the message. Nothing here reads the checker's source.
 *
 * The cases that matter most are the ones where a gate could pass having
 * measured nothing — no files, a missing search root, an unreadable or empty
 * allowlist, an absent digest pin. Three scripts in this repo have shipped
 * exiting 0 in exactly that state, so each is pinned here as an executable
 * "must exit non-zero" case.
 *
 * Run: node --test scripts/check-module-size.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  allowlistDigest,
  allowlistDigests,
  allowlistScope,
  parseAllowlist,
} from './lib/module-size-ratchet.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CHECKER = join(ROOT, 'scripts', 'check-module-size.mjs');

/** A tree of `{ 'packages/a/b.ts': <line count> }` plus an allowlist string. */
function makeTree(files) {
  const dir = mkdtempSync(join(tmpdir(), 'module-size-'));
  for (const [rel, lines] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(dirname(full), { recursive: true });
    // `lines` real lines: n-1 newlines plus a terminating one.
    writeFileSync(full, `${Array.from({ length: lines }, (_, i) => `const l${i} = ${i};`).join('\n')}\n`);
  }
  for (const d of ['packages', 'apps']) mkdirSync(join(dir, d), { recursive: true });
  return dir;
}

function run(dir, allowlistText, { digest, allowlistPath, extra = [] } = {}) {
  let path = allowlistPath;
  if (path === undefined) {
    path = join(dir, 'allowlist.txt');
    writeFileSync(path, allowlistText ?? '');
  }
  // The pin is per SCOPE now (#3291), so the harness hands the gate a JSON
  // object rather than one number. `digest` still takes a Map or an object so
  // the stale-pin cases below can state a WRONG pin as directly as before.
  const pin =
    digest !== undefined
      ? JSON.stringify(digest instanceof Map ? Object.fromEntries(digest) : digest)
      : allowlistText
        ? JSON.stringify(Object.fromEntries(allowlistDigests(parseAllowlist(allowlistText, 'x'))))
        : '{}';
  const res = spawnSync(
    process.execPath,
    [CHECKER, '--root', dir, '--allowlist', path, '--digests', pin, ...extra],
    { encoding: 'utf8' },
  );
  return { code: res.status, out: `${res.stdout}${res.stderr}`, allowlistPath: path };
}

const cleanup = [];
test.afterEach?.(() => {});
process.on('exit', () => {
  for (const d of cleanup) rmSync(d, { recursive: true, force: true });
});
function tree(files) {
  const d = makeTree(files);
  cleanup.push(d);
  return d;
}

test('clean tree passes and says how much it measured', () => {
  const dir = tree({ 'packages/a/small.ts': 100, 'packages/a/big.ts': 500 });
  const { code, out } = run(dir, '500 packages/a/big.ts\n');
  assert.equal(code, 0, out);
  assert.match(out, /2 files measured, 1 allowlisted, 0 new over 400/);
});

test('a new file over the limit fails', () => {
  const dir = tree({ 'packages/a/big.ts': 500, 'apps/v/new_god.tsx': 401 });
  const { code, out } = run(dir, '500 packages/a/big.ts\n');
  assert.equal(code, 1, out);
  assert.match(out, /New TypeScript file\(s\) over 400 lines with no allowlist row/);
  assert.match(out, /apps\/v\/new_god\.tsx: 401 lines/);
});

test('exactly 400 lines is not over the limit', () => {
  const dir = tree({ 'packages/a/edge.ts': 400, 'packages/a/big.ts': 500 });
  const { code, out } = run(dir, '500 packages/a/big.ts\n');
  assert.equal(code, 0, out);
});

test('an allowlisted file that GREW past its budget fails', () => {
  const dir = tree({ 'packages/a/big.ts': 501 });
  const { code, out } = run(dir, '500 packages/a/big.ts\n');
  assert.equal(code, 1, out);
  assert.match(out, /grew PAST their recorded budget\. Shrink or split instead of\nraising the budget/);
  assert.match(out, /packages\/a\/big\.ts: 501 lines, budget 500/);
});

test('RAISING the budget to match does not buy a green — the digest fires', () => {
  // The escape hatch this pin exists to close (#2658): grow the file and raise
  // its budget in the same commit. The size check is satisfied; the digest is
  // not, unless the raiser also edits that scope's ALLOWLIST_DIGESTS entry
  // where a reviewer sees it.
  const dir = tree({ 'packages/a/big.ts': 501 });
  const stalePin = allowlistDigests(parseAllowlist('500 packages/a/big.ts\n', 'x'));
  const { code, out } = run(dir, '501 packages/a/big.ts\n', { digest: stalePin });
  assert.equal(code, 1, out);
  assert.match(out, /The allowlist has 1 rows, budgets total 501, and 1 scope\(s\)/);
  // The failure must name the ONE scope that moved and the exact line to set,
  // because that is what makes the sharding worth having: a reviewer re-pins a
  // single line and every other scope's PR is untouched (#3291).
  assert.match(out, /'packages\/a': '\d+',/);
  assert.match(out, /Raising a budget loosens this ratchet/);
});

test('a compensating pair of edits still moves the digest', () => {
  const dir = tree({ 'packages/a/x.ts': 450, 'packages/a/y.ts': 450 });
  const before = '500 packages/a/x.ts\n600 packages/a/y.ts\n';
  const after = '600 packages/a/x.ts\n500 packages/a/y.ts\n'; // same total
  const { code, out } = run(dir, after, { digest: allowlistDigests(parseAllowlist(before, 'x')) });
  assert.equal(code, 1, out);
  assert.match(out, /scope\(s\)\ndisagree with ALLOWLIST_DIGESTS/);
});

test('a stale row at or under the limit fails', () => {
  const dir = tree({ 'packages/a/small.ts': 100 });
  const { code, out } = run(dir, '380 packages/a/small.ts\n');
  assert.equal(code, 1, out);
  assert.match(out, /rows at or under the 400-line limit/);
});

test('a shrunk or vanished row is advisory, not a failure', () => {
  const dir = tree({ 'packages/a/big.ts': 300 });
  const { code, out } = run(dir, '500 packages/a/big.ts\n700 packages/a/gone.ts\n');
  assert.equal(code, 0, out);
  assert.match(out, /note: packages\/a\/big\.ts: now 300 lines <= 400; delete its allowlist row/);
  assert.match(out, /note:\s+packages\/a\/gone\.ts \(budget 700\) no longer matches a tracked file/);
});

// ---------------------------------------------------------------------------
// Must-not-pass-vacuously. Every one of these exits non-zero.
// ---------------------------------------------------------------------------

test('VACUOUS: no TypeScript files at all fails', () => {
  const dir = tree({ 'packages/a/readme.md': 3 });
  const { code, out } = run(dir, '500 packages/a/big.ts\n');
  assert.equal(code, 1, out);
  assert.match(out, /no TypeScript files matched/);
  assert.match(out, /Exiting 0 here would certify a tree nobody looked at/);
});

test('VACUOUS: only exempt TypeScript files fails', () => {
  // Everything the walker found was a test or a declaration file, so nothing
  // was actually measured. That must be loud, not green.
  const dir = tree({
    'packages/a/x.test.ts': 900,
    'packages/a/x.d.ts': 900,
    'packages/a/generated/y.ts': 900,
  });
  const { code, out } = run(dir, '500 packages/a/big.ts\n');
  assert.equal(code, 1, out);
  assert.match(out, /no TypeScript files matched/);
});

test('VACUOUS: a missing search root fails instead of scanning nothing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'module-size-'));
  cleanup.push(dir);
  mkdirSync(join(dir, 'packages', 'a'), { recursive: true });
  writeFileSync(join(dir, 'packages', 'a', 'big.ts'), 'x\n'.repeat(500));
  // No `apps/` directory at all — a glob that resolved to nothing.
  const { code, out } = run(dir, '500 packages/a/big.ts\n');
  assert.equal(code, 1, out);
  assert.match(out, /search root .*apps does not exist or is not a directory/);
});

test('VACUOUS: an unreadable allowlist fails', () => {
  const dir = tree({ 'packages/a/big.ts': 500 });
  const { code, out } = run(dir, null, { allowlistPath: join(dir, 'does-not-exist.txt') });
  assert.equal(code, 1, out);
  assert.match(out, /cannot read allowlist/);
});

test('VACUOUS: an empty allowlist fails', () => {
  const dir = tree({ 'packages/a/big.ts': 500 });
  const { code, out } = run(dir, '', { digest: {} });
  assert.equal(code, 1, out);
  assert.match(out, /empty or unreadable/);
});

test('VACUOUS: a comments-only allowlist fails', () => {
  const dir = tree({ 'packages/a/big.ts': 500 });
  const { code, out } = run(dir, '# all rows deleted\n', { digest: {} });
  assert.equal(code, 1, out);
  assert.match(out, /parsed 0 rows/);
});

test('VACUOUS: a malformed allowlist row fails', () => {
  const dir = tree({ 'packages/a/big.ts': 500 });
  const { code, out } = run(dir, '500\n', { digest: {} });
  assert.equal(code, 1, out);
  assert.match(out, /malformed line/);
});

test('VACUOUS: a missing digest pin fails', () => {
  const dir = tree({ 'packages/a/big.ts': 500 });
  const { code, out } = run(dir, '500 packages/a/big.ts\n', { digest: {} });
  assert.equal(code, 1, out);
  assert.match(out, /no digest pin/);
});

// ---------------------------------------------------------------------------
// --update: the regeneration half. The whole point of these is the direction
// it must REFUSE — a ratchet whose own baseline command can raise a budget has
// no teeth left.
// ---------------------------------------------------------------------------

const HEADER = '# header line kept verbatim\n';

test('--update refuses to raise a budget, and writes nothing', () => {
  const dir = tree({ 'packages/a/big.ts': 501 });
  const before = `${HEADER}500 packages/a/big.ts\n`;
  const { code, out, allowlistPath } = run(dir, before, { extra: ['--update'] });
  assert.equal(code, 1, out);
  assert.match(out, /refusing to loosen the ratchet/);
  assert.match(out, /packages\/a\/big\.ts: 501 lines, budget 500 \(\+1\)/);
  assert.match(out, /Nothing was written/);
  // Not "mostly nothing": byte-for-byte unchanged.
  assert.equal(readFileSync(allowlistPath, 'utf8'), before);
});

test('--update refuses to add a new exemption, and writes nothing', () => {
  const dir = tree({ 'packages/a/big.ts': 500, 'apps/v/new_god.tsx': 401 });
  const before = `${HEADER}500 packages/a/big.ts\n`;
  const { code, out, allowlistPath } = run(dir, before, { extra: ['--update'] });
  assert.equal(code, 1, out);
  assert.match(out, /new exemption/);
  assert.match(out, /apps\/v\/new_god\.tsx: 401 lines/);
  assert.equal(readFileSync(allowlistPath, 'utf8'), before);
});

test('--update DOES lower a slack budget and drop a stale row', () => {
  // Both directions that tighten. This is the case that makes a rebase onto a
  // moved main a one-command operation instead of a hand edit.
  const dir = tree({ 'packages/a/big.ts': 450, 'packages/a/small.ts': 100 });
  const { code, out, allowlistPath } = run(
    dir,
    `${HEADER}500 packages/a/big.ts\n420 packages/a/small.ts\n700 packages/a/gone.ts\n`,
    { extra: ['--update'] },
  );
  assert.equal(code, 0, out);
  assert.equal(
    readFileSync(allowlistPath, 'utf8'),
    `${HEADER}   450 packages/a/big.ts\n`,
  );
  assert.match(out, /wrote 1 rows/);
});

test('--update --allow-raise does raise it, and says so in the output', () => {
  const dir = tree({ 'packages/a/big.ts': 501 });
  const { code, out, allowlistPath } = run(dir, `${HEADER}500 packages/a/big.ts\n`, {
    extra: ['--update', '--allow-raise'],
  });
  assert.equal(code, 0, out);
  assert.match(out, /RAISED:\s+packages\/a\/big\.ts: 501 lines, budget 500/);
  assert.equal(readFileSync(allowlistPath, 'utf8'), `${HEADER}   501 packages/a/big.ts\n`);
});

test('--allow-raise without --update is refused rather than silently ignored', () => {
  const dir = tree({ 'packages/a/big.ts': 500 });
  const { code, out } = run(dir, `${HEADER}500 packages/a/big.ts\n`, { extra: ['--allow-raise'] });
  assert.equal(code, 1, out);
  assert.match(out, /--allow-raise only means something with --update/);
});

test('VACUOUS: --update refuses to write an allowlist with no rows', () => {
  // Every file under the limit. Silently writing an empty allowlist would
  // parse as "0 rows" on the next run and fail there instead, or — worse —
  // read as a clean tree.
  const dir = tree({ 'packages/a/small.ts': 100 });
  const { code, out, allowlistPath } = run(dir, `${HEADER}500 packages/a/small.ts\n`, {
    extra: ['--update'],
  });
  assert.equal(code, 1, out);
  assert.match(out, /refusing to write an allowlist with 0 rows/);
  assert.equal(readFileSync(allowlistPath, 'utf8'), `${HEADER}500 packages/a/small.ts\n`);
});

test('what --update writes is what the gate then accepts', () => {
  // The regeneration and the check must agree, or the baseline command hands
  // you a tree that fails its own gate.
  const dir = tree({ 'packages/a/big.ts': 450, 'packages/a/x.ts': 900 });
  const { code, out, allowlistPath } = run(
    dir,
    `${HEADER}500 packages/a/big.ts\n900 packages/a/x.ts\n`,
    { extra: ['--update'] },
  );
  assert.equal(code, 0, out);
  const written = readFileSync(allowlistPath, 'utf8');
  const digests = allowlistDigests(parseAllowlist(written, 'x'));
  for (const [scope, d] of digests) {
    assert.match(out, new RegExp(`${scope}=${d}`));
  }
  const after = run(dir, null, { allowlistPath, digest: digests });
  assert.equal(after.code, 0, after.out);
  assert.match(after.out, /0 new over 400/);
});

test('--update re-pins ALLOWLIST_DIGESTS in the same run, one line per scope', () => {
  // The pin lives in the checker, not beside the rows, so regeneration has to
  // move it too — otherwise `--update` hands you a tree that fails the very
  // next run on the digest. A stand-in script under --root, so the committed
  // one is never rewritten by a test.
  //
  // Two scopes on purpose: the block must come back with a line EACH, because
  // one line per scope is the property that stops two PRs in different scopes
  // conflicting (#3291). A single combined line would pass a "was it re-pinned"
  // assertion while restoring the coupling.
  const dir = tree({ 'packages/a/big.ts': 450, 'apps/v/huge.ts': 460 });
  mkdirSync(join(dir, 'scripts'), { recursive: true });
  const selfCopy = join(dir, 'scripts', 'check-module-size.mjs');
  writeFileSync(selfCopy, "// stand-in\nconst ALLOWLIST_DIGESTS = {\n  'stale': '123',\n};\n");

  const { code, out, allowlistPath } = run(
    dir,
    `${HEADER}500 packages/a/big.ts\n500 apps/v/huge.ts\n`,
    { extra: ['--update'] },
  );
  assert.equal(code, 0, out);

  const digests = allowlistDigests(parseAllowlist(readFileSync(allowlistPath, 'utf8'), 'x'));
  assert.deepEqual([...digests.keys()], ['apps/v', 'packages/a']);
  const written = readFileSync(selfCopy, 'utf8');
  assert.doesNotMatch(written, /'stale'/, 'the old pin must be replaced, not appended to');
  for (const [scope, d] of digests) {
    assert.match(written, new RegExp(`  '${scope}': '${d}',`), `${scope} must be pinned on its own line`);
  }
  assert.match(out, /ALLOWLIST_DIGESTS re-pinned in .* \(2 scopes\)/);
});

test('a budget change in one scope leaves every OTHER scope pinned as it was', () => {
  // The property the sharding exists for (#3291), asserted directly rather
  // than inferred from the failure text. One repo-wide digest moved for a
  // change to ANY row, so eight PRs opened in one 90-minute batch were mutually
  // exclusive by construction: 18 conflict resolutions to land four of them.
  const before = parseAllowlist(
    '500 packages/export/a.ts\n600 packages/parser/b.ts\n700 apps/viewer/c.ts\n',
    'x',
  );
  const after = new Map(before);
  after.set('packages/export/a.ts', 505);

  const A = allowlistDigests(before);
  const B = allowlistDigests(after);
  const moved = [...A.keys()].filter((k) => A.get(k) !== B.get(k));
  assert.deepEqual(moved, ['packages/export'], 'only the edited scope may move');
  assert.equal(A.get('packages/parser'), B.get('packages/parser'));
  assert.equal(A.get('apps/viewer'), B.get('apps/viewer'));

  // The control, and the reason this test is not vacuous: the OLD repo-wide
  // digest moves for the same edit. Without this line the assertions above
  // would also pass for a digest that never changes at all.
  assert.notEqual(allowlistDigest(before), allowlistDigest(after));
});

test('scoping is two levels, and everything else falls back to its first segment', () => {
  assert.equal(allowlistScope('packages/export/src/deep/a.ts'), 'packages/export');
  assert.equal(allowlistScope('apps/viewer/src/b.tsx'), 'apps/viewer');
  assert.equal(allowlistScope('rust/core/src/c.rs'), 'rust/core');
  // Not `packages` alone — that would still couple every package to every
  // other, which is most of the contention this removes.
  assert.notEqual(allowlistScope('packages/export/src/a.ts'), 'packages');
  assert.equal(allowlistScope('scripts/d.ts'), 'scripts');
  assert.equal(allowlistScope('top-level.ts'), 'top-level.ts');
});

test('regenerating the real allowlist reproduces it byte for byte', () => {
  // The format is hand-maintained today, so `--update` must not reflow it.
  // Run against a COPY of the repo's allowlist in a temp dir — the committed
  // one is never written by a test.
  const realText = readFileSync(join(ROOT, 'scripts', 'module-size-allowlist.txt'), 'utf8');
  const rows = parseAllowlist(realText, 'real');
  const dir = tree({});
  for (const [rel, budget] of rows) {
    const full = join(dir, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, `${Array.from({ length: budget }, (_, i) => `const l${i} = ${i};`).join('\n')}\n`);
  }
  const copy = join(dir, 'copied-allowlist.txt');
  writeFileSync(copy, realText);
  // Any valid pin: --update recomputes it, but the validation runs first and
  // a bare string is no longer a well-formed pin (#3291).
  const { code, out } = run(dir, null, {
    allowlistPath: copy,
    digest: allowlistDigests(rows),
    extra: ['--update'],
  });
  assert.equal(code, 0, out);
  assert.equal(readFileSync(copy, 'utf8'), realText);
});

test('the committed gate runs green against the real repo', () => {
  // With no flags: the real tree, the real allowlist, the real pinned digest.
  // If this is red, either a module grew or the allowlist was edited without
  // moving the pin.
  const res = spawnSync(process.execPath, [CHECKER], { encoding: 'utf8', cwd: ROOT });
  const out = `${res.stdout}${res.stderr}`;
  assert.equal(res.status, 0, out);
  assert.match(out, /check-module-size: OK \(\d+ files measured, \d+ allowlisted, 0 new over 400\)/);
});
