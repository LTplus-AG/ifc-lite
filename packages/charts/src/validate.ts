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

/** The dashboard layout's column count: every `DashboardLayoutItem` lives in a 12-column grid. */
export const DASHBOARD_GRID_COLUMNS = 12;

const SOURCES: ReadonlySet<string> = new Set<ChartSource>(['elements', 'clash', 'bcf', 'schedule', 'ids', 'compare']);
const TYPES: ReadonlySet<string> = new Set<ChartType>(['bar', 'stackedBar', 'pie', 'treemap', 'histogram', 'timeline']);
const SCOPES: ReadonlySet<string> = new Set(['all', 'visible', 'basket']);
/** Sources whose rows do not stand for one matchable element (#4946): a BCF
 *  row is a topic (its "elements" are a viewpoint's component GUIDs, often
 *  none loaded) and a compare row straddles two revisions, so a selector
 *  filter has nothing well-defined to narrow. Exported so the chart editor
 *  disables the same field the validator would otherwise reject. */
export const CHART_FILTER_NOT_APPLICABLE_SOURCES: ReadonlySet<ChartSource> = new Set<ChartSource>(['bcf', 'compare']);

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

const SPATIAL_LEVELS = new Set(['Container', 'Building', 'Site', 'Project']);
const RELATION_KINDS = new Set(['material', 'classification', 'type', 'spatial']);

function validateChart(chart: unknown, path: string, errors: DashboardValidationError[]): void {
  if (!isRecord(chart)) {
    errors.push({ path, message: 'expected a chart object' });
    return;
  }
  str(errors, chart, 'id', path);
  str(errors, chart, 'title', path);
  if (typeof chart.source !== 'string' || !SOURCES.has(chart.source)) errors.push({ path: `${path}.source`, message: `expected one of ${[...SOURCES].join(', ')}` });
  if (typeof chart.type !== 'string' || !TYPES.has(chart.type)) errors.push({ path: `${path}.type`, message: `expected one of ${[...TYPES].join(', ')}` });
  if (chart.elementField !== undefined) {
    const fieldPath = `${path}.elementField`;
    if (!isRecord(chart.elementField)) {
      errors.push({ path: fieldPath, message: 'expected an IFC field binding object' });
    } else {
      const field = chart.elementField;
      if (chart.source !== 'elements') errors.push({ path: fieldPath, message: 'elementField is only valid for the elements source' });
      if (field.valueKind !== 'category' && field.valueKind !== 'number' && field.valueKind !== 'boolean') {
        errors.push({ path: `${fieldPath}.valueKind`, message: 'expected category, number, or boolean' });
      }
      if (field.unit !== undefined && (typeof field.unit !== 'string' || field.unit.length === 0)) {
        errors.push({ path: `${fieldPath}.unit`, message: 'expected a non-empty string' });
      }
      if (field.dataType !== undefined && (typeof field.dataType !== 'string' || field.dataType.length === 0)) {
        errors.push({ path: `${fieldPath}.dataType`, message: 'expected a non-empty IFC measure name' });
      }
      if (field.kind === 'attribute') str(errors, field, 'attributeName', fieldPath);
      else if (field.kind === 'property') {
        str(errors, field, 'psetName', fieldPath);
        str(errors, field, 'propertyName', fieldPath);
      } else if (field.kind === 'quantity') {
        str(errors, field, 'qsetName', fieldPath);
        str(errors, field, 'quantityName', fieldPath);
      } else if (field.kind === 'classification') str(errors, field, 'system', fieldPath, true);
      else if (field.kind === 'spatial') {
        if (typeof field.level !== 'string' || !SPATIAL_LEVELS.has(field.level)) errors.push({ path: `${fieldPath}.level`, message: `expected one of ${[...SPATIAL_LEVELS].join(', ')}` });
      } else if (field.kind !== 'material' && field.kind !== 'type') {
        errors.push({ path: `${fieldPath}.kind`, message: 'expected attribute, property, quantity, material, classification, type or spatial' });
      }
      if (typeof field.kind === 'string' && RELATION_KINDS.has(field.kind) && (field.valueKind === 'number' || field.valueKind === 'boolean')) {
        errors.push({ path: `${fieldPath}.valueKind`, message: 'a material, classification, type or spatial field is always a category' });
      }
      if (field.kind === 'quantity' && field.valueKind === 'boolean') {
        errors.push({ path: `${fieldPath}.valueKind`, message: 'a quantity is a number or a category, never a boolean' });
      }
    }
  }
  if (chart.filter !== undefined) {
    const filterPath = `${path}.filter`;
    if (!isRecord(chart.filter)) {
      errors.push({ path: filterPath, message: 'expected { selector: string }' });
    } else {
      // `clashRule` (#5156): absent means "every rule", same as before this
      // field existed — never an empty string for that (an empty string
      // would be indistinguishable from absent at every reader, which is
      // exactly the sentinel pattern rejected in review on PR #5151).
      let hasClashRule = false;
      if (chart.filter.clashRule !== undefined) {
        str(errors, chart.filter, 'clashRule', filterPath);
        hasClashRule = typeof chart.filter.clashRule === 'string' && chart.filter.clashRule.length > 0;
        if (typeof chart.source === 'string' && chart.source !== 'clash') {
          errors.push({ path: `${filterPath}.clashRule`, message: 'clashRule is only valid for the clash source' });
        }
      }
      // `selector` is a required STRING on the type but, since #5156, may be
      // EMPTY when `clashRule` narrows the chart instead — a filter can now
      // narrow by `clashRule` alone, with no selector text at all;
      // `ChartEditor` always writes the key (possibly `''`) rather than
      // omitting it, so an unset `clashRule` still needs a real selector.
      // Reported once, at `.selector`, whether the string is empty or
      // whitespace-only ("   " would otherwise pass and then resolve to "no
      // filter" at every consumer — they all trim — stranding the chart on
      // "Resolving filter…" forever with no entry to find; review finding).
      if (typeof chart.filter.selector !== 'string') {
        errors.push({ path: `${filterPath}.selector`, message: 'expected a string' });
      } else if (chart.filter.selector.trim().length === 0 && !hasClashRule) {
        errors.push({ path: `${filterPath}.selector`, message: 'expected a non-empty selector' });
      }
      if (typeof chart.source === 'string' && CHART_FILTER_NOT_APPLICABLE_SOURCES.has(chart.source as ChartSource)) {
        errors.push({ path: filterPath, message: 'a source filter is not applicable to bcf or compare' });
      }
    }
  }
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
  if (typeof chart.bins === 'number' && chart.bins < 1) errors.push({ path: `${path}.bins`, message: 'expected at least 1 bin' });
}

/** Every problem in a dashboard/report spec; an empty array means it is one. */
export function validateDashboardSpec(spec: unknown): DashboardValidationError[] {
  const errors: DashboardValidationError[] = [];
  if (!isRecord(spec)) return [{ path: '', message: 'expected a dashboard object' }];
  if (spec.version !== 2) errors.push({ path: '.version', message: 'expected version 2' });
  str(errors, spec, 'id', '');
  str(errors, spec, 'name', '');
  const scope = spec.scope;
  if (!isRecord(scope) || typeof scope.kind !== 'string' || !SCOPES.has(scope.kind)) {
    errors.push({ path: '.scope', message: `expected { kind: ${[...SCOPES].join(' | ')} }` });
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
        // Grid cells: non-negative integers, at least one cell wide/high, inside the column count.
        for (const key of ['x', 'y', 'w', 'h'] as const) {
          const v = item[key];
          if (typeof v !== 'number' || !Number.isFinite(v)) continue;
          if (!Number.isInteger(v) || v < 0) errors.push({ path: `${path}.${key}`, message: 'expected a non-negative integer' });
          else if ((key === 'w' || key === 'h') && v < 1) errors.push({ path: `${path}.${key}`, message: 'expected at least 1' });
        }
        if (typeof item.x === 'number' && typeof item.w === 'number' && item.x + item.w > DASHBOARD_GRID_COLUMNS) {
          errors.push({ path: `${path}.x`, message: `x + w exceeds the ${DASHBOARD_GRID_COLUMNS}-column grid` });
        }
      });
    }
  }
  const page = spec.page;
  if (page !== undefined) {
    if (!isRecord(page) || (page.size !== 'A4' && page.size !== 'A3') || (page.orientation !== 'portrait' && page.orientation !== 'landscape')) {
      errors.push({ path: '.page', message: 'expected { size: "A4" | "A3", orientation: "portrait" | "landscape" }' });
    }
    if (!isRecord(spec.titleBlock)) {
      errors.push({ path: '.titleBlock', message: 'expected an object of title-block fields' });
    } else {
      for (const [key, value] of Object.entries(spec.titleBlock)) {
        if (typeof value !== 'string') errors.push({ path: `.titleBlock.${key}`, message: 'expected a string' });
      }
    }
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
