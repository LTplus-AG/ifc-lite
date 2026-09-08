#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Unit tests for the pure half of the TypeScript module-size ratchet.
 *
 * The interesting cases are the FIRING ones. A gate exercised only against the
 * currently-clean tree is a gate nobody has seen fail, and this repo has
 * shipped three scripts that exited 0 having verified nothing — so the
 * boundaries (exactly 400, exactly at budget), the loud-failure paths (empty
 * allowlist, malformed row, duplicate row) and the digest's cross-language
 * agreement with the Rust gate all live here as executable cases.
 *
 * Run: node --test scripts/lib/module-size-ratchet.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  LIMIT,
  countLines,
  isExempt,
  parseAllowlist,
  allowlistDigest,
  allowlistDigests,
  allowlistScope,
  evaluate,
  staleRows,
  planUpdate,
} from './module-size-ratchet.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

test('LIMIT is the AGENTS.md house rule', () => {
  assert.equal(LIMIT, 400);
});

test('countLines matches Rust str::lines()', () => {
  assert.equal(countLines(''), 0);
  assert.equal(countLines('a'), 1);
  // A trailing newline TERMINATES the last line; it does not start an empty
  // one. `split('\n').length` gets this wrong and reports 2 here, which made
  // every budget one line too generous.
  assert.equal(countLines('a\n'), 1);
  assert.equal(countLines('a\nb'), 2);
  assert.equal(countLines('a\nb\n'), 2);
  assert.equal(countLines('\n'), 1);
  assert.equal(countLines('a\n\n'), 2);
});

test('isExempt covers generated, declaration and test files only', () => {
  for (const rel of [
    'packages/data/src/generated/schema.ts',
    'apps/viewer/src/generated/x.tsx',
    'packages/sdk/src/index.d.ts',
    'packages/sdk/src/index.d.mts',
    'packages/export/src/step-exporter.test.ts',
    'apps/viewer/src/components/X.spec.tsx',
    'packages/geometry/src/x.bench.ts',
    'apps/viewer/src/test/render.tsx',
    'packages/parser/tests/big.ts',
    'apps/viewer/src/__tests__/x.ts',
    'apps/viewer/src/__mocks__/x.ts',
    'tests/e2e/x.ts',
    'packages/x/fixtures/model.ts',
    // The .mjs/.cjs population joined in #3672, and its test files must be as
    // exempt as TS ones — scripts/ alone holds ~70 *.test.mjs.
    'scripts/check-module-size.test.mjs',
    'scripts/lib/pr-review-signal.spec.cjs',
    'scripts/fixtures/sample.mjs',
  ]) {
    assert.equal(isExempt(rel), true, rel);
  }
  for (const rel of [
    'packages/export/src/step-exporter.ts',
    'apps/viewer/src/components/viewer/Viewport.tsx',
    // A non-test .mjs module is measured like any other source file (#3672).
    'scripts/check-module-size.mjs',
    'scripts/space-dcel-e2e.cjs',
    // "generated" must be a path SEGMENT, not a substring: a module that
    // generates something is production code.
    'apps/viewer/src/components/viewer/schedule/generate-schedule.ts',
    'packages/data/scripts/generate-ifc-schema.ts',
    // `.d.ts` must be a suffix, not a substring.
    'packages/x/src/a.d.ts.ts',
    // A file merely NAMED test-ish is not a test file.
    'packages/x/src/testing.ts',
    'packages/extensions/src/testing/runner.ts',
  ]) {
    assert.equal(isExempt(rel), false, rel);
  }
});

test('parseAllowlist reads rows and ignores comments and blanks', () => {
  const map = parseAllowlist('# header\n\n  500 packages/a/b.ts\n1200 apps/c/d.tsx\n');
  assert.deepEqual([...map], [
    ['packages/a/b.ts', 500],
    ['apps/c/d.tsx', 1200],
  ]);
});

test('parseAllowlist is LOUD on every degenerate input', () => {
  // Exiting 0 on an allowlist nobody could read is the vacuous pass this
  // whole file exists to make impossible.
  assert.throws(() => parseAllowlist(''), /empty or unreadable/);
  assert.throws(() => parseAllowlist('   \n\n'), /empty or unreadable/);
  assert.throws(() => parseAllowlist(undefined), /empty or unreadable/);
  assert.throws(() => parseAllowlist('# only comments\n'), /parsed 0 rows/);
  assert.throws(() => parseAllowlist('500\n'), /malformed line/);
  assert.throws(() => parseAllowlist('abc packages/a.ts\n'), /bad budget/);
  assert.throws(() => parseAllowlist('4.5 packages/a.ts\n'), /bad budget/);
  assert.throws(() => parseAllowlist('-5 packages/a.ts\n'), /bad budget/);
  // A duplicate row means one of the two budgets is silently ignored — i.e. a
  // file that looks frozen and is not.
  assert.throws(() => parseAllowlist('500 a.ts\n600 a.ts\n'), /duplicate row/);
});

test('evaluate fires on a new god file and on growth past budget', () => {
  const allowlist = new Map([
    ['packages/a/big.ts', 500],
    ['packages/a/grown.ts', 600],
  ]);
  const files = [
    { rel: 'packages/a/small.ts', lines: 399 }, // under the limit — clean
    { rel: 'packages/a/at_limit.ts', lines: 400 }, // exactly 400 is NOT > 400 — clean
    { rel: 'packages/a/new_god.tsx', lines: 401 }, // > 400, unlisted — FIRES
    { rel: 'packages/a/big.ts', lines: 500 }, // exactly at budget — clean
    { rel: 'packages/a/grown.ts', lines: 601 }, // one over budget — FIRES
  ];
  const { newOffenders, grew, shrunk, missing } = evaluate(files, allowlist);
  assert.deepEqual(newOffenders, ['  packages/a/new_god.tsx: 401 lines']);
  assert.deepEqual(grew, ['  packages/a/grown.ts: 601 lines, budget 600']);
  assert.deepEqual(shrunk, []);
  assert.deepEqual(missing, []);
});

test('evaluate is clean when everything is within budget', () => {
  const allowlist = new Map([['packages/a/big.ts', 500]]);
  const files = [
    { rel: 'packages/a/small.ts', lines: 12 },
    { rel: 'packages/a/big.ts', lines: 480 },
  ];
  const { newOffenders, grew, slack } = evaluate(files, allowlist);
  assert.deepEqual(newOffenders, []);
  assert.deepEqual(grew, []);
  // Within budget, but 20 lines of headroom the file can grow into with
  // nothing firing. Advisory, and it must be SAID.
  assert.deepEqual(slack, ['  packages/a/big.ts: 480 lines, budget 500 (20 lines of headroom)']);
});

test('slack is advisory, and is silent when the budget is the measured count', () => {
  const allowlist = new Map([
    ['packages/a/exact.ts', 500],
    ['packages/a/roomy.ts', 900],
    ['packages/a/under.ts', 700],
  ]);
  const { slack, newOffenders, grew } = evaluate(
    [
      { rel: 'packages/a/exact.ts', lines: 500 },
      { rel: 'packages/a/roomy.ts', lines: 640 },
      // Back under LIMIT: `shrunk` owns this one, so slack must not double-report.
      { rel: 'packages/a/under.ts', lines: 120 },
    ],
    allowlist,
  );
  assert.deepEqual(slack, ['  packages/a/roomy.ts: 640 lines, budget 900 (260 lines of headroom)']);
  assert.deepEqual(newOffenders, []);
  assert.deepEqual(grew, []);
});

test('evaluate reports rows to delete without failing on them', () => {
  const allowlist = new Map([
    ['packages/a/shrank.ts', 500],
    ['packages/a/deleted.ts', 700],
  ]);
  const { newOffenders, grew, shrunk, missing } = evaluate(
    [{ rel: 'packages/a/shrank.ts', lines: 320 }],
    allowlist,
  );
  assert.deepEqual(shrunk, ['  packages/a/shrank.ts: now 320 lines']);
  assert.deepEqual(missing, ['  packages/a/deleted.ts (budget 700)']);
  // Advisory: these must never be part of the failing set, so an unrelated PR
  // cannot go red because someone else's shrink landed first.
  assert.deepEqual(newOffenders, []);
  assert.deepEqual(grew, []);
});

test('staleRows flags budgets that grant no exemption', () => {
  const allowlist = new Map([
    ['a.ts', 401],
    ['b.ts', 400],
    ['c.ts', 12],
  ]);
  assert.deepEqual(staleRows(allowlist), [
    '  b.ts: budget 400 <= 400',
    '  c.ts: budget 12 <= 400',
  ]);
});

test('the digest moves for ANY row change, including a compensating pair', () => {
  const base = new Map([
    ['a.ts', 500],
    ['b.ts', 600],
  ]);
  const raised = new Map([
    ['a.ts', 501],
    ['b.ts', 600],
  ]);
  // The reason a plain SUM was rejected: +100/-100 leaves the total identical.
  const compensated = new Map([
    ['a.ts', 600],
    ['b.ts', 500],
  ]);
  const added = new Map([...base, ['c.ts', 450]]);
  const removed = new Map([['a.ts', 500]]);
  const d = allowlistDigest(base);
  for (const [name, other] of [
    ['raised', raised],
    ['compensated', compensated],
    ['added', added],
    ['removed', removed],
  ]) {
    assert.notEqual(allowlistDigest(other), d, `digest did not move for: ${name}`);
  }
  // Sum-blindness demonstrated, so the above is a real distinction.
  const sum = (m) => [...m.values()].reduce((x, y) => x + y, 0);
  assert.equal(sum(compensated), sum(base));
});

test('the digest is a function of content, not of line order', () => {
  const a = new Map([
    ['a.ts', 500],
    ['b.ts', 600],
  ]);
  const b = new Map([
    ['b.ts', 600],
    ['a.ts', 500],
  ]);
  assert.equal(allowlistDigest(a), allowlistDigest(b));
});

test('the SCOPE RULE agrees with the Rust twin, on vectors production data does not contain', () => {
  // The digest-table parity test below cannot see a scope-rule divergence. It
  // exercises the shared rule only over the RUST allowlist, which holds zero
  // `packages/` rows, so that branch is dead on its only input: deleting it
  // from the Rust side leaves every digest byte-identical and every gate green.
  // Measured -- that mutation passed everything before these vectors existed.
  //
  // Same shared-fixture pattern as csv_cell_vectors.json / unit_scale_vectors.json.
  const vectors = JSON.parse(
    readFileSync(
      join(ROOT, 'rust', 'processing', 'tests', 'fixtures', 'module_size_scope_vectors.json'),
      'utf8',
    ),
  );
  // Anti-vacuity: an empty or mis-shaped fixture would pass a bare for-loop.
  assert.ok(Array.isArray(vectors.cases) && vectors.cases.length >= 10, 'fixture must carry the full vector set');
  for (const { path, scope } of vectors.cases) {
    assert.equal(allowlistScope(path), scope, `scope rule disagrees for ${JSON.stringify(path)}`);
  }
  // The cases that matter most are the ones neither allowlist contains, since
  // those are exactly what a digest comparison cannot reach.
  const paths = vectors.cases.map((c) => c.path);
  assert.ok(paths.some((p) => p.startsWith('packages/')), 'must cover packages/, absent from the Rust allowlist');
  assert.ok(paths.some((p) => p === '' || p.startsWith('/')), 'must cover the falsy-first-segment fallback');
});

test('the digest agrees with the Rust ratchet, byte for byte', () => {
  // Not a self-comparison: this runs the JS FNV-1a over the RUST allowlist and
  // asserts it reproduces the u64 pinned in module_size_ratchet.rs. If the two
  // hashes ever drift, one language's gate stops meaning what the other's
  // does — and this is the only place that would notice.
  const rustAllowlist = join(ROOT, 'rust', 'processing', 'tests', 'module_size_allowlist.txt');
  const rustSource = readFileSync(join(ROOT, 'rust', 'processing', 'tests', 'module_size_ratchet.rs'), 'utf8');
  // Both sides are sharded by scope now (#3291), so the parity claim is
  // per-scope: every entry of the Rust `ALLOWLIST_DIGESTS` table must equal
  // what the JS `allowlistDigests` computes for that scope over the SAME file.
  const block = /const ALLOWLIST_DIGESTS: &\[\(&str, u64\)\] = &\[([\s\S]*?)\];/.exec(rustSource);
  assert.ok(block, 'could not find ALLOWLIST_DIGESTS in module_size_ratchet.rs');
  const pinned = new Map(
    [...block[1].matchAll(/\("([^"]+)",\s*(\d+)\)/g)].map(([, scope, d]) => [scope, d]),
  );
  const computed = allowlistDigests(parseAllowlist(readFileSync(rustAllowlist, 'utf8')));

  // Anti-vacuity: a regex that matched nothing would give two empty maps and a
  // passing deepEqual, which is the shape this repo keeps rediscovering.
  assert.ok(pinned.size > 0, 'the Rust pin table parsed to zero entries');
  assert.equal(pinned.size, computed.size, 'the two sides must cover the same scopes');
  assert.deepEqual([...computed].sort(), [...pinned].sort());

  // And the SCOPING itself must agree, not just the hashes: a JS scope rule
  // that differed from the Rust one could still produce matching digests if
  // every row happened to land in one bucket.
  assert.ok(computed.size > 1, 'the Rust allowlist must span more than one scope');
});

// ---------------------------------------------------------------------------
// planUpdate scoping (#3398). Repo-wide re-recording only ever TIGHTENED rows,
// which is why it read as harmless — and why it silently pulled rows belonging
// to other people's changes into whichever PR regenerated next.
// ---------------------------------------------------------------------------

test('planUpdate carries an untouched row at its COMMITTED budget', () => {
  const files = [
    { rel: 'packages/a/big.ts', lines: 520 },
    { rel: 'packages/b/slack.ts', lines: 450 },
  ];
  const allowlist = new Map([
    ['packages/a/big.ts', 500],
    ['packages/b/slack.ts', 460],
  ]);

  const scoped = planUpdate(files, allowlist, new Set(['packages/a/big.ts']));
  assert.equal(scoped.next.get('packages/a/big.ts'), 520, 'the changed file is re-recorded');
  assert.equal(scoped.next.get('packages/b/slack.ts'), 460, 'the untouched row keeps its committed budget');
  assert.deepEqual(scoped.raised, ['  packages/a/big.ts: 520 lines, budget 500 (+20)']);
  assert.deepEqual(scoped.lowered, [], 'an untouched row is not this change to make');

  // The control, and the reason the assertions above are a real distinction:
  // repo-wide sees the same two files and annexes the second one.
  const wide = planUpdate(files, allowlist, null);
  assert.equal(wide.next.get('packages/b/slack.ts'), 450);
  assert.deepEqual(wide.lowered, ['  packages/b/slack.ts: 450 lines, budget 460 (-10)']);
});

test('planUpdate drops a vanished row only when the change touched that path', () => {
  const files = [{ rel: 'packages/a/big.ts', lines: 500 }];
  const allowlist = new Map([
    ['packages/a/big.ts', 500],
    ['packages/c/deleted.ts', 700],
    ['packages/d/elsewhere.ts', 800],
  ]);

  const scoped = planUpdate(files, allowlist, new Set(['packages/c/deleted.ts']));
  assert.equal(scoped.next.has('packages/c/deleted.ts'), false, 'this change deleted it, so its row goes');
  assert.equal(
    scoped.next.get('packages/d/elsewhere.ts'),
    800,
    'a row that vanished for someone ELSE is still their exemption',
  );
  assert.deepEqual(scoped.removed, [
    '  packages/c/deleted.ts (budget 700) no longer matches a tracked file',
  ]);

  const wide = planUpdate(files, allowlist, null);
  assert.equal(wide.next.has('packages/d/elsewhere.ts'), false);
  assert.equal(wide.removed.length, 2);
});

// A row at or under the limit grants no exemption and is a HARD gate failure
// (`staleRows`). Scoping must not carry it forward: the carry-forward rule
// exists to protect an exemption someone ELSE still needs, and this row is not
// one. Both loops in planUpdate reach it — the measured file and the vanished
// file — so both are pinned here, each against the real exemption that must
// survive the same call.
test('planUpdate drops a row granting no exemption even out of scope, and keeps real ones', () => {
  const files = [
    { rel: 'packages/a/big.ts', lines: 520 },
    { rel: 'packages/b/shrunk.ts', lines: 300 },
  ];
  const allowlist = new Map([
    ['packages/a/big.ts', 500],
    ['packages/b/shrunk.ts', 380], // measured: hand-edited under the limit
    ['packages/c/vanished.ts', 390], // unmeasured: under the limit, file gone
    ['packages/d/real.ts', 800], // unmeasured: a genuine exemption
  ]);

  // Nothing in `changed`: every row below is OUT of scope, which is the whole
  // point — the deletions must happen anyway, the preservation must still hold.
  const scoped = planUpdate(files, allowlist, new Set(['packages/z/unrelated.ts']));

  assert.equal(scoped.next.has('packages/b/shrunk.ts'), false, 'measured loop: 380 <= 400 grants nothing');
  assert.equal(scoped.next.has('packages/c/vanished.ts'), false, 'vanished loop: 390 <= 400 grants nothing');
  assert.equal(scoped.next.get('packages/d/real.ts'), 800, 'a REAL out-of-scope exemption survives');
  assert.equal(scoped.next.get('packages/a/big.ts'), 500, 'an out-of-scope row keeps its COMMITTED budget');
  assert.deepEqual(scoped.removed.sort(), [
    '  packages/b/shrunk.ts: budget 380 <= 400 granted nothing (row deleted)',
    '  packages/c/vanished.ts: budget 390 <= 400 granted nothing (row deleted)',
  ]);

  // The control that makes the preservation above a real distinction: repo-wide
  // drops packages/d/real.ts too, so `next` differs between the two calls.
  const wide = planUpdate(files, allowlist, null);
  assert.equal(wide.next.has('packages/d/real.ts'), false);
  assert.equal(wide.next.get('packages/a/big.ts'), 520, 'repo-wide re-records the measured count');
});

// `grantsNoExemption` drops a row that grants nothing, at any scope. That is
// safe while the FILE is also under the limit. It is not safe when the row is
// sub-limit but the file measures OVER it: dropping the row then converts a
// stale-row failure into a `newOffenders` one, and that failure no scoped rerun
// can clear, because the file is out of scope by construction. The comment that
// shipped with the fix said "safe at any scope" — true of every case it was
// written against, false of this one.
test('an out-of-scope sub-limit row is KEPT when its file is over the limit', () => {
  const files = [
    { rel: 'packages/x/stranded.ts', lines: 450 }, // over LIMIT, row grants nothing
    { rel: 'packages/y/touched.ts', lines: 410 },
  ];
  const allowlist = new Map([
    ['packages/x/stranded.ts', 400],
    ['packages/y/touched.ts', 415],
  ]);
  const scoped = planUpdate(files, allowlist, new Set(['packages/y/touched.ts']));

  assert.equal(
    scoped.next.get('packages/x/stranded.ts'),
    400,
    'dropping this row would make the file a newOffender no scoped run can fix',
  );
  assert.equal(scoped.removed.length, 0);

  // The control that keeps the assertion honest: the same row IS dropped when
  // its file is under the limit, so this is a real distinction and not the
  // rule being disabled.
  const under = planUpdate(
    [{ rel: 'packages/x/stranded.ts', lines: 300 }, { rel: 'packages/y/touched.ts', lines: 410 }],
    allowlist,
    new Set(['packages/y/touched.ts']),
  );
  assert.equal(under.next.has('packages/x/stranded.ts'), false);
  assert.equal(under.removed.length, 1);
});
