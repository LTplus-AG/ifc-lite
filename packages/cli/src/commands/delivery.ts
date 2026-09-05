/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * ifc-lite delivery <recipe.json> [--json] [--out <report.json>] [--html <report.html>]
 *
 * Run a repeatable, reviewable model-delivery check from a saved recipe
 * (see `delivery-recipe.ts`): structural validation (the same rules
 * `ifc-lite validate` runs) and/or IDS validation (the same validator
 * `ifc-lite ids` runs), against one or more model files, in one invocation.
 *
 * Every check reports one of `pass` / `fail` / `error` — never folded
 * together (see `delivery-checks.ts`). The overall verdict is `pass` only
 * when every declared check on every declared model passed; an unreadable
 * model, an unreadable/empty IDS ruleset, or any failed check all produce a
 * `fail` verdict, matching the boundary in issue #3931: "Zero applicable
 * checks or an unreadable model must not be a successful delivery verdict."
 *
 * Output: a human-readable summary to stdout by default, `--json` for the
 * consolidated machine-readable report instead (or `--out <file>` to write
 * that JSON to disk rather than stdout), and `--html <file>` to additionally
 * write a standalone HTML report — the two forms the issue asks for,
 * produced by one invocation.
 *
 * Determinism: given the same recipe and the same bytes on disk, running
 * this command twice produces byte-identical `--json` output (see the
 * contract documented in `delivery-report.ts`).
 */

import { getFlag, hasFlag, fatal, printJson, writeOutput } from '../output.js';
import { readCliVersion } from '../version.js';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';
import { loadDeliveryRecipe } from './delivery-recipe.js';
import { loadModelForDelivery, runStructuralCheck, runIdsCheck, type IdsCheckResult, type StructuralCheckResult } from './delivery-checks.js';
import { buildDeliveryReport, renderDeliveryHtml, type DeliveryModelEntry, type DeliveryCheckResult } from './delivery-report.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI_VERSION = readCliVersion(join(__dirname, '..', '..', 'package.json'));

export async function deliveryCommand(args: string[]): Promise<void> {
  const recipePath = args.find(a => !a.startsWith('-'));
  if (!recipePath) {
    fatal('Usage: ifc-lite delivery <recipe.json> [--json] [--out report.json] [--html report.html]');
  }

  const jsonOutput = hasFlag(args, '--json');
  const outPath = getFlag(args, '--out');
  const htmlPath = getFlag(args, '--html');

  const recipe = await loadDeliveryRecipe(recipePath);

  const models: DeliveryModelEntry[] = [];
  const checks: DeliveryCheckResult[] = [];

  // Declared order throughout: models in recipe order, and within each
  // model, structural first (when requested) then every --ids file in
  // recipe order. No Map/object iteration anywhere in this loop — see
  // delivery-report.ts's determinism contract.
  for (let i = 0; i < recipe.resolvedModels.length; i++) {
    const declaredPath = recipe.models[i];
    const absPath = recipe.resolvedModels[i];
    const loaded = await loadModelForDelivery(absPath);

    if ('error' in loaded) {
      models.push({ path: declaredPath, loadError: loaded.error });
      // The model could not be loaded: every check the recipe declares for
      // it is unevaluable, and reports `error` — never silently omitted
      // (which would shrink the check count and could flip an
      // otherwise-failing recipe to a false "pass") and never `pass`.
      if (recipe.structural) {
        checks.push({
          type: 'structural', model: declaredPath, status: 'error',
          errorCount: 0, warningCount: 0, infoCount: 0, issues: [],
          error: `model ${loaded.error}`,
        } satisfies StructuralCheckResult);
      }
      for (const idsDeclared of recipe.ids) {
        checks.push({
          type: 'ids', model: declaredPath, source: idsDeclared, status: 'error',
          error: `model ${loaded.error}`,
        } satisfies IdsCheckResult);
      }
      continue;
    }

    models.push({ path: declaredPath, sha256: loaded.sha256 });

    if (recipe.structural) {
      checks.push(runStructuralCheck(declaredPath, loaded.store));
    }
    for (let j = 0; j < recipe.resolvedIds.length; j++) {
      const result = await runIdsCheck(declaredPath, loaded.store, recipe.resolvedIds[j]);
      checks.push({ ...result, source: recipe.ids[j] });
    }
  }

  const report = buildDeliveryReport(recipe, CLI_VERSION, models, checks);

  if (htmlPath) {
    await writeOutput(renderDeliveryHtml(report), htmlPath);
  }

  if (jsonOutput || outPath) {
    if (outPath) {
      await writeOutput(JSON.stringify(report, null, 2), outPath);
    } else {
      printJson(report);
    }
  } else {
    printHumanSummary(report, recipePath);
  }

  if (report.verdict !== 'pass') process.exitCode = 1;
}

function printHumanSummary(report: ReturnType<typeof buildDeliveryReport>, recipePath: string): void {
  process.stdout.write(`\n  Delivery check: ${recipePath}\n`);
  process.stdout.write(`  ifc-lite ${report.tool.version}\n\n`);

  for (const m of report.models) {
    const rel = relative(process.cwd(), m.path);
    if (m.loadError) {
      process.stdout.write(`  [ERR] ${rel}: ${m.loadError}\n`);
    } else {
      process.stdout.write(`  [OK]  ${rel} (sha256 ${m.sha256?.slice(0, 12)}…)\n`);
    }
  }
  process.stdout.write('\n');

  for (const c of report.checks) {
    const icon = c.status === 'pass' ? 'PASS' : c.status === 'fail' ? 'FAIL' : 'ERR ';
    const source = c.type === 'structural' ? 'structural' : c.source;
    const detail = c.error ? ` — ${c.error}` : '';
    process.stdout.write(`  [${icon}] ${relative(process.cwd(), c.model)} :: ${source}${detail}\n`);
  }

  process.stdout.write(`\n  ${report.summary.pass} pass, ${report.summary.fail} fail, ${report.summary.error} error (of ${report.summary.total})\n`);
  process.stdout.write(`  Verdict: ${report.verdict.toUpperCase()}\n\n`);
}
