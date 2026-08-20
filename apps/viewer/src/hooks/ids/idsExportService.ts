/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * IDS Export Service
 *
 * Pure functions that generate downloadable JSON and HTML reports
 * from IDS validation results. No React dependencies.
 */

import type { IDSValidationReport, SupportedLocale } from '@ifc-lite/ids';
import { posthog } from '../../lib/analytics';
import { downloadFile } from '../../lib/export/download';

// ============================================================================
// JSON Export
// ============================================================================

/**
 * Generate a JSON export object from a validation report.
 * Returns a plain object suitable for JSON.stringify.
 */
export function buildReportJSON(report: IDSValidationReport): Record<string, unknown> {
  return {
    document: report.document,
    modelInfo: report.modelInfo,
    timestamp: report.timestamp.toISOString(),
    summary: report.summary,
    specificationResults: report.specificationResults.map(spec => ({
      specification: spec.specification,
      status: spec.status,
      applicableCount: spec.applicableCount,
      passedCount: spec.passedCount,
      failedCount: spec.failedCount,
      passRate: spec.passRate,
      entityResults: spec.entityResults.map(entity => ({
        expressId: entity.expressId,
        modelId: entity.modelId,
        entityType: entity.entityType,
        entityName: entity.entityName,
        globalId: entity.globalId,
        passed: entity.passed,
        requirementResults: entity.requirementResults.map(req => ({
          requirement: req.requirement,
          status: req.status,
          facetType: req.facetType,
          checkedDescription: req.checkedDescription,
          failureReason: req.failureReason,
          actualValue: req.actualValue,
          expectedValue: req.expectedValue,
        })),
      })),
    })),
  };
}

/**
 * Trigger a JSON report download in the browser.
 */
export function downloadReportJSON(report: IDSValidationReport): void {
  const exportData = buildReportJSON(report);
  downloadFile(JSON.stringify(exportData, null, 2), `ids-report-${new Date().toISOString().split('T')[0]}.json`, 'application/json');
  posthog.capture('ids_report_exported', { format: 'json', total_specifications: report.summary.totalSpecifications });
}

// ============================================================================
// HTML Export
// ============================================================================

/** HTML escape helper to prevent XSS */
function escapeHtml(str: string | undefined | null): string {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ============================================================================
// Requirement-level grouping
//
// An IDS report has three nested levels: specification -> requirement ->
// check (one entity measured against one requirement). The validator's
// `IDSEntityResult.requirementResults` array carries one entry per
// requirement per entity, in the same order as `spec.requirements` for
// every entity (see `validateEntityRequirements` in
// packages/ids/src/validation/validator.ts, which loops
// `for (const requirement of spec.requirements)` for every entity). Each
// `IDSRequirementResult.requirement.id` is assigned once per specification
// by the XML parser (`req-${reqIndex++}`, reset per spec — see
// packages/ids/src/parser/xml-parser.ts) and is the SAME object reference
// reused across every entity's result, so grouping by `requirement.id` is a
// stable, order-preserving key even if a future producer of
// `IDSEntityResult` reorders or omits entries.
// ============================================================================

interface FailingElement {
  entityType: string;
  entityName?: string;
  globalId?: string;
  expressId: number;
  failureReason?: string;
}

interface RequirementGroup {
  id: string;
  facetType: string;
  checkedDescription: string;
  /** Checks that passed for this requirement, across all entities. */
  passed: number;
  /** Checks that failed for this requirement, across all entities. */
  failed: number;
  /**
   * Checks that were not_applicable for this requirement. Excluded from
   * both the passed and failed counts, and from the pass-rate denominator
   * — consistent with how the validator's own applicableCount/passedCount
   * treat entities that don't match applicability at all.
   */
  notApplicable: number;
  failingElements: FailingElement[];
}

/**
 * Group a specification's per-entity requirement results by requirement,
 * across ALL entities. This groups first and classifies status second —
 * grouping after filtering out `not_applicable` would break the index/id
 * alignment between an entity's `requirementResults` and the
 * specification's `requirements`.
 */
function buildRequirementGroups(
  spec: IDSValidationReport['specificationResults'][0],
): RequirementGroup[] {
  const groups = new Map<string, RequirementGroup>();

  for (const entity of spec.entityResults) {
    for (const rr of entity.requirementResults) {
      const key = rr.requirement.id;
      let group = groups.get(key);
      if (!group) {
        group = {
          id: key,
          facetType: rr.facetType,
          checkedDescription: rr.checkedDescription,
          passed: 0,
          failed: 0,
          notApplicable: 0,
          failingElements: [],
        };
        groups.set(key, group);
      }

      if (rr.status === 'pass') {
        group.passed++;
      } else if (rr.status === 'fail') {
        group.failed++;
        group.failingElements.push({
          entityType: entity.entityType,
          entityName: entity.entityName,
          globalId: entity.globalId,
          expressId: entity.expressId,
          failureReason: rr.failureReason,
        });
      } else {
        group.notApplicable++;
      }
    }
  }

  return Array.from(groups.values());
}

/** Reference truncation caps for failing-element lists in the HTML report. */
const FAILING_ELEMENTS_TOTAL_CAP = 100;
const FAILING_ELEMENTS_PER_TYPE_CAP = 5;

/**
 * Render a requirement's failing elements, truncated so a requirement that
 * fails on thousands of entities doesn't produce an unopenable document.
 * Elements are grouped by IFC type first (a systemic problem on one type is
 * one problem, not N), capped at ~5 examples per type, and capped overall
 * at ~100 elements. Every truncation is stated with an exact hidden count —
 * nothing is dropped silently.
 */
function buildFailingElementsHTML(elements: FailingElement[], esc: typeof escapeHtml): string {
  if (elements.length === 0) return '';

  const byType = new Map<string, FailingElement[]>();
  for (const el of elements) {
    const list = byType.get(el.entityType);
    if (list) {
      list.push(el);
    } else {
      byType.set(el.entityType, [el]);
    }
  }

  const rows: string[] = [];
  const typeNotes: string[] = [];
  let shown = 0;

  for (const [type, elems] of byType) {
    if (shown >= FAILING_ELEMENTS_TOTAL_CAP) break;
    const budget = FAILING_ELEMENTS_TOTAL_CAP - shown;
    const take = Math.min(FAILING_ELEMENTS_PER_TYPE_CAP, elems.length, budget);

    for (let i = 0; i < take; i++) {
      const el = elems[i];
      rows.push(`<tr class="entity-row" data-status="fail" data-type="${esc(el.entityType)}" data-name="${esc(el.entityName ?? '')}">
            <td class="col-type">${esc(el.entityType)}</td>
            <td class="col-name">${esc(el.entityName) || '<em>unnamed</em>'}</td>
            <td class="col-globalid"><code class="globalid" title="Click to copy">${esc(el.globalId) || '—'}</code></td>
            <td class="col-expressid">${el.expressId}</td>
            <td class="col-failure">${esc(el.failureReason) || '—'}</td>
          </tr>`);
    }
    shown += take;

    if (elems.length > take) {
      typeNotes.push(`Showing ${take} of ${elems.length} ${esc(type)} failures`);
    }
  }

  const hidden = elements.length - shown;

  return `<table class="req-fail-table">
        <thead>
          <tr>
            <th class="col-type">IFC Class</th>
            <th class="col-name">Name</th>
            <th class="col-globalid">GlobalId</th>
            <th class="col-expressid">ID</th>
            <th class="col-failure">Reason</th>
          </tr>
        </thead>
        <tbody>${rows.join('')}</tbody>
      </table>
      ${typeNotes.length > 0 ? `<div class="truncation-note">${typeNotes.map(n => `<div>${n}</div>`).join('')}</div>` : ''}
      ${hidden > 0 ? `<div class="truncation-note truncation-total">Showing ${shown} of ${elements.length} failing elements for this requirement (${hidden} hidden). See the JSON export for complete results.</div>` : ''}`;
}

/** Render one requirement block: facet, description, pass/fail counts, and failing elements. */
function buildRequirementGroupHTML(group: RequirementGroup, esc: typeof escapeHtml): string {
  const totalChecked = group.passed + group.failed;
  const passRate = totalChecked > 0 ? Math.round((group.passed / totalChecked) * 100) : 100;
  const status = group.failed > 0 ? 'fail' : 'pass';

  return `<div class="req-group req-group-${status}">
        <div class="req-group-header">
          <span class="badge ${status === 'pass' ? 'badge-pass' : 'badge-fail'}">${status === 'pass' ? 'PASS' : 'FAIL'}</span>
          <span class="req-facet">${esc(group.facetType)}</span>
          <span class="req-desc">${esc(group.checkedDescription)}</span>
        </div>
        <div class="req-group-stats">
          <span class="pass-count">${group.passed}</span>/<span class="total-count">${totalChecked}</span> checks passed (${passRate}%)
          ${group.notApplicable > 0 ? `<span class="req-na">&middot; ${group.notApplicable} not applicable</span>` : ''}
        </div>
        ${group.failed > 0 ? `<div class="req-group-failures">${buildFailingElementsHTML(group.failingElements, esc)}</div>` : ''}
      </div>`;
}

/** Build entity rows HTML for a specification table */
function buildEntityRows(
  spec: IDSValidationReport['specificationResults'][0],
  esc: typeof escapeHtml,
): string {
  return spec.entityResults.map(entity => {
    const failedReqs = entity.requirementResults.filter(r => r.status === 'fail');
    const passedReqs = entity.requirementResults.filter(r => r.status === 'pass');
    const allReqs = entity.requirementResults.filter(r => r.status !== 'not_applicable');

    const reqDetails = failedReqs.length > 0
      ? failedReqs.map(req => `<div class="req-detail">
            <span class="req-facet">${esc(req.facetType)}</span>
            <span class="req-desc">${esc(req.checkedDescription)}</span>
            ${req.failureReason ? `<div class="req-failure">${esc(req.failureReason)}</div>` : ''}
            ${req.expectedValue || req.actualValue ? `<div class="req-values">${req.expectedValue ? `<span>Expected: <code>${esc(req.expectedValue)}</code></span>` : ''}${req.actualValue ? `<span>Actual: <code>${esc(req.actualValue)}</code></span>` : ''}</div>` : ''}
          </div>`).join('')
      : '<span class="all-pass">All requirements passed</span>';

    return `<tr class="entity-row" data-status="${entity.passed ? 'pass' : 'fail'}" data-type="${esc(entity.entityType)}" data-name="${esc(entity.entityName ?? '')}">
        <td class="col-status"><span class="badge ${entity.passed ? 'badge-pass' : 'badge-fail'}">${entity.passed ? 'PASS' : 'FAIL'}</span></td>
        <td class="col-type">${esc(entity.entityType)}</td>
        <td class="col-name">${esc(entity.entityName) || '<em>unnamed</em>'}</td>
        <td class="col-globalid"><code class="globalid" title="Click to copy">${esc(entity.globalId) || '\u2014'}</code></td>
        <td class="col-expressid">${entity.expressId}</td>
        <td class="col-reqs"><span class="pass-count">${passedReqs.length}</span>/<span class="total-count">${allReqs.length}</span></td>
        <td class="col-details"><details><summary>${failedReqs.length > 0 ? `${failedReqs.length} failure${failedReqs.length > 1 ? 's' : ''}` : 'Details'}</summary><div class="req-list">${reqDetails}</div></details></td>
      </tr>`;
  }).join('');
}

/**
 * Generate an interactive HTML report with search, filtering, sorting,
 * and click-to-copy GlobalId support.
 */
export function buildReportHTML(report: IDSValidationReport, locale: SupportedLocale): string {
  const esc = escapeHtml;
  const totalChecks = report.summary.totalEntitiesChecked;
  const totalPassed = report.specificationResults.reduce((s, sp) => s + sp.passedCount, 0);
  const totalFailed = report.specificationResults.reduce((s, sp) => s + sp.failedCount, 0);

  // Requirement groups per specification, built once and reused for both
  // the requirement blocks and the check-level tally below.
  const requirementGroupsBySpec = report.specificationResults.map(spec => buildRequirementGroups(spec));

  // Three levels, three DIFFERENT and DELIBERATELY DISTINCT rates. None of
  // them repurposes an existing field's meaning — `report.summary` is
  // consumed by the CLI/BCF/JSON exports too, so its fields keep exactly
  // the meaning the validator gives them.
  //
  // - Check (finest): one element measured against one requirement. Not
  //   computed anywhere upstream — aggregated here from
  //   `requirementResults` via `buildRequirementGroups`.
  // - Entity: an entity passes only if ALL its requirements pass
  //   (`validateEntityRequirements` in packages/ids/src/validation/validator.ts
  //   ANDs across `spec.requirements`). This is `report.summary.overallPassRate`,
  //   read directly rather than recomputed, and is the rate the report showed
  //   before this change.
  // - Specification (coarsest): a specification passes only if every one of
  //   its entities passes, so a handful of scattered failures can fail many
  //   specifications while the entity- and check-level rates stay high.
  //   This is the number that matters for a compliance deliverable.
  let checkPassed = 0;
  let checkFailed = 0;
  for (const groups of requirementGroupsBySpec) {
    for (const group of groups) {
      checkPassed += group.passed;
      checkFailed += group.failed;
    }
  }
  const totalChecksAtCheckLevel = checkPassed + checkFailed;
  const checkLevelPassRate =
    totalChecksAtCheckLevel > 0 ? Math.round((checkPassed / totalChecksAtCheckLevel) * 100) : 100;

  const entityLevelPassRate = report.summary.overallPassRate;

  const specLevelPassRate =
    report.summary.totalSpecifications > 0
      ? Math.round((report.summary.passedSpecifications / report.summary.totalSpecifications) * 100)
      : 100;

  return `<!DOCTYPE html>
<html lang="${esc(locale)}">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>IDS Validation Report - ${esc(report.document.info.title)}</title>
  <style>
    :root {
      --pass: #22c55e; --pass-bg: #dcfce7; --pass-border: #86efac;
      --fail: #ef4444; --fail-bg: #fef2f2; --fail-border: #fca5a5;
      --warn: #eab308; --muted: #6b7280; --border: #e5e7eb;
      --bg: #f8fafc; --card: #fff; --hover: #f1f5f9;
    }
    * { box-sizing: border-box; margin: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 1400px; margin: 0 auto; padding: 20px; background: var(--bg); color: #1e293b; line-height: 1.5; }
    h1 { font-size: 1.5rem; margin-bottom: 4px; }
    h2 { font-size: 1.25rem; margin-bottom: 8px; }
    h3 { font-size: 1rem; }
    .card { background: var(--card); border-radius: 8px; padding: 20px; margin-bottom: 16px; box-shadow: 0 1px 3px rgba(0,0,0,0.06), 0 1px 2px rgba(0,0,0,0.04); }
    .meta { color: var(--muted); font-size: 0.875rem; margin-top: 4px; }
    .meta span { margin-right: 16px; }

    /* Summary grid */
    .summary { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 12px; margin-top: 12px; }
    .stat { text-align: center; padding: 12px; background: var(--bg); border-radius: 8px; border: 1px solid var(--border); }
    .stat .value { font-size: 1.75rem; font-weight: 700; }
    .stat .label { color: var(--muted); font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.05em; }
    .stat.pass .value { color: var(--pass); }
    .stat.fail .value { color: var(--fail); }

    /* Progress bar */
    .progress { height: 8px; background: var(--fail-bg); border-radius: 4px; overflow: hidden; margin: 8px 0; }
    .progress-fill { height: 100%; background: var(--pass); border-radius: 4px; transition: width 0.3s; }

    /* Filter toolbar */
    .toolbar { display: flex; gap: 8px; align-items: center; margin-bottom: 12px; flex-wrap: wrap; }
    .toolbar input[type="text"] { padding: 6px 12px; border: 1px solid var(--border); border-radius: 6px; font-size: 0.875rem; min-width: 200px; }
    .toolbar input[type="text"]:focus { outline: none; border-color: #3b82f6; box-shadow: 0 0 0 2px rgba(59,130,246,0.2); }
    .filter-btn { padding: 5px 12px; border: 1px solid var(--border); border-radius: 6px; background: var(--card); cursor: pointer; font-size: 0.8rem; font-weight: 500; }
    .filter-btn:hover { background: var(--hover); }
    .filter-btn.active { background: #1e293b; color: white; border-color: #1e293b; }
    .result-count { color: var(--muted); font-size: 0.8rem; margin-left: auto; }

    /* Specification sections */
    .spec { border: 1px solid var(--border); border-radius: 8px; margin-bottom: 12px; overflow: hidden; }
    .spec-header { padding: 16px; cursor: pointer; display: flex; align-items: flex-start; gap: 12px; }
    .spec-header:hover { background: var(--hover); }
    .spec-indicator { font-size: 1.25rem; margin-top: 2px; transition: transform 0.2s; }
    .spec.open .spec-indicator { transform: rotate(90deg); }
    .spec-info { flex: 1; }
    .spec-info h3 { display: flex; align-items: center; gap: 8px; }
    .spec-desc { color: var(--muted); font-size: 0.875rem; margin-top: 4px; }
    .spec-stats { display: flex; gap: 16px; font-size: 0.8rem; color: var(--muted); margin-top: 8px; }
    .spec-body { display: none; border-top: 1px solid var(--border); }
    .spec.open .spec-body { display: block; }

    /* Entity table */
    table { width: 100%; border-collapse: collapse; font-size: 0.875rem; }
    th { padding: 8px 12px; text-align: left; background: var(--bg); font-weight: 600; font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.05em; color: var(--muted); cursor: pointer; user-select: none; white-space: nowrap; border-bottom: 2px solid var(--border); }
    th:hover { background: #e2e8f0; }
    th .sort-icon { margin-left: 4px; opacity: 0.3; }
    th.sorted .sort-icon { opacity: 1; }
    td { padding: 8px 12px; border-bottom: 1px solid #f1f5f9; vertical-align: top; }
    tr.entity-row:hover { background: var(--hover); }
    tr.entity-row[data-status="fail"] { background: #fefce8; }
    tr.entity-row[data-status="fail"]:hover { background: #fef9c3; }

    /* Badges */
    .badge { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 0.7rem; font-weight: 700; letter-spacing: 0.05em; }
    .badge-pass { background: var(--pass-bg); color: #166534; border: 1px solid var(--pass-border); }
    .badge-fail { background: var(--fail-bg); color: #991b1b; border: 1px solid var(--fail-border); }
    .badge-spec { font-size: 0.7rem; padding: 2px 6px; }

    /* Columns */
    .col-status { width: 60px; }
    .col-type { width: 140px; font-family: monospace; font-size: 0.8rem; }
    .col-name { min-width: 120px; }
    .col-globalid { width: 200px; }
    .col-expressid { width: 70px; text-align: right; font-family: monospace; }
    .col-reqs { width: 60px; text-align: center; }
    .col-details { min-width: 200px; }

    /* GlobalId */
    code.globalid { font-size: 0.75rem; background: #f1f5f9; padding: 2px 6px; border-radius: 3px; cursor: pointer; word-break: break-all; }
    code.globalid:hover { background: #e2e8f0; }
    code.globalid.copied { background: var(--pass-bg); }

    /* Requirement details */
    details summary { cursor: pointer; color: var(--fail); font-size: 0.8rem; }
    details summary:hover { text-decoration: underline; }
    .req-list { padding: 8px 0; }
    .req-detail { padding: 6px 0; border-bottom: 1px solid #f1f5f9; }
    .req-detail:last-child { border-bottom: none; }
    .req-facet { display: inline-block; background: #f1f5f9; padding: 1px 6px; border-radius: 3px; font-size: 0.7rem; font-weight: 600; text-transform: uppercase; color: var(--muted); margin-right: 6px; }
    .req-desc { font-size: 0.8rem; }
    .req-failure { color: var(--fail); font-size: 0.8rem; margin-top: 2px; }
    .req-values { display: flex; gap: 16px; font-size: 0.75rem; color: var(--muted); margin-top: 2px; }
    .req-values code { background: #fef3c7; padding: 1px 4px; border-radius: 2px; color: #92400e; }
    .all-pass { color: var(--pass); font-size: 0.8rem; }
    .pass-count { color: var(--pass); font-weight: 600; }
    .total-count { color: var(--muted); }

    /* Two-rates (check level vs specification level) */
    .two-rates { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 16px; margin-top: 16px; }
    .rate-block { padding: 12px; background: var(--bg); border-radius: 8px; border: 1px solid var(--border); }
    .rate-block-header { display: flex; align-items: baseline; gap: 8px; margin-bottom: 6px; }
    .rate-value { font-size: 1.5rem; font-weight: 700; }
    .rate-label { color: var(--muted); font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.05em; }
    .rate-detail { color: var(--muted); font-size: 0.8rem; margin-top: 4px; }
    .rate-explainer { font-size: 0.8rem; color: var(--muted); margin-top: 12px; line-height: 1.6; }
    .export-note { font-size: 0.8rem; color: var(--muted); margin-top: 8px; padding-top: 8px; border-top: 1px solid var(--border); }

    /* Requirement groups */
    .req-groups { padding: 16px; }
    .req-groups h4 { margin-bottom: 10px; font-size: 0.85rem; text-transform: uppercase; letter-spacing: 0.05em; color: var(--muted); }
    .req-group { border: 1px solid var(--border); border-radius: 6px; padding: 10px 12px; margin-bottom: 8px; }
    .req-group-pass { background: var(--pass-bg); border-color: var(--pass-border); }
    .req-group-fail { background: #fffbeb; border-color: var(--warn); }
    .req-group-header { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
    .req-group-stats { font-size: 0.8rem; color: var(--muted); margin-top: 4px; }
    .req-na { color: var(--muted); }
    .req-group-failures { margin-top: 10px; }
    .req-fail-table { width: 100%; border-collapse: collapse; font-size: 0.8rem; background: var(--card); }
    .req-fail-table th { padding: 6px 10px; text-align: left; background: var(--bg); font-weight: 600; font-size: 0.7rem; text-transform: uppercase; color: var(--muted); border-bottom: 2px solid var(--border); }
    .req-fail-table td { padding: 6px 10px; border-bottom: 1px solid #f1f5f9; vertical-align: top; }
    .col-failure { min-width: 200px; color: var(--fail); }
    .truncation-note { font-size: 0.75rem; color: var(--muted); font-style: italic; margin-top: 6px; }
    .truncation-total { font-weight: 600; }

    /* Secondary per-entity table */
    .entity-table-details { padding: 0 16px 16px; }
    .entity-table-details summary { cursor: pointer; font-size: 0.85rem; color: var(--muted); padding: 8px 0; }
    .entity-table-details summary:hover { color: #1e293b; }
    .entity-table-details table { border-top: 1px solid var(--border); }

    /* Responsive */
    @media (max-width: 768px) {
      .col-globalid, .col-expressid { display: none; }
      .toolbar { flex-direction: column; }
      .toolbar input[type="text"] { width: 100%; min-width: unset; }
    }

    /* Print */
    @media print {
      body { background: white; max-width: none; }
      .card { box-shadow: none; border: 1px solid #ddd; }
      .toolbar { display: none; }
      .spec.open .spec-body { display: block; }
      details { open; }
      details[open] summary { display: none; }
    }

    .hidden { display: none !important; }
  </style>
</head>
<body>
  <!-- Header -->
  <div class="card">
    <h1>${esc(report.document.info.title)}</h1>
    ${report.document.info.description ? `<p style="color: var(--muted); margin-top: 4px;">${esc(report.document.info.description)}</p>` : ''}
    <div class="meta">
      ${report.document.info.author ? `<span>Author: ${esc(report.document.info.author)}</span>` : ''}
      <span>Generated: ${esc(report.timestamp.toLocaleString())}</span>
      <span>Schema: ${esc(report.modelInfo.schemaVersion)}</span>
    </div>
  </div>

  <!-- Summary -->
  <div class="card">
    <h2>Summary</h2>
    <div class="summary">
      <div class="stat">
        <div class="value">${report.summary.totalSpecifications}</div>
        <div class="label">Specifications</div>
      </div>
      <div class="stat pass">
        <div class="value">${report.summary.passedSpecifications}</div>
        <div class="label">Specs Passed</div>
      </div>
      <div class="stat fail">
        <div class="value">${report.summary.failedSpecifications}</div>
        <div class="label">Specs Failed</div>
      </div>
      <div class="stat">
        <div class="value">${totalChecks}</div>
        <div class="label">Entities Checked</div>
      </div>
      <div class="stat pass">
        <div class="value">${totalPassed}</div>
        <div class="label">Passed</div>
      </div>
      <div class="stat fail">
        <div class="value">${totalFailed}</div>
        <div class="label">Failed</div>
      </div>
    </div>

    <!-- The three rates below measure different things and are EXPECTED to
         disagree; see the explanation text. -->
    <div class="two-rates">
      <div class="rate-block">
        <div class="rate-block-header">
          <span class="rate-value">${checkLevelPassRate}%</span>
          <span class="rate-label">Check pass rate</span>
        </div>
        <div class="progress"><div class="progress-fill" style="width: ${checkLevelPassRate}%;"></div></div>
        <div class="rate-detail">${checkPassed} of ${totalChecksAtCheckLevel} element&ndash;requirement checks passed</div>
      </div>
      <div class="rate-block">
        <div class="rate-block-header">
          <span class="rate-value">${entityLevelPassRate}%</span>
          <span class="rate-label">Entity pass rate</span>
        </div>
        <div class="progress"><div class="progress-fill" style="width: ${entityLevelPassRate}%;"></div></div>
        <div class="rate-detail">${totalPassed} of ${totalChecks} applicable entities passed every requirement</div>
      </div>
      <div class="rate-block">
        <div class="rate-block-header">
          <span class="rate-value">${specLevelPassRate}%</span>
          <span class="rate-label">Specification pass rate</span>
        </div>
        <div class="progress"><div class="progress-fill" style="width: ${specLevelPassRate}%;"></div></div>
        <div class="rate-detail">${report.summary.passedSpecifications} of ${report.summary.totalSpecifications} specifications fully passed</div>
      </div>
    </div>
    <p class="rate-explainer">
      These three numbers can legitimately differ &mdash; each answers a different question. <strong>Check
      pass rate</strong> is how much of the model is compliant, check by check (one element measured against
      one requirement). <strong>Entity pass rate</strong> requires an entity to pass every requirement of its
      specification to count as passing at all. <strong>Specification pass rate</strong> goes one step further:
      a specification passes only if every applicable entity passes it &mdash; one failing element fails the
      whole specification, the way one missing handrail fails a safety inspection. For a compliance
      deliverable, the specification pass rate is the number that matters: &ldquo;we passed
      ${report.summary.passedSpecifications} of ${report.summary.totalSpecifications} specifications&rdquo; is
      the honest statement, not the higher check-level or entity-level percentage.
    </p>
    <p class="export-note">
      This HTML report is a <strong>summary</strong>, not a data source: long failing-element lists are
      truncated below. For complete, untruncated results, use the JSON export.
    </p>
  </div>

  <!-- Filter toolbar -->
  <div class="card">
    <div class="toolbar">
      <input type="text" id="search" placeholder="Search by name, type, or GlobalId..." oninput="filterAll()">
      <button class="filter-btn active" data-filter="all" onclick="setFilter('all')">All</button>
      <button class="filter-btn" data-filter="fail" onclick="setFilter('fail')">Failed Only</button>
      <button class="filter-btn" data-filter="pass" onclick="setFilter('pass')">Passed Only</button>
      <span class="result-count" id="result-count"></span>
    </div>

    <h2>Specifications</h2>

    ${report.specificationResults.map((spec, i) => {
      const reqGroups = requirementGroupsBySpec[i];
      const specCheckPassed = reqGroups.reduce((s, g) => s + g.passed, 0);
      const specCheckTotal = reqGroups.reduce((s, g) => s + g.passed + g.failed, 0);
      const specCheckRate = specCheckTotal > 0 ? Math.round((specCheckPassed / specCheckTotal) * 100) : 100;
      return `
    <div class="spec ${spec.status === 'fail' ? 'open' : ''}" id="spec-${i}">
      <div class="spec-header" onclick="toggleSpec(${i})">
        <span class="spec-indicator">&#9654;</span>
        <div class="spec-info">
          <h3>
            <span class="badge badge-spec ${spec.status === 'pass' ? 'badge-pass' : spec.status === 'fail' ? 'badge-fail' : ''}">${spec.status.toUpperCase()}</span>
            ${esc(spec.specification.name)}
          </h3>
          ${spec.specification.description ? `<div class="spec-desc">${esc(spec.specification.description)}</div>` : ''}
          <div class="spec-stats">
            <span>${spec.applicableCount} applicable</span>
            <span style="color: var(--pass);">${spec.passedCount} entities passed</span>
            <span style="color: var(--fail);">${spec.failedCount} entities failed</span>
            <span>${spec.passRate}% of entities passed</span>
            <span>${specCheckPassed}/${specCheckTotal} checks passed (${specCheckRate}%)</span>
          </div>
          <div class="progress" style="margin-top: 6px;">
            <div class="progress-fill" style="width: ${spec.passRate}%;"></div>
          </div>
        </div>
      </div>
      <div class="spec-body">
        <div class="req-groups">
          <h4>Requirements</h4>
          ${reqGroups.map(g => buildRequirementGroupHTML(g, esc)).join('')}
        </div>
        <details class="entity-table-details">
          <summary>Per-entity results (${spec.entityResults.length} ${spec.entityResults.length === 1 ? 'entity' : 'entities'})</summary>
          <table>
            <thead>
              <tr>
                <th class="col-status" onclick="sortTable(${i}, 0)">Status <span class="sort-icon">&#x25B4;&#x25BE;</span></th>
                <th class="col-type" onclick="sortTable(${i}, 1)">IFC Class <span class="sort-icon">&#x25B4;&#x25BE;</span></th>
                <th class="col-name" onclick="sortTable(${i}, 2)">Name <span class="sort-icon">&#x25B4;&#x25BE;</span></th>
                <th class="col-globalid" onclick="sortTable(${i}, 3)">GlobalId <span class="sort-icon">&#x25B4;&#x25BE;</span></th>
                <th class="col-expressid" onclick="sortTable(${i}, 4)">ID <span class="sort-icon">&#x25B4;&#x25BE;</span></th>
                <th class="col-reqs">Reqs</th>
                <th class="col-details">Details</th>
              </tr>
            </thead>
            <tbody id="tbody-${i}">
              ${buildEntityRows(spec, esc)}
            </tbody>
          </table>
        </details>
      </div>
    </div>
    `;
    }).join('')}
  </div>

  <footer style="text-align: center; color: var(--muted); padding: 20px; font-size: 0.8rem;">
    Generated by <strong>IFC-Lite</strong> IDS Validator &middot; ${esc(new Date().toISOString().split('T')[0])}
  </footer>

  <script>
    let currentFilter = 'all';

    function toggleSpec(i) {
      document.getElementById('spec-' + i).classList.toggle('open');
    }

    function setFilter(filter) {
      currentFilter = filter;
      document.querySelectorAll('.filter-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.filter === filter);
      });
      filterAll();
    }

    function filterAll() {
      const search = document.getElementById('search').value.toLowerCase();
      let visible = 0, total = 0;

      document.querySelectorAll('.entity-row').forEach(row => {
        total++;
        const status = row.dataset.status;
        const text = row.textContent.toLowerCase();
        const matchesFilter = currentFilter === 'all' || status === currentFilter;
        const matchesSearch = !search || text.includes(search);
        const show = matchesFilter && matchesSearch;
        row.classList.toggle('hidden', !show);
        if (show) visible++;
      });

      document.getElementById('result-count').textContent =
        search || currentFilter !== 'all'
          ? visible + ' of ' + total + ' entities shown'
          : total + ' entities';
    }

    function sortTable(specIndex, colIndex) {
      const tbody = document.getElementById('tbody-' + specIndex);
      const rows = Array.from(tbody.querySelectorAll('tr.entity-row'));

      const th = tbody.parentElement.querySelectorAll('th')[colIndex];
      const asc = !th.classList.contains('sorted-asc');

      tbody.parentElement.querySelectorAll('th').forEach(h => {
        h.classList.remove('sorted', 'sorted-asc', 'sorted-desc');
      });
      th.classList.add('sorted', asc ? 'sorted-asc' : 'sorted-desc');

      rows.sort((a, b) => {
        let aVal = a.cells[colIndex].textContent.trim();
        let bVal = b.cells[colIndex].textContent.trim();

        if (colIndex === 4) {
          return asc ? Number(aVal) - Number(bVal) : Number(bVal) - Number(aVal);
        }

        return asc ? aVal.localeCompare(bVal) : bVal.localeCompare(aVal);
      });

      rows.forEach(row => tbody.appendChild(row));
    }

    document.addEventListener('click', function(e) {
      if (e.target.classList.contains('globalid') && e.target.textContent !== '\\u2014') {
        navigator.clipboard.writeText(e.target.textContent).then(() => {
          e.target.classList.add('copied');
          setTimeout(() => e.target.classList.remove('copied'), 1000);
        });
      }
    });

    filterAll();
  </script>
</body>
</html>`;
}

/**
 * Trigger an HTML report download in the browser.
 */
export function downloadReportHTML(report: IDSValidationReport, locale: SupportedLocale): void {
  const html = buildReportHTML(report, locale);
  downloadFile(html, `ids-report-${new Date().toISOString().split('T')[0]}.html`, 'text/html');
  posthog.capture('ids_report_exported', { format: 'html', locale, total_specifications: report.summary.totalSpecifications });
}
