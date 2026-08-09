/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Building a submission and scoring it THROUGH THE REAL PIPELINE, split out of
 * run.mjs (AGENTS.md: no module over ~400 non-generated lines).
 *
 * The exam's credibility rests on this file not shortcutting: predictions are
 * serialized to the real JSONL submission format, parsed by the real
 * `parseSubmission`, and scored by the real `scoreSubmission`. A bespoke
 * in-memory scorer here would measure the exam's own arithmetic instead of the
 * benchmark's.
 */

import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { BENCHMARK_NAME, SPEC_VERSION, TASK_NAMES } from '../../../../tools/world-gym/benchmark/splits.mjs';
import { parseSubmission } from '../../../../tools/world-gym/benchmark/submission.mjs';
import { scoreSubmission } from '../../../../tools/world-gym/benchmark/score.mjs';

export function submissionText(name, split, predictions) {
  const header = { type: 'header', benchmark: BENCHMARK_NAME, specVersion: SPEC_VERSION, split, name, tasks: TASK_NAMES };
  return [header, ...predictions].map((o) => JSON.stringify(o)).join('\n') + '\n';
}

/** Score one prediction set through the real submission path. Returns the row. */
export async function scoreThroughRealPipeline({ name, split, predictions, truthBySeed, salt, outDir, write = true }) {
  const text = submissionText(name, split, predictions);
  if (write) await writeFile(join(outDir, `submission-${name}-${split}.jsonl`), text, 'utf-8');
  const parsed = parseSubmission(text, split);
  if (!parsed.ok) {
    throw new Error(`"${name}" produced an invalid submission:\n${parsed.errors.map((e) => `  - ${e}`).join('\n')}`);
  }
  return scoreSubmission(parsed.header, parsed.lines, split, truthBySeed, { salt });
}
