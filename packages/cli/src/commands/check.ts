/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * ifc-lite check <model.ifc>... --rules <file.rules.json> [--format json|table] [--fail-on error|warning]
 *
 * Run a `.rules.json` information-validation rule set (the SAME `@ifc-lite/rules`
 * engine the viewer's Data Validation panel runs, #5138 PR 7a) against one or
 * more already-parsed models. No second evaluator, no parity fixture.
 *
 * Exit codes, tri-state (never folded into two):
 *  - `0` — every rule passed (or was not applicable).
 *  - `1` — at least one rule FAILED at a severity `--fail-on` counts (default
 *          `error`: `severity:'warning'` rules never fail the run; pass
 *          `--fail-on warning` to make them count too).
 *  - `2` — a model could not be read/parsed, or the engine itself could not
 *          evaluate a rule (`SpecificationResult.error` set — e.g. a
 *          ReDoS-rejected regex). This always wins over `1`: an unevaluated
 *          rule is not evidence either way, so it can never read as a clean
 *          `1`-vs-`0` verdict.
 */

import { readFile } from 'node:fs/promises';
import { getFlag, fatal, printJson } from '../output.js';
import { loadModelForDelivery } from './delivery-checks.js';
import { parseRuleSetFile, runRuleSet, type EvaluatorModel } from '@ifc-lite/rules';
import type { ValidationReport } from '@ifc-lite/ids';

const FORMATS = ['json', 'table'] as const;
type CheckFormat = (typeof FORMATS)[number];

const FAIL_ON_VALUES = ['error', 'warning'] as const;
type FailOn = (typeof FAIL_ON_VALUES)[number];

const USAGE = 'Usage: ifc-lite check <model.ifc>... --rules <file.rules.json> [--format json|table] [--fail-on error|warning]';

export async function checkCommand(args: string[]): Promise<void> {
  const rulesPath = getFlag(args, '--rules');
  if (!rulesPath) fatal(USAGE);

  const format = (getFlag(args, '--format') ?? 'table') as CheckFormat;
  if (!FORMATS.includes(format)) fatal(`--format must be one of: ${FORMATS.join(', ')}`);

  const failOn = (getFlag(args, '--fail-on') ?? 'error') as FailOn;
  if (!FAIL_ON_VALUES.includes(failOn)) fatal(`--fail-on must be one of: ${FAIL_ON_VALUES.join(', ')}`);

  const modelPaths: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('-')) {
      if (args[i] === '--rules' || args[i] === '--format' || args[i] === '--fail-on') i++; // skip value
      continue;
    }
    modelPaths.push(args[i]);
  }
  if (modelPaths.length === 0) fatal(USAGE);

  let rulesRaw: string;
  try {
    rulesRaw = await readFile(rulesPath, 'utf-8');
  } catch (err) {
    fatal(`Rules file "${rulesPath}" could not be read: ${(err as Error).message}`);
  }

  let rulesJson: unknown;
  try {
    rulesJson = JSON.parse(rulesRaw);
  } catch (err) {
    fatal(`Rules file "${rulesPath}" is not valid JSON: ${(err as Error).message}`);
  }

  const parsed = parseRuleSetFile(rulesJson);
  if (!parsed.ok) fatal(`Rules file "${rulesPath}" is invalid: ${parsed.error}`);

  // Every model is loaded before any rule runs — an unreadable model is
  // `error` (exit 2), never a report silently scoped down to the models
  // that DID parse (that would misrepresent what was actually checked).
  const models: EvaluatorModel[] = [];
  for (const modelPath of modelPaths) {
    const loaded = await loadModelForDelivery(modelPath);
    if ('error' in loaded) {
      process.stderr.write(`Error: model "${modelPath}" ${loaded.error}\n`);
      process.exitCode = 2;
      return;
    }
    models.push({ id: modelPath, filterIdentity: loaded.sha256, store: loaded.store });
  }

  const report = await runRuleSet({ ruleSet: parsed.file, models });

  if (format === 'json') {
    printJson(report);
  } else {
    printHumanTable(report, rulesPath);
  }

  const severityById = new Map(parsed.file.rules.map((r) => [r.id, r.severity ?? 'error'] as const));
  process.exitCode = exitCodeFor(report, severityById, failOn);
}

/** Never `0`/`1` when any rule was unevaluable — see the module doc. */
function exitCodeFor(
  report: ValidationReport,
  severityById: ReadonlyMap<string, 'error' | 'warning'>,
  failOn: FailOn,
): 0 | 1 | 2 {
  if (report.specificationResults.some((r) => r.error !== undefined)) return 2;

  const hardFail = report.specificationResults.some((r) => {
    if (r.status !== 'fail') return false;
    const severity = severityById.get(r.specification.id) ?? 'error';
    return severity === 'warning' ? failOn === 'warning' : true;
  });
  return hardFail ? 1 : 0;
}

function printHumanTable(report: ValidationReport, rulesPath: string): void {
  const ruleSetName = report.source.kind === 'rules' ? report.source.ruleSet.name : rulesPath;
  process.stdout.write(`\n  Rule check: ${rulesPath} (${ruleSetName})\n\n`);

  for (const spec of report.specificationResults) {
    const status = spec.error !== undefined ? 'ERR ' : spec.status === 'pass' ? 'PASS' : spec.status === 'fail' ? 'FAIL' : 'N/A ';
    const setFailures = (spec.setResults ?? []).filter((s) => !s.passed).length;
    const setInfo = setFailures > 0 ? `, ${setFailures} set failure(s)` : '';
    const errInfo = spec.error !== undefined ? ` — ${spec.error}` : '';
    process.stdout.write(
      `  [${status}] ${spec.specification.name}  applicable=${spec.applicableCount} passed=${spec.passedCount} failed=${spec.failedCount}${setInfo}${errInfo}\n`,
    );
  }

  process.stdout.write(`\n  ${report.summary.passedSpecifications}/${report.summary.totalSpecifications} rules passed\n\n`);
}
