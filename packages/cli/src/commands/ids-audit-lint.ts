/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * ifc-lite ids audit <rules.ids> [--json]
 * ifc-lite ids lint  <rules.ids> [--json] [--rules C,…] [--severity C=level,…] [--fail-on error|warning|info|never]
 *
 * `audit` answers "is this a valid IDS 1.0 file?" (`@ifc-lite/ids`
 * `auditIDSDocument`). `lint` answers "does it mean what the author
 * intends?" (`@ifc-lite/ids-authoring`'s rule catalogue, the same engine
 * the Studio runs). Exit codes: see `ids-subcommand.ts`.
 */

import { auditIDSDocument, IDSParseError, type IDSAuditIssue } from '@ifc-lite/ids';
import {
  createLintContext,
  lintDocument,
  LINT_RULES,
  nodePath,
  readStudioDocument,
  type Diagnostic,
  type LintSeverity,
  type StudioDocument,
} from '@ifc-lite/ids-authoring';
import { printJson } from '../output.js';
import {
  countLine,
  EXIT_CLEAN,
  EXIT_FINDINGS,
  IdsUsageError,
  positionals,
  readText,
  rejectUnknownFlags,
  runIdsSubcommand,
  tally,
} from './ids-subcommand.js';

const AUDIT_FLAGS = new Set(['--json']);

function auditLine(issue: IDSAuditIssue): string {
  const path = issue.path || '(document)';
  const where = issue.line !== undefined ? `${path} (line ${issue.line})` : path;
  return `  ${issue.severity.padEnd(8)}${issue.code.padEnd(36)}${where}\n            ${issue.message}\n`;
}

export async function idsAuditCommand(args: string[]): Promise<void> {
  await runIdsSubcommand(async () => {
    rejectUnknownFlags(args, AUDIT_FLAGS, new Set());
    const [file, extra] = positionals(args, new Set());
    if (!file || extra) throw new IdsUsageError('usage: ifc-lite ids audit <rules.ids> [--json]');
    const report = await auditIDSDocument(await readText(file));
    const counts = tally(report.issues);
    const exit = counts.error > 0 ? EXIT_FINDINGS : EXIT_CLEAN;
    if (args.includes('--json')) {
      printJson({ file, status: report.status, counts, issues: report.issues });
      return exit;
    }
    process.stdout.write(`\n  IDS audit: ${file}\n\n`);
    for (const issue of report.issues) process.stdout.write(auditLine(issue));
    if (report.issues.length > 0) process.stdout.write('\n');
    process.stdout.write(`  ${countLine(counts)}\n  Result: ${exit === EXIT_CLEAN ? 'PASS' : 'FAIL'}\n\n`);
    return exit;
  });
}

const LINT_FLAGS = new Set(['--json']);
const LINT_VALUE_FLAGS = new Set(['--rules', '--severity', '--fail-on', '--model']);
const SEVERITIES: readonly LintSeverity[] = ['error', 'warning', 'info'];
const RANK: Record<LintSeverity, number> = { error: 0, warning: 1, info: 2 };

function knownCode(code: string): string {
  if (!LINT_RULES.some((r) => r.code === code)) throw new IdsUsageError(`unknown lint rule ${code}`);
  return code;
}

/** `--severity IDSL-ENT-002=error,IDSL-SPEC-008=off` */
function parseSeverity(raw: string | undefined): Record<string, LintSeverity | 'off'> | undefined {
  if (raw === undefined) return undefined;
  const out: Record<string, LintSeverity | 'off'> = {};
  for (const part of raw.split(',')) {
    const [code, level] = part.split('=');
    if (!level || !(level === 'off' || (SEVERITIES as readonly string[]).includes(level))) {
      throw new IdsUsageError(`--severity expects CODE=error|warning|info|off, got "${part}"`);
    }
    out[knownCode(code)] = level as LintSeverity | 'off';
  }
  return out;
}

function parseFailOn(raw: string | undefined): LintSeverity | 'never' {
  if (raw === undefined) return 'error';
  if (raw === 'never' || (SEVERITIES as readonly string[]).includes(raw)) return raw as LintSeverity | 'never';
  throw new IdsUsageError(`--fail-on expects error|warning|info|never, got "${raw}"`);
}

function flagValue(args: readonly string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i === -1 ? undefined : args[i + 1];
}

interface LintRow {
  code: string;
  severity: LintSeverity;
  path: string;
  spec?: string;
  message: string;
  fixable: boolean;
  docsUrl: string;
}

function toRow(doc: StudioDocument, d: Diagnostic): LintRow {
  const specIndex = d.specId ? doc.nodes.specs.findIndex((s) => s.id === d.specId) : -1;
  return {
    code: d.code,
    severity: d.severity,
    path: nodePath(doc, d.nodeId) ?? d.nodeId,
    ...(specIndex >= 0 ? { spec: doc.ids.specifications[specIndex].name } : {}),
    message: d.message,
    fixable: (d.fixes?.length ?? 0) > 0,
    docsUrl: d.docsUrl,
  };
}

function readForLint(xml: string, file: string): StudioDocument {
  try {
    return readStudioDocument(xml);
  } catch (err) {
    if (!(err instanceof IDSParseError)) throw err;
    throw new IdsUsageError(`${file} does not parse as IDS (${err.message}); run \`ifc-lite ids audit\` for details`);
  }
}

export async function idsLintCommand(args: string[]): Promise<void> {
  await runIdsSubcommand(async () => {
    rejectUnknownFlags(args, LINT_FLAGS, LINT_VALUE_FLAGS);
    if (args.includes('--model')) {
      throw new IdsUsageError('model-aware lint (--model) is not available in this build; it ships with the IDS model loop');
    }
    const [file, extra] = positionals(args, LINT_VALUE_FLAGS);
    if (!file || extra) throw new IdsUsageError('usage: ifc-lite ids lint <rules.ids> [--json] [--rules C,…] [--severity C=level,…] [--fail-on level]');
    const rulesFlag = flagValue(args, '--rules');
    const rules = rulesFlag?.split(',').map(knownCode);
    const severity = parseSeverity(flagValue(args, '--severity'));
    const failOn = parseFailOn(flagValue(args, '--fail-on'));

    const doc = readForLint(await readText(file), file);
    const result = lintDocument(doc, await createLintContext(), { rules, severity });
    const rows = result.diagnostics
      .map((d) => toRow(doc, d))
      .sort((a, b) => RANK[a.severity] - RANK[b.severity] || a.path.localeCompare(b.path) || a.code.localeCompare(b.code));
    const counts = tally(rows);
    const failing = failOn === 'never' ? false : rows.some((r) => RANK[r.severity] <= RANK[failOn]);
    const exit = failing ? EXIT_FINDINGS : EXIT_CLEAN;

    if (args.includes('--json')) {
      printJson({ file, counts, suppressed: result.suppressed.length, diagnostics: rows });
      return exit;
    }
    process.stdout.write(`\n  IDS lint: ${file}\n\n`);
    for (const r of rows) {
      const spec = r.spec !== undefined ? `  "${r.spec}"` : '';
      process.stdout.write(`  ${r.severity.padEnd(8)}${r.code.padEnd(15)}${r.path}${spec}\n            ${r.message}${r.fixable ? ' [fix available]' : ''}\n`);
    }
    if (rows.length > 0) process.stdout.write('\n');
    const fixable = rows.filter((r) => r.fixable).length;
    const suppressed = result.suppressed.length > 0 ? `, ${result.suppressed.length} suppressed` : '';
    process.stdout.write(`  ${countLine(counts)} (${fixable} fixable${suppressed})\n  Result: ${exit === EXIT_CLEAN ? 'PASS' : 'FAIL'}\n\n`);
    return exit;
  });
}
