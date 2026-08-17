#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Regression harness for scripts/check-clash-degenerate-reason-parity.mjs.
 *
 * A parity gate that silently matches nothing is worse than no gate, so each
 * way it could go false-green is an executable case here: a reason removed from
 * the TS union, a reason added on the Rust side, and either extractor broken so
 * it returns the empty set (the vacuity guard — two empty sets are "equal").
 *
 * Method matches scripts/check-server-bin-targets.test.mjs: mutate a copy of
 * the REAL sources in a temp tree outside the repo, run the UNMODIFIED checker
 * against it via `--root`, and assert exit code plus message. Every mutation
 * anchor is asserted to exist in the real input first, so a drifted anchor
 * fails the suite instead of quietly testing nothing.
 *
 * Run: node --test scripts/check-clash-degenerate-reason-parity.test.mjs
 * (wired as a step of the CI node-test job in .github/workflows/test.yml).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { kernelReasons, declaredReasons } from './check-clash-degenerate-reason-parity.mjs';

const SCRIPTS = dirname(fileURLToPath(import.meta.url));
const ROOT = join(SCRIPTS, '..');
const CHECKER = join(SCRIPTS, 'check-clash-degenerate-reason-parity.mjs');

const RUST_REL = 'rust/wasm-bindings/src/api/clash_solid.rs';
const TS_REL = 'apps/viewer/src/lib/clash/intersection-solid.ts';

const realRust = readFileSync(join(ROOT, RUST_REL), 'utf8');
const realTs = readFileSync(join(ROOT, TS_REL), 'utf8');

/** Writes a (possibly mutated) tree to a temp dir and runs the checker on it. */
function runOn({ rust = realRust, ts = realTs }) {
  const dir = mkdtempSync(join(tmpdir(), 'clash-reason-parity-'));
  try {
    for (const [rel, content] of [[RUST_REL, rust], [TS_REL, ts]]) {
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
  assert.match(out, /check-clash-degenerate-reason-parity: OK/);
});

test('RED when a member is removed from the TS union', () => {
  const ts = replaceOnce(realTs, "  | 'malformed-operand'\n", '');
  const { status, out } = runOn({ ts });
  assert.equal(status, 1, out);
  assert.match(out, /kernel can emit 'malformed-operand' but ClashSolidDegenerateReason does not declare it/);
});

test('RED when a reason literal is added on the Rust side', () => {
  const rust = replaceOnce(
    realRust,
    'DegenerateReason::NoOverlap => ("no-overlap", 0.0, 0.0),',
    'DegenerateReason::NoOverlap => ("no-overlap", 0.0, 0.0),\n                DegenerateReason::Invented => ("invented-reason", 0.0, 0.0),',
  );
  const { status, out } = runOn({ rust });
  assert.equal(status, 1, out);
  assert.match(out, /kernel can emit 'invented-reason' but ClashSolidDegenerateReason does not declare it/);
});

test('RED when the union declares a reason the kernel cannot emit', () => {
  const ts = replaceOnce(realTs, "  | 'no-overlap'\n", "  | 'no-overlap'\n  | 'phantom-reason'\n");
  const { status, out } = runOn({ ts });
  assert.equal(status, 1, out);
  assert.match(out, /declares 'phantom-reason' but the kernel can never emit it/);
});

test('RED (vacuity guard) when the Rust extractor finds nothing', () => {
  // Nothing left for either Rust pattern to match: the gate must fail rather
  // than compare an empty set against an empty set and call that parity.
  const { status, out } = runOn({ rust: '// no reasons here at all\n' });
  assert.equal(status, 1, out);
  assert.match(out, /no reason strings extracted from/);
});

test('RED (vacuity guard) when the TS extractor finds nothing', () => {
  const { status, out } = runOn({ ts: '// the union has been renamed away\n' });
  assert.equal(status, 1, out);
  assert.match(out, /no members extracted from ClashSolidDegenerateReason/);
});

test('RED (vacuity guard) when BOTH extractors find nothing — two empty sets are not parity', () => {
  const { status, out } = runOn({ rust: '// nothing\n', ts: '// nothing\n' });
  assert.equal(status, 1, out);
  assert.match(out, /no reason strings extracted from/);
  assert.match(out, /no members extracted from ClashSolidDegenerateReason/);
});

test('a reason named only in a comment does not count, on either side', () => {
  assert.deepEqual([...kernelReasons('    // - `"invented-reason"` — prose only.\n')], []);
  assert.deepEqual(
    [...declaredReasons(
      "export type ClashSolidDegenerateReason =\n  /** prose about 'invented-reason' */\n  | 'no-overlap';",
    )],
    ['no-overlap'],
  );
});

test('a reason named only in a Rust #[cfg(test)] module does not count', () => {
  const rust = `${realRust}\n#[cfg(test)]\nmod tests {\n    const X: &str = "test-only-reason";\n}\n`;
  const { status, out } = runOn({ rust });
  assert.equal(status, 0, out);
});
