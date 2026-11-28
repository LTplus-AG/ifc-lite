/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * ifc-lite delivery <recipe.json> [--json] [--out <report.json>] [--html <report.html>]
 *
 * Run a repeatable, reviewable model-delivery check from a saved recipe
 * (see `delivery-recipe.ts`): structural validation (the same rules
 * `ifc-lite validate` runs), IDS validation (the same validator `ifc-lite
 * ids` runs), and/or `.rules.json` information-validation rule sets (the
 * same engine `ifc-lite check` runs, #5138 PR 7b) — any combination,
 * against one or more model files, in one invocation.
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
import { readPackageVersion } from '@ifc-lite/data/node';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';
import { loadDeliveryRecipe } from './delivery-recipe.js';
import { loadModelForDelivery } from './delivery-checks.js';
import { buildDeliveryReport, renderDeliveryHtml, runDeliveryRecipe } from '@ifc-lite/sdk/headless/delivery';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI_VERSION = readPackageVersion(join(__dirname, '..', '..', 'package.json'));

export async function deliveryCommand(args: string[]): Promise<void> {
  const recipePath = args.find(a => !a.startsWith('-'));
  if (!recipePath) {
    fatal('Usage: ifc-lite delivery <recipe.json> [--json] [--out report.json] [--html report.html]');
  }

  const jsonOutput = hasFlag(args, '--json');
  const outPath = getFlag(args, '--out');
  const htmlPath = getFlag(args, '--html');

  const recipe = await loadDeliveryRecipe(recipePath);

  const report = await runDeliveryRecipe(recipe, CLI_VERSION, loadModelForDelivery);

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
