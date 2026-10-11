/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Markdown rendering of the IDS conformance matrix (IDS-125). Pure: the
 * same matrix JSON always renders the same bytes, so `report.test.mjs` can
 * check the docs region against the committed JSON without running any
 * engine.
 */

export const REGION = 'ids-conformance';

/** @param {{ agree: number, disagree: number, error: number, na: number } | undefined} t */
function scored(t) {
  if (!t) return '–';
  const judged = t.agree + t.disagree + t.error;
  if (judged === 0) return t.na > 0 ? `n/a (${t.na})` : '–';
  const pct = ((100 * t.agree) / judged).toFixed(1);
  const extra = [t.error > 0 ? `${t.error} error` : '', t.na > 0 ? `${t.na} n/a` : ''].filter(Boolean).join(', ');
  return `${t.agree}/${judged} (${pct}%)${extra ? ` · ${extra}` : ''}`;
}

/** Escape a table cell. @param {string} text */
function cell(text) {
  return text.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

/** @param {{ verdict: string, agrees: boolean | null }} c */
function mark(c) {
  if (c.verdict === 'n/a') return 'n/a';
  return c.agrees ? c.verdict : `**${c.verdict}** ✗`;
}

/**
 * The generated body of the docs region.
 * @param {ReturnType<typeof import('./matrix.mjs').buildMatrix> extends Promise<infer M> ? M : never} matrix
 */
export function renderMarkdown(matrix) {
  const engines = matrix.engines;
  const groups = [...new Set(matrix.cases.map((c) => c.group))].sort();
  const out = [];
  out.push(`Corpus: ${matrix.corpus.name}, ${matrix.corpus.cases} cases (${matrix.corpus.licence}; ${matrix.corpus.source}).`);
  out.push('Generated from [`ids-conformance.json`](ids-conformance.json) by `node scripts/ids-conformance/run.mjs`; do not edit by hand.');
  out.push('');
  out.push('| Engine | Version | Licence | Source |');
  out.push('|---|---|---|---|');
  for (const e of engines) out.push(`| ${cell(e.name)} | ${cell(e.version)} | ${cell(e.licence)} | ${cell(e.source)} |`);
  out.push('');
  out.push('### Agreement with the corpus');
  out.push('');
  out.push('Each cell is cases agreeing with the expected verdict out of cases the engine answered. `n/a` cases (a question the engine does not offer) are not counted; an `error` (the engine crashed or gave no verdict) counts as a disagreement.');
  out.push('');
  out.push(`| Facet (corpus folder) | ${engines.map((e) => cell(e.name)).join(' | ')} |`);
  out.push(`|---|${engines.map(() => '---').join('|')}|`);
  for (const g of groups) out.push(`| ${g} | ${engines.map((e) => scored(matrix.summary[e.id].byGroup[g])).join(' | ')} |`);
  for (const x of ['pass', 'fail', 'invalid']) {
    out.push(`| *all \`${x}-\` cases* | ${engines.map((e) => scored(matrix.summary[e.id].byExpected[x])).join(' | ')} |`);
  }
  out.push(`| **all cases** | ${engines.map((e) => `**${scored(matrix.summary[e.id].overall)}**`).join(' | ')} |`);
  out.push('');
  out.push('### How each column is produced');
  out.push('');
  for (const e of engines) {
    out.push(`- **${e.name}**`);
    for (const note of e.notes ?? []) out.push(`    - ${note}`);
  }
  out.push('');
  out.push('### Disagreements');
  out.push('');
  for (const e of engines) {
    const wrong = matrix.cases.filter((c) => c.cells[e.id] && c.cells[e.id].agrees === false);
    out.push(`#### ${e.name}: ${wrong.length}`);
    out.push('');
    if (wrong.length === 0) {
      out.push('None.');
      out.push('');
      continue;
    }
    out.push('| Case | Expected | Got | Detail |');
    out.push('|---|---|---|---|');
    for (const c of wrong) {
      const got = c.cells[e.id];
      out.push(`| \`${c.id}\` | ${c.expected} | ${got.verdict} | ${cell(got.detail ?? '')} |`);
    }
    out.push('');
  }
  out.push(`??? note "All ${matrix.cases.length} cases"`);
  out.push('');
  out.push(`    | Case | Expected | ${engines.map((e) => cell(e.name)).join(' | ')} |`);
  out.push(`    |---|---|${engines.map(() => '---').join('|')}|`);
  for (const c of matrix.cases) {
    out.push(`    | \`${c.id}\` | ${c.expected} | ${engines.map((e) => (c.cells[e.id] ? mark(c.cells[e.id]) : '–')).join(' | ')} |`);
  }
  return out.join('\n');
}

/**
 * Replace the body between this region's markers in `text`.
 * @param {string} text
 * @param {string} body
 */
export function replaceRegion(text, body) {
  const begin = `<!-- BEGIN GENERATED: ${REGION} -->`;
  const end = `<!-- END GENERATED: ${REGION} -->`;
  const from = text.indexOf(begin);
  const to = text.indexOf(end);
  if (from === -1 || to === -1 || to < from) throw new Error(`markers for region "${REGION}" not found`);
  return `${text.slice(0, from + begin.length)}\n${body}\n${text.slice(to)}`;
}
