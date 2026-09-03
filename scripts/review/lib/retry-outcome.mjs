#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * WHAT THE VALIDATE STEP DOES AFTER THE ONE RETRY.
 *
 * WHY THIS IS A SCRIPT AND NOT BASH. It used to be an `if` in claude-review.yml,
 * and the only way to test an `if` in YAML is to read the YAML as TEXT and assert
 * on its characters -- which this repository forbids, and rightly: a
 * string-ordering assertion passes when the step is reworded into something that
 * does not work, and fails when the step is reformatted into something that
 * does. It measures the file, not the behaviour. Moving the DECISION into a
 * module leaves the workflow with one thing to get right (it calls this), and
 * that one thing is what check-test-wiring already knows how to check.
 *
 * THE THREE OUTCOMES:
 *
 *   post     The validator succeeded (on the first attempt or the retry). The
 *            step exits 0 and the lane posts the findings.
 *
 *   fail     Anything else, including -- and this is the case worth naming -- a
 *            retry whose REVIEWER crashed. validate.log is rewritten by the
 *            second VALIDATE, not by the attempt, so a crashed reviewer leaves
 *            the FIRST attempt's `❌ VALIDATION_EMPTY:` sitting in the file. An
 *            unguarded read would post a marker asserting the retry refused
 *            everything, about a run that never produced an answer. `revalidated`
 *            is the whole guard: it says a second validate actually ran.
 *
 *   dropped  The retry ran, re-validated, and every finding was refused again.
 *            The head gets a `verdict=dropped` marker instead of a red nobody can
 *            clear (#3775). The step exits 0 having set `uncovered=true`, which
 *            claude-review.yml routes to the marker path; the gate reads
 *            `dropped` as NOT covered, so the next run reviews the head again.
 *
 * The reason file is written DROPPED-LINES-FIRST, because the `❌` line's own
 * text says "read the DROPPED warnings above" and in the posted comment body
 * that has to be true.
 *
 * The log is matched line-anchored on `DROPPED_LOG_PREFIX` and on `❌ REASON:`,
 * and validate-findings.mjs sanitises every path it interpolates, so
 * PR-controlled bytes cannot forge either.
 */

import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { isMainEntry } from '../../lib/is-main-entry.mjs';
import { DROPPED_LOG_PREFIX } from './dropped-warning.mjs';

/** The validator reason that earns a marker rather than a red. */
const DOWNGRADABLE_REASON = 'VALIDATION_EMPTY';

/**
 * Decide, from what the step already knows.
 *
 * @param {{rc: number, revalidated: boolean, log: string}} input
 *   `rc` the validator's exit code after any retry, `revalidated` whether a
 *   SECOND validate actually ran, `log` the contents of validate.log.
 * @returns {{outcome: 'post'|'fail'|'dropped', exitCode: number, reason: string[], note: string}}
 */
export function decideRetryOutcome({ rc, revalidated, log }) {
  const lines = String(log ?? '').split('\n');
  const reasonLine = lines.find((l) => l.startsWith(`❌ ${DOWNGRADABLE_REASON}:`));

  if (rc === 0) {
    return { outcome: 'post', exitCode: 0, reason: [], note: 'The validator succeeded; posting the review.' };
  }
  if (!revalidated) {
    return {
      outcome: 'fail',
      exitCode: rc,
      reason: [],
      note:
        'No second validation ran, so validate.log describes the FIRST attempt. Failing the step rather ' +
        'than posting a marker about a retry that never produced an answer.',
    };
  }
  if (!reasonLine) {
    return {
      outcome: 'fail',
      exitCode: rc,
      reason: [],
      note: `The retry failed for a reason other than ${DOWNGRADABLE_REASON}; failing the step.`,
    };
  }
  return {
    outcome: 'dropped',
    exitCode: 0,
    // DROPPED LINES FIRST, then the reason that cites them as "above".
    reason: [...lines.filter((l) => l.startsWith(DROPPED_LOG_PREFIX)), reasonLine],
    note:
      'Every finding was dropped, and the retry did not change that; posting a dropped marker instead ' +
      'of a red nobody can clear.',
  };
}

/** @param {string[]} argv */
export function parseArgs(argv) {
  const out = { rc: null, revalidated: false, log: null, reasonOut: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--revalidated') {
      out.revalidated = true;
      continue;
    }
    const key = { '--rc': 'rc', '--log': 'log', '--reason-out': 'reasonOut' }[argv[i]];
    if (!key) throw new Error(`Unrecognised argument \`${argv[i]}\`.`);
    const v = argv[i + 1];
    if (v === undefined) throw new Error(`\`${argv[i]}\` needs a value.`);
    out[key] = key === 'rc' ? Number(v) : v;
    i += 1;
  }
  if (!Number.isInteger(out.rc)) throw new Error('Pass `--rc <exit code of the validator>`.');
  if (!out.log) throw new Error('Pass `--log <path to validate.log>`.');
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  // A MISSING LOG IS NOT AN EMPTY ONE. Reading '' would make every reason line
  // absent and turn a downgradable failure into a plain one -- quietly the safe
  // direction, but for a reason nobody could see. It throws instead.
  const log = readFileSync(args.log, 'utf8');
  const decision = decideRetryOutcome({ rc: args.rc, revalidated: args.revalidated, log });

  console.log(`retry-outcome: ${decision.outcome}. ${decision.note}`);
  if (decision.outcome === 'dropped') {
    if (args.reasonOut) writeFileSync(args.reasonOut, `${decision.reason.join('\n')}\n`);
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, 'uncovered=true\n');
  }
  process.exit(decision.exitCode);
}

if (isMainEntry(import.meta.url)) main();
