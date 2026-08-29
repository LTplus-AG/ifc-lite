/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
/**
 * Regression harness for the pure half of the #3443 gate.
 *
 * Two fixtures anchor everything else: #3411 (live, `CONFLICTING`/`DIRTY`,
 * none of the 15 `test.yml` lanes present) must report, and #3417 (live,
 * also `CONFLICTING`, but all 15 lanes already ran before it went dirty) must
 * NOT -- distinguishing those two is the entire point of comparing lane NAMES
 * rather than a row-count floor. See scripts/lib/dirty-pr-scan.mjs.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { DirtyPrScanError, missingLanes, classifyPr, scanPrs, report } from './dirty-pr-scan.mjs';

const REQUIRED = ['Lint', 'Node tests', 'Rust tests', 'Typecheck'];

function lane(name) {
  return { name };
}

test('missingLanes: empty rollup means every required lane is missing', () => {
  assert.deepEqual(missingLanes(REQUIRED, []), [...REQUIRED].sort());
});

test('missingLanes: only names absent from the rollup are returned', () => {
  assert.deepEqual(missingLanes(REQUIRED, [lane('Lint'), lane('Typecheck')]), ['Node tests', 'Rust tests']);
});

test('missingLanes: falls back to `context` for commit-status style entries', () => {
  assert.deepEqual(missingLanes(['CodeRabbit'], [{ context: 'CodeRabbit' }]), []);
});

test('classifyPr: RED fixture -- CONFLICTING/DIRTY with no required lane present is silent', () => {
  // Shape of live PR #3411 the night #3443 was filed: Vercel/CodeRabbit rows
  // only, none of the compile/test lanes.
  const pr = {
    number: 3411,
    title: 'fix(core): order-independence',
    url: 'https://github.com/LTplus-AG/ifc-lite/pull/3411',
    mergeable: 'CONFLICTING',
    mergeStateStatus: 'DIRTY',
    isDraft: false,
    statusCheckRollup: [lane('Vercel Agent Review'), lane('Vercel Preview Comments')],
  };
  const result = classifyPr(pr, REQUIRED);
  assert.equal(result.silent, true);
  assert.equal(result.rollupCount, 2);
  assert.deepEqual(result.missing, [...REQUIRED].sort());
});

test('classifyPr: GREEN fixture -- CONFLICTING but every required lane already ran is not silent', () => {
  // Shape of live PR #3417: went dirty AFTER its lanes ran. Row-counting alone
  // cannot separate this from #3411 -- #3417 had 40 rows, #3411 had 19 -- so
  // this must key off lane NAMES, not a count.
  const pr = {
    number: 3417,
    mergeable: 'CONFLICTING',
    mergeStateStatus: 'DIRTY',
    isDraft: false,
    statusCheckRollup: REQUIRED.map(lane).concat([lane('Vercel Agent Review')]),
  };
  const result = classifyPr(pr, REQUIRED);
  assert.equal(result.silent, false);
  assert.deepEqual(result.missing, []);
});

test('classifyPr: GREEN fixture -- clean, mergeable PR with lanes missing is not this gate\'s finding', () => {
  // A missing lane on an otherwise-mergeable PR is a different problem (still
  // queued, a path filter, a real failure) -- out of scope on purpose.
  const pr = {
    number: 9001,
    mergeable: 'MERGEABLE',
    mergeStateStatus: 'BLOCKED',
    statusCheckRollup: [],
  };
  const result = classifyPr(pr, REQUIRED);
  assert.equal(result.silent, false);
});

test('classifyPr: UNKNOWN mergeable with missing lanes is advisory, never silent', () => {
  const pr = { number: 9002, mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN', statusCheckRollup: [] };
  const result = classifyPr(pr, REQUIRED);
  assert.equal(result.silent, false);
  assert.equal(result.unknownAdvisory, true);
});

test('classifyPr: fails closed on a PR object missing a numeric `number`', () => {
  assert.throws(() => classifyPr({ mergeable: 'CONFLICTING' }, REQUIRED), (err) => {
    assert.ok(err instanceof DirtyPrScanError);
    assert.equal(err.reason, 'BAD_PR');
    return true;
  });
});

test('classifyPr: fails closed on an empty required set', () => {
  assert.throws(() => classifyPr({ number: 1 }, []), (err) => {
    assert.ok(err instanceof DirtyPrScanError);
    assert.equal(err.reason, 'EMPTY_REQUIRED_SET');
    return true;
  });
});

test('scanPrs: fails closed on a non-array input rather than reading it as "no open PRs"', () => {
  assert.throws(() => scanPrs({ not: 'an array' }, REQUIRED), (err) => {
    assert.ok(err instanceof DirtyPrScanError);
    assert.equal(err.reason, 'BAD_INPUT');
    return true;
  });
});

test('scanPrs + report: RED -- a scan containing the #3411 shape fails and names the PR', () => {
  const prs = [
    {
      number: 3411,
      mergeable: 'CONFLICTING',
      mergeStateStatus: 'DIRTY',
      statusCheckRollup: [lane('Vercel Agent Review')],
    },
    {
      number: 3417,
      mergeable: 'CONFLICTING',
      mergeStateStatus: 'DIRTY',
      statusCheckRollup: REQUIRED.map(lane),
    },
  ];
  const results = scanPrs(prs, REQUIRED);
  const { ok, lines } = report(results, REQUIRED);
  assert.equal(ok, false);
  assert.ok(lines.some((l) => l.includes('#3411')));
  assert.ok(!lines.some((l) => l.includes('#3417 ')));
});

test('scanPrs + report: GREEN -- an all-clean scan with lanes present passes', () => {
  const prs = [
    { number: 1, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', statusCheckRollup: REQUIRED.map(lane) },
    { number: 2, mergeable: 'MERGEABLE', mergeStateStatus: 'BLOCKED', statusCheckRollup: REQUIRED.map(lane) },
  ];
  const results = scanPrs(prs, REQUIRED);
  const { ok, lines } = report(results, REQUIRED);
  assert.equal(ok, true);
  assert.ok(lines.some((l) => l.startsWith('✅')));
});

test('scanPrs + report: GREEN -- zero open PRs passes trivially', () => {
  const { ok, lines } = report(scanPrs([], REQUIRED), REQUIRED);
  assert.equal(ok, true);
  assert.ok(lines[0].includes('Scanned 0 open PR'));
});
