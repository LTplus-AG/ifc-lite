/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Per-rule documentation pages (`docs/guide/ids-lint/*`), rendered from
 * the rule metadata so the docs cannot drift from the catalogue. Written
 * by `packages/ids-authoring/scripts/generate-lint-docs.mjs`; a package
 * test fails when the committed pages are stale.
 */

import type { LintRule } from './types.js';

export const LINT_DOCS_DIR = 'docs/guide/ids-lint';
export const NAV_BEGIN = '# BEGIN GENERATED ids-lint-nav';
export const NAV_END = '# END GENERATED ids-lint-nav';

const BANNER = '<!-- Generated from the rule metadata in packages/ids-authoring/src/lint/rules by packages/ids-authoring/scripts/generate-lint-docs.mjs. Do not edit by hand. -->';

const AREA_NAMES: Readonly<Record<string, string>> = {
  ENT: 'Entities',
  PDT: 'Predefined types',
  ATT: 'Attributes',
  PSET: 'Property sets',
  PROP: 'Properties',
  VAL: 'Values',
  UNIT: 'Units',
  REGEX: 'Patterns',
  CARD: 'Cardinality',
  SPEC: 'Specifications',
  DOC: 'Document',
  VER: 'IFC versions',
  PART: 'partOf relations',
};

export function pageName(code: string): string {
  return `${code.toLowerCase()}.md`;
}

function rulePage(rule: LintRule): string {
  const lines = [
    BANNER,
    '',
    `# ${rule.code}: ${rule.title}`,
    '',
    '| Default severity | Kind | Scope | Quick fix |',
    '|---|---|---|---|',
    `| ${rule.defaultSeverity} | ${rule.kind} | ${rule.scope === 'spec' ? 'specification' : 'document'} | ${rule.fix ? 'yes' : 'no'} |`,
    '',
    rule.rationale,
    '',
  ];
  if (rule.example) lines.push('## Example', '', '```xml', rule.example, '```', '');
  if (rule.fix) lines.push('## Quick fix', '', `${rule.fix} Quick fixes are proposals: they are op batches that pass the grounding gate and are never applied automatically.`, '');
  if (rule.assumptions?.length) {
    lines.push('## Verified assumptions', '');
    for (const a of rule.assumptions) lines.push(`- **${a.id}**: ${a.verified}`);
    lines.push('');
  }
  if (rule.references?.length) {
    lines.push('## References', '');
    for (const r of rule.references) lines.push(`- <${r}>`);
    lines.push('');
  }
  lines.push('## Suppressing', '', `Add a suppression with a reason for \`${rule.code}\` (or \`IDSL-${rule.area}-*\`) to the node, its facet, its specification or the document in the Studio sidecar (\`meta.suppressions\`).`, '', '[All lint rules](index.md)', '');
  return lines.join('\n');
}

function indexPage(rules: readonly LintRule[]): string {
  const lines = [
    BANNER,
    '',
    '# IDS lint rules',
    '',
    'The IDS audit answers "is this a valid IDS 1.0 file?". Lint answers "does this IDS mean what the author intends, and will it behave well?": abstract entities that match nothing, `^` in XSD patterns, millimetres where metres are expected, requirements that can never fail or never pass. Lint runs on a `StudioDocument` from `@ifc-lite/ids-authoring` and returns diagnostics with stable codes.',
    '',
    '```ts',
    "import { createLintContext, createLinter, fromIdsDocument } from '@ifc-lite/ids-authoring';",
    "import { parseIDS } from '@ifc-lite/ids';",
    '',
    'declare const xml: string;',
    'const linter = createLinter(await createLintContext());',
    'const { diagnostics } = linter.lint(fromIdsDocument(parseIDS(xml)));',
    'for (const d of diagnostics) console.log(d.code, d.severity, d.message, d.fixes?.map((f) => f.label));',
    '```',
    '',
    'Keep one linter per open document: specification-level findings are cached and only changed specifications are re-checked. A quick fix is a batch of Studio ops; check it with `checkQuickFix` (the grounding gate) and commit it like any other edit. A suppression in the sidecar (`meta.suppressions`, with a reason) silences a rule on a node and everything below it.',
    '',
    'Rules that depend on an IDS semantic the standard leaves open ship at `info` until the semantic is verified against the buildingSMART test cases; each rule page lists what was verified.',
    '',
  ];
  const areas = [...new Set(rules.map((r) => r.area))];
  for (const area of areas) {
    lines.push(`## ${AREA_NAMES[area] ?? area}`, '', '| Code | Severity | Rule | Quick fix |', '|---|---|---|---|');
    for (const r of rules.filter((x) => x.area === area)) lines.push(`| [${r.code}](${pageName(r.code)}) | ${r.defaultSeverity} | ${r.title} | ${r.fix ? 'yes' : 'no'} |`);
    lines.push('');
  }
  return lines.join('\n');
}

/** Every page of `docs/guide/ids-lint/`, keyed by file name. */
export function renderLintDocs(rules: readonly LintRule[]): Map<string, string> {
  const pages = new Map<string, string>([['index.md', indexPage(rules)]]);
  for (const r of rules) pages.set(pageName(r.code), rulePage(r));
  return pages;
}

/** The generated block of the mkdocs nav (indented for its place under "User Guide"). */
export function renderLintNav(rules: readonly LintRule[], indent = '      '): string {
  const yamlString = (s: string) => JSON.stringify(s);
  return [
    `${indent}${NAV_BEGIN} (packages/ids-authoring/scripts/generate-lint-docs.mjs)`,
    `${indent}- Overview: guide/ids-lint/index.md`,
    ...rules.map((r) => `${indent}- ${yamlString(`${r.code} ${r.title}`)}: guide/ids-lint/${pageName(r.code)}`),
    `${indent}${NAV_END}`,
  ].join('\n');
}
