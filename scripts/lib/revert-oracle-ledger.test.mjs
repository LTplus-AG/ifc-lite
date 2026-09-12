/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import test from 'node:test';
import assert from 'node:assert/strict';

import { ledgerVerdict } from './revert-oracle-ledger.mjs';

const pass = (total = 2) => ({ kind: 'pass', passed: total, failed: 0, total, evidence: [] });
const red = (total = 2) => ({ kind: 'assertion-failure', passed: total - 1, failed: 1, total, evidence: ['named assertion'] });

test('#4109: one attributable witness survives an unrelated capability gap', () => {
  const verdict = ledgerVerdict([
    { file: 'a.test.ts', role: 'executable', runKey: 'a', baseline: pass(), reverted: red() },
    { file: 'tests/helper.rs', role: 'capability-gap', reason: 'Rust module cannot be invoked as a target' },
  ]);
  assert.equal(verdict.verdict, 'OBSERVED');
  assert.equal(verdict.witness.file, 'a.test.ts');
});

test('#4109: UNOBSERVED requires complete measurements for every executable', () => {
  assert.equal(ledgerVerdict([
    { file: 'a.test.ts', role: 'executable', baseline: pass(), reverted: pass() },
    { file: 'b.test.ts', role: 'executable', baseline: pass(), reverted: { kind: 'no-tests', total: 0 } },
  ]).verdict, 'INCONCLUSIVE');
  assert.equal(ledgerVerdict([
    { file: 'a.test.ts', role: 'executable', baseline: pass(), reverted: pass() },
    { file: 'b.test.ts', role: 'executable', baseline: pass(3), reverted: pass(3) },
  ]).verdict, 'UNOBSERVED');
});

test('#4109: an all-skipped baseline is broken, never synthetic coverage', () => {
  assert.equal(ledgerVerdict([
    { file: 'a.test.ts', role: 'executable', baseline: { kind: 'all-skipped', total: 4 }, reverted: pass() },
  ]).verdict, 'BASELINE-BROKEN');
});
