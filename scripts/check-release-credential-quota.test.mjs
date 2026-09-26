/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Executable proof for scripts/check-release-credential-quota.mjs (#5693):
// the pure verdict, and the CLI against a stub `gh` on PATH, including the
// reading that killed Release run 36009885836 (GraphQL quota at zero).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_FLOOR, quotaVerdict } from './check-release-credential-quota.mjs';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'check-release-credential-quota.mjs');
const NOW = 1_790_000_000;

const bucket = (remaining, resetIn = 1800) => ({ limit: 5000, remaining, used: 5000 - remaining, reset: NOW + resetIn });

test('both buckets above the floor pass', () => {
  assert.deepEqual(quotaVerdict({ core: bucket(4000), graphql: bucket(4000) }, { nowS: NOW }), { verdict: 'ok' });
});

test('a drained GraphQL bucket far from its reset fails, naming the bucket (the #5693 run)', () => {
  const r = quotaVerdict({ core: bucket(4000), graphql: bucket(0, 50 * 60) }, { nowS: NOW });
  assert.equal(r.verdict, 'fail');
  assert.deepEqual(
    r.short.map((s) => [s.bucket, s.remaining, s.floor]),
    [['graphql', 0, DEFAULT_FLOOR.graphql]]
  );
});

test('a low bucket that resets soon waits for the reset (plus the rollover second)', () => {
  const r = quotaVerdict({ core: bucket(10, 120), graphql: bucket(4000) }, { nowS: NOW });
  assert.equal(r.verdict, 'wait');
  assert.equal(r.waitS, 125);
});

test('the wait covers the LATER reset when both buckets are low', () => {
  const r = quotaVerdict({ core: bucket(10, 60), graphql: bucket(0, 300) }, { nowS: NOW });
  assert.equal(r.verdict, 'wait');
  assert.equal(r.waitS, 305);
});

test('the floor is inclusive: exactly the floor passes, one below does not', () => {
  const at = { core: bucket(DEFAULT_FLOOR.core), graphql: bucket(DEFAULT_FLOOR.graphql) };
  assert.equal(quotaVerdict(at, { nowS: NOW }).verdict, 'ok');
  const below = { core: bucket(DEFAULT_FLOOR.core - 1, 99_999), graphql: bucket(4000) };
  assert.equal(quotaVerdict(below, { nowS: NOW }).verdict, 'fail');
});

test('a reset already in the past waits only the rollover second', () => {
  const r = quotaVerdict({ core: bucket(0, -60), graphql: bucket(4000) }, { nowS: NOW });
  assert.equal(r.verdict, 'wait');
  assert.equal(r.waitS, 5);
});

test('a missing bucket is empty, not full (fail closed)', () => {
  assert.equal(quotaVerdict({ core: bucket(4000) }, { nowS: NOW }).verdict, 'fail');
  assert.equal(quotaVerdict(undefined, { nowS: NOW }).verdict, 'fail');
});

/** Run the CLI with a stub `gh` that prints `rateLimit` for `api rate_limit`, or fails. */
function runCli(rateLimit, args = []) {
  const dir = mkdtempSync(join(tmpdir(), 'quota-gh-'));
  try {
    const stub = join(dir, 'gh');
    const body =
      rateLimit === null
        ? 'echo "HTTP 401: Bad credentials" >&2; exit 1'
        : `case "$2" in rate_limit) cat <<'JSON'\n${JSON.stringify({ resources: rateLimit })}\nJSON\n;; user) echo release-bot ;; esac`;
    writeFileSync(stub, `#!/bin/sh\n${body}\n`);
    chmodSync(stub, 0o755);
    return spawnSync(process.execPath, [SCRIPT, ...args], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// The stub `gh` is a POSIX shell script; CI is Linux.
const cli = { skip: process.platform === 'win32' && 'stub gh is a POSIX shell script' };

const liveBucket = (remaining, resetIn) => ({ limit: 5000, remaining, used: 5000 - remaining, reset: Math.floor(Date.now() / 1000) + resetIn });

test('CLI: a healthy credential exits 0', cli, () => {
  const r = runCli({ core: liveBucket(4000, 1800), graphql: liveBucket(4000, 1800) });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /release credential quota ok: core 4000\/5000, graphql 4000\/5000/);
});

test('CLI: a drained account fails before the run mutates anything, naming the owner', cli, () => {
  const r = runCli({ core: liveBucket(4000, 3000), graphql: liveBucket(0, 3000) });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /::error title=Release credential out of API quota \(#5693\)::graphql: 0 left/);
  assert.match(r.stderr, /belongs to release-bot/);
});

test('CLI: an unreadable credential fails closed with status 2', cli, () => {
  const r = runCli(null);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /Release credential unreadable/);
});

test('CLI: --max-wait 0 turns a short wait into a failure', cli, () => {
  const r = runCli({ core: liveBucket(1, 30), graphql: liveBucket(4000, 1800) }, ['--max-wait', '0']);
  assert.equal(r.status, 1);
});

test('CLI: a drained bucket that is STILL drained after the wait fails (no second wait)', cli, () => {
  // The reset is in the past, so the first verdict waits 5 s; the stub still
  // reports the bucket empty after it, and the re-read must fail, not wait again.
  const r = runCli({ core: liveBucket(0, -60), graphql: liveBucket(4000, 1800) }, ['--max-wait', '10']);
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stdout, /::warning title=Release credential quota low \(#5693\)::core: 0 left/);
  assert.match(r.stderr, /::error title=Release credential out of API quota/);
});

test('CLI: a bad --max-wait is a usage error', cli, () => {
  for (const args of [['--max-wait', 'soon'], ['--max-wait', ''], ['--max-wait=10'], ['--max-wait', '-5']]) {
    const r = runCli({ core: liveBucket(4000, 1800), graphql: liveBucket(4000, 1800) }, args);
    assert.equal(r.status, 2, args.join(' '));
    assert.match(r.stderr, /usage:/);
  }
});
