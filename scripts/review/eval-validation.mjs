/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { RETRYABLE_VALIDATION_REASONS } from './retry-prompt.mjs';

export const REVIEWER_FAULT = new Set([
  'RAW_UNPARSEABLE',
  'RESPONSE_TRUNCATED',
  'SCHEMA_INVALID',
  'VERDICT_CONTRADICTS_FINDINGS',
  'CLASS_PASS_INCOMPLETE',
  'PROOF_OF_WORK_FAILED',
  'VALIDATION_EMPTY',
]);

export const INSTRUMENT_FAULT = new Set([
  'BAD_ARGS',
  'NO_RAW',
  'NO_INPUT',
  'NO_OUT',
  'RAW_UNREADABLE',
  'RAW_EMPTY',
  'INPUT_UNREADABLE',
  'INPUT_INVALID',
  'OUT_UNWRITABLE',
]);

export function validatorReason(said) {
  return /(?:^|\n)\u274c ([A-Z0-9_]+):/.exec(String(said))?.[1] ?? null;
}

function validate({ validatePath, outPath, inputPath, findingsPath }) {
  const processResult = spawnSync(
    process.execPath,
    [validatePath, '--raw', outPath, '--input', inputPath, '--out', findingsPath],
    { encoding: 'utf8' },
  );
  return {
    processResult,
    said: `${processResult.stdout || ''}${processResult.stderr || ''}`.trim(),
    reason: validatorReason(processResult.stderr || ''),
  };
}

/** Run the same single corrective validation retry as claude-review.yml. */
export function validateWithOneRetry({
  reviewer, rubric, inputPath, outPath, findingsPath, model, validatePath, retryLogPath,
}) {
  const first = validate({ validatePath, outPath, inputPath, findingsPath });
  if (first.processResult.status === 0 || !RETRYABLE_VALIDATION_REASONS.has(first.reason)) {
    return { ...first, attempts: 1, reviewerFailure: null };
  }

  // The workflow's tee captures both streams in one file and passes that path
  // back to run-reviewer. Preserve the same untrusted diagnostic envelope here.
  writeFileSync(retryLogPath, `${first.said}\n`);
  const retry = spawnSync(
    process.execPath,
    [reviewer, '--rubric', rubric, '--input', inputPath, '--out', outPath,
      '--retry-note', retryLogPath, '--retry-reason', first.reason, '--model', model],
    { encoding: 'utf8' },
  );
  if (retry.status !== 0) {
    return { ...first, attempts: 2, reviewerFailure: retry };
  }

  const second = validate({ validatePath, outPath, inputPath, findingsPath });
  return {
    ...second,
    said: [first.said, second.said].filter(Boolean).join('\n'),
    attempts: 2,
    reviewerFailure: null,
  };
}
