/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Structural validation of a `DashboardSpec` / `ReportSpec` read from
 * outside — a saved `.ifclite-dashboard.json`, localStorage, a preset. The
 * shape is small enough that a hand-written checker is clearer than a schema
 * library, and it reports every problem at once with a JSON-pointer-ish path.
 */
import type { ChartSource, ChartType, DashboardSpec, ReportSpec } from './types.js';

export interface DashboardValidationError {
  path: string;
  message: string;
}

const SOURCES: ReadonlySet<string> = new Set<ChartSource>(['elements', 'clash', 'bcf', 'schedule', 'ids', 'compare']);
const TYPES: ReadonlySet<string> = new Set<ChartType>(['bar', 'stackedBar', 'pie', 'treemap', 'histogram', 'timeline']);
const SCOPES: ReadonlySet<string> = new Set(['all', 'visible', 'basket', 'list']);

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function str(errors: DashboardValidationError[], obj: Record<string, unknown>, key: string, path: string, optional = false): void {
  const v = obj[key];
  if (v === undefined && optional) return;
  if (typeof v !== 'string' || v.length === 0) errors.push({ path: `${path}.${key}`, message: 'expected a non-empty string' });
}

function num(errors: DashboardValidationError[], obj: Record<string, unknown>, key: string, path: string, optional = false): void {
  const v = obj[key];
  if (v === undefined && optional) return;
  if (typeof v !== 'number' || !Number.isFinite(v)) errors.push({ path: `${path}.${key}`, message: 'expected a finite number' });
}

function validateChart(chart: unknown, path: string, errors: DashboardValidationError[]): void {
  if (!isRecord(chart)) {
    errors.push({ path, message: 'expected a chart object' });
    return;
  }
  str(errors, chart, 'id', path);
  str(errors, chart, 'title', path);
  if (!SOURCES.has(String(chart.source))) errors.push({ path: `${path}.source`, message: `expected one of ${[...SOURCES].join(', ')}` });
  if (!TYPES.has(String(chart.type))) errors.push({ path: `${path}.type`, message: `expected one of ${[...TYPES].join(', ')}` });
  str(errors, chart, 'dimension', path);
  str(errors, chart, 'stackBy', path, true);
  if (chart.type === 'stackedBar' && typeof chart.stackBy !== 'string') errors.push({ path: `${path}.stackBy`, message: 'a stackedBar needs stackBy' });
  const measure = chart.measure;
  if (!isRecord(measure) || (measure.agg !== 'count' && measure.agg !== 'sum')) {
    errors.push({ path: `${path}.measure`, message: 'expected { agg: "count" | "sum", column? }' });
  } else if (measure.agg === 'sum') {
    str(errors, measure, 'column', `${path}.measure`);
  }
  if (chart.sort !== undefined && chart.sort !== 'value' && chart.sort !== 'label') errors.push({ path: `${path}.sort`, message: 'expected "value" or "label"' });
  num(errors, chart, 'topN', path, true);
  num(errors, chart, 'bins', path, true);
}

/** Every problem in a dashboard/report spec; an empty array means it is one. */
export function validateDashboardSpec(spec: unknown): DashboardValidationError[] {
  const errors: DashboardValidationError[] = [];
  if (!isRecord(spec)) return [{ path: '', message: 'expected a dashboard object' }];
  if (spec.version !== 1) errors.push({ path: '.version', message: 'expected version 1' });
  str(errors, spec, 'id', '');
  str(errors, spec, 'name', '');
  const scope = spec.scope;
  if (!isRecord(scope) || !SCOPES.has(String(scope.kind))) {
    errors.push({ path: '.scope', message: `expected { kind: ${[...SCOPES].join(' | ')} }` });
  } else if (scope.kind === 'list') {
    str(errors, scope, 'listId', '.scope');
  }
  if (!Array.isArray(spec.charts)) {
    errors.push({ path: '.charts', message: 'expected an array of charts' });
  } else {
    const ids = new Set<string>();
    spec.charts.forEach((chart, i) => {
      validateChart(chart, `.charts[${i}]`, errors);
      if (isRecord(chart) && typeof chart.id === 'string') {
        if (ids.has(chart.id)) errors.push({ path: `.charts[${i}].id`, message: `duplicate chart id "${chart.id}"` });
        ids.add(chart.id);
      }
    });
    if (!Array.isArray(spec.layout)) {
      errors.push({ path: '.layout', message: 'expected an array of layout items' });
    } else {
      spec.layout.forEach((item, i) => {
        const path = `.layout[${i}]`;
        if (!isRecord(item)) {
          errors.push({ path, message: 'expected a layout item' });
          return;
        }
        str(errors, item, 'chartId', path);
        if (typeof item.chartId === 'string' && !ids.has(item.chartId)) errors.push({ path: `${path}.chartId`, message: `no chart with id "${item.chartId}"` });
        for (const key of ['x', 'y', 'w', 'h']) num(errors, item, key, path);
      });
    }
  }
  const page = spec.page;
  if (page !== undefined) {
    if (!isRecord(page) || (page.size !== 'A4' && page.size !== 'A3') || (page.orientation !== 'portrait' && page.orientation !== 'landscape')) {
      errors.push({ path: '.page', message: 'expected { size: "A4" | "A3", orientation: "portrait" | "landscape" }' });
    }
    if (!isRecord(spec.titleBlock)) errors.push({ path: '.titleBlock', message: 'expected an object of title-block fields' });
    if (typeof spec.snapshots !== 'boolean') errors.push({ path: '.snapshots', message: 'expected a boolean' });
  }
  return errors;
}

export function isDashboardSpec(spec: unknown): spec is DashboardSpec {
  return validateDashboardSpec(spec).length === 0;
}

export function isReportSpec(spec: unknown): spec is ReportSpec {
  return isRecord(spec) && spec.page !== undefined && validateDashboardSpec(spec).length === 0;
}
