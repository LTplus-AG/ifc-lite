/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The markdown a `check` run prints, writes to the step summary and posts as
 * the sticky PR comment. It lists MOVED metrics only (anything whose measured
 * value differs from its ceiling, plus every failing row), so an unchanged
 * family stays one line long. A measured file's `informational` values
 * (#7007) follow as a plain list: shown, never compared.
 */

import {
  IMPROVEMENT,
  MISSING,
  REGRESSION,
  UNCHANGED,
  UNRATCHETED,
  WITHIN_TOLERANCE,
  relativeDelta,
} from './compare.mjs';

export const REPORT_MARKER = '<!-- perf-ratchet-report -->';

const STATUS_LABEL = {
  [REGRESSION]: 'FAIL: above ceiling + tolerance',
  [MISSING]: 'FAIL: not measured',
  [UNRATCHETED]: 'FAIL: no committed ceiling',
  [WITHIN_TOLERANCE]: 'ok: above ceiling, inside tolerance',
  [IMPROVEMENT]: 'improved',
  [UNCHANGED]: 'unchanged',
};

function num(n) {
  if (n === null || n === undefined) return '-';
  return Number.isInteger(n) ? n.toLocaleString('en-US') : String(n);
}

function tol(t) {
  if (!t) return '-';
  return t.kind === 'exact' ? 'exact' : `+${(t.value * 100).toFixed(2)}%`;
}

function delta(row) {
  if (row.value === null || row.ceiling === null) return '-';
  const d = row.value - row.ceiling;
  const pct = (relativeDelta(row.value, row.ceiling) * 100).toFixed(2);
  return `${d > 0 ? '+' : ''}${num(d)} (${d > 0 ? '+' : ''}${pct}%)`;
}

/**
 * @param {Array<{ family: string, rows: Array<object>, failed: boolean }>} results
 * @param {{ commit?: string }} [context]
 * @returns {string}
 */
export function formatReport(results, context = {}) {
  const failed = results.some((r) => r.failed);
  const out = [REPORT_MARKER, ''];
  out.push(failed ? '### Perf ratchet: a ceiling was exceeded' : '### Perf ratchet: all metrics within their ceilings');
  out.push('');
  if (context.commit) out.push(`Measured at \`${context.commit}\`.`, '');

  const moved = [];
  for (const { family, rows } of results) {
    for (const row of rows) {
      if (row.status !== UNCHANGED) moved.push({ family, ...row });
    }
  }
  const total = results.reduce((n, r) => n + r.rows.length, 0);
  if (moved.length === 0) {
    out.push(`All ${total} metric(s) equal their ceilings.`);
  } else {
    out.push('| Metric | Ceiling | Tolerance | Allowed | Measured | Change vs ceiling | Status |');
    out.push('| --- | ---: | :---: | ---: | ---: | ---: | --- |');
    for (const r of moved) {
      const name = `\`${r.family}/${r.id}\`${r.unit ? ` (${r.unit})` : ''}`;
      out.push(`| ${name} | ${num(r.ceiling)} | ${tol(r.tolerance)} | ${num(r.allowed)} | ${num(r.value)} | ${delta(r)} | ${STATUS_LABEL[r.status]} |`);
    }
    out.push('', `${total - moved.length} other metric(s) unchanged.`);
  }

  const improved = moved.filter((r) => r.status === IMPROVEMENT);
  if (improved.length) {
    const queued = improved.filter((r) => r.lowerable).length;
    out.push('', `${improved.length} metric(s) improved. ` +
      (queued
        ? `${queued} of them cleared the tolerance band, so the daily lowering job (\`perf-ratchet-lower.yml\`) will lower ${queued === 1 ? 'its ceiling' : 'their ceilings'} once this is on \`main\`.`
        : 'None cleared the tolerance band yet, so no ceiling will move; small wins accumulate until they do.'));
  }
  const info = results.flatMap(({ family, informational = [] }) => informational.map((m) => ({ family, ...m })));
  if (info.length) {
    out.push('', 'Informational, not gated:');
    for (const m of info) {
      out.push(`- \`${m.family}/${m.id}\`: ${num(m.value)}${m.unit ? ` ${m.unit}` : ''}${m.detail ? ` (${m.detail})` : ''}`);
    }
  }
  if (failed) {
    out.push('', 'A ceiling only moves up by a human PR that edits `tests/perf-ratchets/<family>.json` and says why. ' +
      'See "Perf ratchet ceilings" in `docs/guide/performance.md`.');
  }
  out.push('');
  return out.join('\n');
}
