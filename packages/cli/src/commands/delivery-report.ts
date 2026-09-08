/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Consolidated report assembly and HTML rendering for `ifc-lite delivery`.
 *
 * Determinism contract: `buildDeliveryReport` never reads the wall clock,
 * never iterates a `Map`/object in insertion-order-dependent ways, and never
 * keys a result by a derived string (model path, IDS file name, check type)
 * — every check is one entry in a flat, declared-order ARRAY. Two collisions
 * this codebase has actually shipped (a subtotal silently overwritten in
 * `schedule`'s output, a duplicate `--columns` header collapsing a row in
 * JSON) both came from keying a result object by a name that two distinct
 * inputs could share; an array keeps every check's own model/type/source
 * fields as data instead of forcing them into a Map/object key that could
 * collide. The result: the SAME recipe run twice, with no model or IDS file
 * changed on disk, produces byte-identical JSON (`tool.version` and the
 * `sha256` fingerprints are the only fields that could ever legitimately
 * differ between two runs, and neither depends on wall-clock time or
 * iteration order).
 */

import type { StructuralCheckResult, IdsCheckResult, CheckStatus } from './delivery-checks.js';
import type { ResolvedDeliveryRecipe } from './delivery-recipe.js';

export type DeliveryCheckResult = StructuralCheckResult | IdsCheckResult;

export interface DeliveryModelEntry {
  /** Path exactly as declared in the recipe (relative, for a readable report). */
  path: string;
  /** SHA-256 of the model's bytes, or undefined when the model could not be loaded. */
  sha256?: string;
  /** Set when the model could not be loaded; every check for this model then reports `error`. */
  loadError?: string;
}

export interface DeliveryReport {
  tool: { name: 'ifc-lite'; version: string };
  recipe: string;
  models: DeliveryModelEntry[];
  checks: DeliveryCheckResult[];
  /** `pass` iff every check in `checks` is `pass` and `checks` is non-empty. */
  verdict: 'pass' | 'fail';
  summary: {
    total: number;
    pass: number;
    fail: number;
    error: number;
  };
}

/** Build the consolidated report from a resolved recipe, its per-model load outcomes, and every check result. */
export function buildDeliveryReport(
  recipe: ResolvedDeliveryRecipe,
  version: string,
  models: DeliveryModelEntry[],
  checks: DeliveryCheckResult[],
): DeliveryReport {
  const counts = { total: checks.length, pass: 0, fail: 0, error: 0 };
  for (const c of checks) counts[c.status]++;

  const verdict: 'pass' | 'fail' = checks.length > 0 && counts.fail === 0 && counts.error === 0 ? 'pass' : 'fail';

  return {
    tool: { name: 'ifc-lite', version },
    recipe: recipe.recipePath,
    models,
    checks,
    verdict,
    summary: counts,
  };
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function statusBadge(status: CheckStatus): string {
  const label = status.toUpperCase();
  return `<span class="badge badge-${status}">${label}</span>`;
}

function describeCheck(check: DeliveryCheckResult): string {
  if (check.type === 'structural') {
    return `${check.errorCount} error(s), ${check.warningCount} warning(s), ${check.infoCount} info`;
  }
  const parts: string[] = [];
  if (check.totalSpecifications !== undefined) {
    parts.push(`${check.passedSpecifications ?? 0}/${check.totalSpecifications} specification(s) passed`);
  }
  if (check.failedEntities !== undefined && check.totalEntities !== undefined) {
    parts.push(`${check.failedEntities}/${check.totalEntities} entities failed`);
  }
  if (check.error) parts.push(check.error);
  return parts.join(' — ') || (check.error ?? '');
}

/** Render the report as a standalone HTML document — no external assets, safe to open from disk. */
export function renderDeliveryHtml(report: DeliveryReport): string {
  const rows = report.checks
    .map(check => {
      const source = check.type === 'structural' ? 'structural' : check.source;
      return `      <tr class="row-${check.status}">
        <td>${escapeHtml(check.model)}</td>
        <td>${escapeHtml(check.type)}</td>
        <td>${escapeHtml(source)}</td>
        <td>${statusBadge(check.status)}</td>
        <td>${escapeHtml(describeCheck(check))}</td>
      </tr>`;
    })
    .join('\n');

  const modelRows = report.models
    .map(m => `      <tr>
        <td>${escapeHtml(m.path)}</td>
        <td><code>${escapeHtml(m.sha256 ?? '')}</code></td>
        <td>${m.loadError ? `<span class="badge badge-error">ERROR</span> ${escapeHtml(m.loadError)}` : 'OK'}</td>
      </tr>`)
    .join('\n');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>IFC Delivery Check Report</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 2rem; color: #1a1a1a; }
  h1 { font-size: 1.4rem; }
  .verdict { font-size: 1.1rem; font-weight: 600; padding: 0.5rem 1rem; border-radius: 4px; display: inline-block; }
  .verdict-pass { background: #e6f4ea; color: #1e7e34; }
  .verdict-fail { background: #fce8e6; color: #c5221f; }
  table { border-collapse: collapse; width: 100%; margin-top: 1rem; }
  th, td { border: 1px solid #ddd; padding: 0.4rem 0.6rem; text-align: left; font-size: 0.9rem; }
  th { background: #f5f5f5; }
  .badge { display: inline-block; padding: 0.1rem 0.5rem; border-radius: 3px; font-size: 0.75rem; font-weight: 600; }
  .badge-pass { background: #e6f4ea; color: #1e7e34; }
  .badge-fail { background: #fce8e6; color: #c5221f; }
  .badge-error { background: #fef7e0; color: #8a6d00; }
  .row-error td { background: #fffdf5; }
</style>
</head>
<body>
  <h1>IFC Delivery Check Report</h1>
  <p><strong>Tool:</strong> ${escapeHtml(report.tool.name)} ${escapeHtml(report.tool.version)}<br>
     <strong>Recipe:</strong> <code>${escapeHtml(report.recipe)}</code></p>
  <p class="verdict verdict-${report.verdict}">Verdict: ${report.verdict.toUpperCase()}</p>
  <p>${report.summary.pass} pass, ${report.summary.fail} fail, ${report.summary.error} error (of ${report.summary.total} check(s))</p>

  <h2>Models</h2>
  <table>
    <thead><tr><th>Path</th><th>SHA-256</th><th>Status</th></tr></thead>
    <tbody>
${modelRows}
    </tbody>
  </table>

  <h2>Checks</h2>
  <table>
    <thead><tr><th>Model</th><th>Type</th><th>Source</th><th>Status</th><th>Evidence</th></tr></thead>
    <tbody>
${rows}
    </tbody>
  </table>
</body>
</html>
`;
}
