/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { FileComparison, RuleRow } from './compare.js';
import type { RuleCoverage } from './coverage.js';

export interface ParityReport {
  generatedAt: string;
  oracle: { engine: string; version: string };
  coverage: RuleCoverage[];
  totals: { files: number; tp: number; fp: number; fn: number; craftedFn: number };
  rules: { crafted: RuleRow[]; all: RuleRow[] };
  targeted: Array<{ file: string; targets: string; ours: boolean; oracle: boolean }>;
  files: Array<Omit<FileComparison, 'rules'>>;
  missingModels: string[];
}

const yes = (b: boolean) => (b ? 'yes' : '**no**');

function ruleRows(rows: RuleRow[]): string[] {
  return [
    '| Rule | TP | FP | FN | TN files | Explanation |',
    '|---|---:|---:|---:|---:|---|',
    ...rows.map((r) => `| \`${r.rule}\` | ${r.tp} | ${r.fp} | ${r.fn} | ${r.tnFiles} | ${r.explained ?? ''} |`),
  ];
}

export function writeMarkdown(r: ParityReport): string {
  const lines = [
    '# @ifc-lite/validate parity report',
    '',
    `Generated ${r.generatedAt} by \`parity/run-parity.ts\`. Oracle: ${r.oracle.engine} ${r.oracle.version}.`,
    'Findings are compared per rule and instance. TP: both report it; FP: only we do; FN: only the oracle does.',
    '',
    '## Rule compilation',
    '',
    '| Schema | Scope | Entity WHERE | Type WHERE | Global | Compiled |',
    '|---|---|---:|---:|---:|---:|',
    ...r.coverage.map((c) => `| ${c.schema} | ${c.scope} | ${c.entityWhere.compiled}/${c.entityWhere.total} | ${c.typeWhere.compiled}/${c.typeWhere.total} | ${c.global.compiled}/${c.global.total} | ${c.compiledPercent}% |`),
    '',
    r.coverage.some((c) => c.unsupported.length)
      ? `Not compiled:\n\n${[...new Set(r.coverage.flatMap((c) => c.unsupported))].map((u) => `- ${u}`).join('\n')}`
      : 'Every WHERE rule, DERIVE expression, FUNCTION and global RULE compiled; nothing is reported as not evaluated.',
    '',
    '## Totals',
    '',
    `${r.totals.files} files: TP ${r.totals.tp}, FP ${r.totals.fp}, FN ${r.totals.fn}. FN on the crafted corpus: ${r.totals.craftedFn}.`,
    '',
    '## Targeted defects (crafted corpus)',
    '',
    '| File | Targets | We detect | Oracle detects |',
    '|---|---|---|---|',
    ...r.targeted.map((t) => `| ${t.file} | \`${t.targets}\` | ${yes(t.ours)} | ${yes(t.oracle)} |`),
    '',
    '## Per rule, crafted corpus',
    '',
    ...ruleRows(r.rules.crafted),
    '',
    '## Per rule, whole corpus',
    '',
    ...ruleRows(r.rules.all),
    '',
    '## Files',
    '',
    '| File | Schema | Ours | Oracle | TP | FP | FN | ms |',
    '|---|---|---:|---:|---:|---:|---:|---:|',
    ...r.files.map((f) => `| ${f.path} | ${f.schema} | ${f.ours} | ${f.oracle} | ${f.tp.length} | ${f.fp.length} | ${f.fn.length} | ${f.milliseconds} |`),
    '',
  ];
  if (r.missingModels.length) lines.push('Skipped (not fetched, run `pnpm fixtures`):', '', ...r.missingModels.map((m) => `- ${m}`), '');
  return `${lines.join('\n')}\n`;
}
