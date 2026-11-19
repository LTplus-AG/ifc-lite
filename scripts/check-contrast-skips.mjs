#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * CI gate: a viewer test shard must not skip any contrast test for want of a
 * browser. The harness fails instead of skipping in CI; this checks the
 * outcome, so a later change to that rule cannot pass a shard that measured
 * nothing.
 *
 *   node scripts/check-contrast-skips.mjs apps/viewer/mergify-junit.xml
 *
 * Exits 1 when a report is missing (no report is not evidence of no skips) or
 * holds any such skip.
 */

import { existsSync, readFileSync } from 'node:fs';
import { isMainEntry } from './lib/is-main-entry.mjs';
import { contrastSkipSummary, countJunitContrastSkips } from './lib/contrast-skips.mjs';

/** @returns {{ ok: boolean, message: string }} */
export function checkContrastSkips(reportPaths) {
  if (reportPaths.length === 0) return { ok: false, message: 'usage: check-contrast-skips.mjs <junit.xml>...' };
  let skipped = 0;
  for (const path of reportPaths) {
    if (!existsSync(path)) return { ok: false, message: `${path} not found: cannot show that no contrast test was skipped` };
    skipped += countJunitContrastSkips(readFileSync(path, 'utf8'));
  }
  return skipped > 0
    ? { ok: false, message: `${contrastSkipSummary(skipped)} CI must run them.` }
    : { ok: true, message: `check-contrast-skips: 0 contrast tests skipped in ${reportPaths.join(', ')}` };
}

if (isMainEntry(import.meta.url)) {
  const { ok, message } = checkContrastSkips(process.argv.slice(2));
  (ok ? console.log : console.error)(message);
  process.exitCode = ok ? 0 : 1;
}
