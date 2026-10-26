/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Scaffolding shared by the #6881 native functional harness and the hover
// cohort, so a fix to the deadline or driver-error policy reaches both.
import { existsSync, writeFileSync } from 'node:fs';

// Every page evaluation in a sample gets one fixed deadline; a hung page phase
// fails the sample instead of stalling an exclusive-admission run.
export function boundEvaluations(page, label) {
  const evaluate = page.evaluate.bind(page);
  page.evaluate = async (...args) => {
    let timer;
    try {
      return await Promise.race([evaluate(...args), new Promise((_, reject) => {
        timer = setTimeout(() => reject(Error(`${label} exceeded its fixed 30-second deadline`)), 30000);
      })]);
    } finally { clearTimeout(timer); }
  };
}

// Collects GPU driver errors that Chrome only reports on stderr into the record
// returned by `current()` under `field`. Returns the function that restores stderr.
export function tapDriverErrors(current, field) {
  const stderr = process.stderr.write.bind(process.stderr);
  process.stderr.write = function(chunk, ...args) {
    const line = String(chunk), record = current();
    if (record && /ERROR:gpu\/|GL_INVALID_|uninitialized SharedImage|GPU process.*crash/i.test(line)) record[field].push(line.trim());
    return stderr(chunk, ...args);
  };
  return () => { process.stderr.write = stderr; };
}

// Public fixtures are not committed (see tests/models/manifest.json). Like the
// repository's tests, a harness run without them reports a skip, never a pass:
// the result is written as not accepted with the reason and the run exits cleanly.
export function skipWhenFixturesMissing(output, paths) {
  const missing = paths.filter(path => !existsSync(path));
  if (!missing.length) return Promise.resolve();
  const reason = `SKIPPED (not a pass): fixture not found: ${missing.join(', ')}. Run \`pnpm fixtures\` and retry.`;
  writeFileSync(`${output}/result.json`, JSON.stringify({ accepted: false, skipped: true, reason, missing }, null, 2) + '\n');
  // Callers `await` this. When fixtures are missing it never settles: the process exits only once the
  // message is flushed (process.exit can drop pending pipe output), and no later code may run first.
  return new Promise(() => process.stdout.write(`${reason}\n`, () => process.exit(0)));
}
