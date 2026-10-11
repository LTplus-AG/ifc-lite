#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * IDS lint precision report (IDS-054).
 *
 * Lints the buildingSMART conformance corpus (pass- and fail- cases: valid
 * IDS documents) and the internal lint corpus (test/lint-corpus/*.ids), and
 * checks every finding against test/lint-corpus/labels.json.
 *
 *   pnpm turbo build --filter=@ifc-lite/ids-authoring...
 *   node packages/ids-authoring/scripts/lint-precision.mjs [--json] [--unlabelled]
 *
 * Exits 1 when precision is below 95 % or a finding is unlabelled. The
 * package test src/lint/precision.test.ts enforces the same in CI.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkg = fileURLToPath(new URL('../', import.meta.url));
const { parseIDS } = await import('@ifc-lite/ids');
const { createLintContext } = await import(new URL('../dist/lint/context.js', import.meta.url).href);
const { measurePrecision } = await import(new URL('../dist/lint/precision.js', import.meta.url).href);
const { loadPrecisionCases } = await import(new URL('./precision-cases.mjs', import.meta.url).href);

const labels = JSON.parse(readFileSync(join(pkg, 'test/lint-corpus/labels.json'), 'utf8'));
const cases = loadPrecisionCases(pkg, { parseIDS, readdirSync, readFileSync, join });
const report = measurePrecision(cases, labels, await createLintContext());

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(report, null, 2));
} else if (process.argv.includes('--unlabelled')) {
  for (const k of report.unlabelled) console.log(k);
} else {
  const pct = (x) => `${(x * 100).toFixed(1)} %`;
  console.log(`IDS lint precision: ${report.files} files, ${report.findings} findings`);
  console.log(`  all findings:            ${pct(report.precision)}`);
  console.log(`  warning + error only:    ${pct(report.precisionWarnError)}`);
  console.log('\n| Rule | Severity | Justified | False positive | Unlabelled |\n|---|---|---|---|---|');
  for (const t of report.rules) console.log(`| ${t.code} | ${t.severity} | ${t.justified} | ${t.falsePositive} | ${t.unlabelled} |`);
  if (report.unusedLabels.length) console.log(`\nstale labels: ${report.unusedLabels.length}`);
}
const ok = report.precision >= 0.95 && report.unlabelled.length === 0;
process.exit(ok ? 0 : 1);
