/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Harness for `audit-test-timeouts.mjs`.
 *
 * An audit tool that misreports is worse than no audit: it converts "nobody
 * checked" into "someone checked and it was fine". Both defects pinned here
 * were IN the first version of that script, which is the whole reason this
 * file exists — the script was written to break a
 * grep-reports-absence-as-cleanliness pattern and shipped with two instances
 * of it.
 *
 * Run: node --test scripts/audit-test-timeouts.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'audit-test-timeouts.mjs');

function audit(source) {
  const dir = mkdtempSync(join(tmpdir(), 'audit-timeouts-'));
  try {
    writeFileSync(join(dir, 'probe.test.ts'), source);
    const out = execFileSync('node', [SCRIPT, dir], { encoding: 'utf8' });
    const num = (label) => Number(new RegExp(`${label}:\\s*(\\d+)`).exec(out)[1]);
    return {
      timed: num('tests with an explicit timeout'),
      untimed: num('tests on the default budget'),
      unparseable: num('calls this audit could not parse'),
      out,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('an options bag INSIDE the body does not mark a test timed', () => {
  // The dangerous direction. A false TIMED hides a gap, and the tests most
  // likely to carry a body-level `{ timeout: N }` are subprocess and waitFor
  // tests — exactly the slow class this audit exists to surface.
  const r = audit(`
it('spawns a subprocess with its own timeout option', async () => {
  await execFileAsync('node', ['x.js'], { timeout: 120_000, maxBuffer: 64 * 1024 });
});
it('waits with an option bag', async () => {
  await vi.waitFor(() => ready, { timeout: 1000 });
});
it('genuinely timed', { timeout: 30_000 }, async () => { expect(1).toBe(1); });
`);
  assert.equal(r.timed, 1, 'only the real per-test timeout counts');
  assert.equal(r.untimed, 2);
});

test('an apostrophe in a COMMENT does not swallow the rest of the file', () => {
  // The silent direction. The first version treated the apostrophe as a string
  // opener, scanned to EOF, returned -1 and `continue`d — dropping the call
  // from timed, from untimed, and from the gap list. 449 of 13016 tests
  // vanished, and the audit looked cleaner for it.
  const r = audit(`
it('first, no timeout', async () => {
  // the worker doesn't come back before the poll
  expect(1).toBe(1);
});
it('second, bounded', async () => { expect(1).toBe(1); }, 30_000);
`);
  assert.equal(r.unparseable, 0, 'nothing may be dropped silently');
  assert.equal(r.timed, 1);
  assert.equal(r.untimed, 1);
});

test('all three spellings of a per-test timeout are recognised', () => {
  const r = audit(`
it('trailing', async () => { expect(1).toBe(1); }, 30_000);
it('options', { timeout: 30_000 }, async () => { expect(1).toBe(1); });
it(
  'multi-line trailing',
  async () => { expect(1).toBe(1); },
  30_000,
);
`);
  assert.equal(r.timed, 3, 'one spelling must not hide the others');
  assert.equal(r.untimed, 0);
});

test('an unparseable call is reported, never dropped', () => {
  // Absence must look different from success. If the parser ever fails, the
  // count is what says so.
  const r = audit(`it('unterminated', async () => { expect(1).toBe(1); }\n`);
  assert.equal(r.unparseable, 1);
  assert.equal(r.timed + r.untimed, 0);
});

test('a commented-out test is not counted', () => {
  const r = audit(`
// it('disabled', async () => { expect(1).toBe(1); });
it('live', async () => { expect(1).toBe(1); });
`);
  assert.equal(r.timed + r.untimed, 1);
});

test('a regex literal containing a quote does not swallow the file', () => {
  // Same class as the comment apostrophe, found by adversarial probing after
  // that one was fixed: `/it's fine/` opened a spurious string and the scan ran
  // to EOF. Division must still read as division.
  const r = audit(`
it('regex holding a quote', async () => {
  const re = /it's fine/;
});
it('regex with a slash class', async () => {
  const re = /[/'"]+/g;
});
it('division, not a regex', async () => {
  const x = 10 / 2 / 1;
});
it('bounded', async () => { expect(1).toBe(1); }, 30_000);
`);
  assert.equal(r.unparseable, 0);
  assert.equal(r.timed, 1);
  assert.equal(r.untimed, 3);
});

test('the audit is fast enough to actually run', () => {
  // Not a micro-benchmark: the first version did `src.split('')`, allocating a
  // string per character of every file. It took 5.5 minutes on packages/ and
  // exhausted the heap, which makes an audit nobody runs.
  const big = Array.from(
    { length: 400 },
    (_, i) => `it('case ${i}', async () => {\n  // a comment that doesn't parse trivially\n  expect(${i}).toBe(${i});\n});`,
  ).join('\n');
  const t0 = Date.now();
  const r = audit(big);
  const ms = Date.now() - t0;
  assert.equal(r.untimed, 400);
  assert.ok(ms < 10_000, `audit took ${ms}ms on 400 tests; it should be well under 10s`);
});
