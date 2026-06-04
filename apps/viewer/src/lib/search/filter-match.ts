/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Per-rule value resolution + matching for the path-B evaluator.
 *
 * Split out of `filter-evaluate.ts` (which keeps the iteration /
 * orchestration logic) to stay under the module size cap. These helpers
 * are pure given their inputs, which is what makes them unit-testable in
 * `filter-evaluate.test.ts` via the evaluator's `__internal` re-export.
 */

import {
  extractPropertiesOnDemand,
  extractQuantitiesOnDemand,
  type IfcDataStore,
  type MaterialInfo,
  type ClassificationInfo,
} from '@ifc-lite/parser';

import {
  valueOpMatches,
  numericOpMatches,
  matchStringAnyNone,
  type PropertyRule,
  type QuantityRule,
  type ClassificationRule,
} from './filter-rules.js';

// ── Pset / Qto matching ──────────────────────────────────────────────────────

export interface PsetRow { setName: string; propertyName: string; value: string }
export type PsetRows = ReadonlyArray<PsetRow>;

export interface QtyRow { setName: string; quantityName: string; value: number }
export type QtyRows = ReadonlyArray<QtyRow>;

export function flattenPsets(
  psets: ReturnType<typeof extractPropertiesOnDemand>,
): PsetRows {
  const out: PsetRow[] = [];
  for (const set of psets) {
    for (const p of set.properties) {
      out.push({
        setName: set.name,
        propertyName: p.name,
        // Stringify everything — `valueOpMatches` re-parses numeric ops
        // from this representation. Booleans render as "true"/"false"
        // which matches the chip UI's lowercased input convention.
        value: stringifyValue(p.value),
      });
    }
  }
  return out;
}

export function flattenQtys(
  qtos: ReturnType<typeof extractQuantitiesOnDemand>,
): QtyRows {
  const out: QtyRow[] = [];
  for (const set of qtos) {
    for (const q of set.quantities) {
      out.push({ setName: set.name, quantityName: q.name, value: q.value });
    }
  }
  return out;
}

export function stringifyValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return String(value);
  return String(value);
}

export function matchPropertyRule(rule: PropertyRule, rows: PsetRows): boolean {
  // isSet / isNotSet are presence checks against (setName, propertyName).
  if (rule.op === 'isSet' || rule.op === 'isNotSet') {
    const present = rows.some(
      (r) =>
        r.setName.toLowerCase() === rule.setName.toLowerCase() &&
        r.propertyName.toLowerCase() === rule.propertyName.toLowerCase(),
    );
    return rule.op === 'isSet' ? present : !present;
  }

  return rows.some(
    (r) =>
      r.setName.toLowerCase() === rule.setName.toLowerCase() &&
      r.propertyName.toLowerCase() === rule.propertyName.toLowerCase() &&
      valueOpMatches(rule.op, r.value, rule.value),
  );
}

export function matchQuantityRule(rule: QuantityRule, rows: QtyRows): boolean {
  return rows.some(
    (r) =>
      r.setName.toLowerCase() === rule.setName.toLowerCase() &&
      r.quantityName.toLowerCase() === rule.quantityName.toLowerCase() &&
      numericOpMatches(rule.op, r.value, rule.value),
  );
}

// ── Storey lookup fallback ────────────────────────────────────────────────────

export function defaultStoreyName(store: IfcDataStore, expressId: number): string {
  const hierarchy = store.spatialHierarchy;
  if (!hierarchy) return '';
  const storeyId = hierarchy.elementToStorey.get(expressId);
  if (!storeyId) return '';
  return store.entities.getName(storeyId);
}

// ── Material / classification / elevation resolution ─────────────────────────

/** Collect every material-name string an element exposes — top-level
 *  material, plus layer / constituent / profile names and list members.
 *  Used by the multi-valued `material` rule matcher. */
export function materialNamesOf(info: MaterialInfo | null): string[] {
  if (!info) return [];
  const names: string[] = [];
  const push = (s: string | undefined) => { if (s) names.push(s); };
  push(info.name);
  for (const l of info.layers ?? []) { push(l.materialName); push(l.name); }
  for (const c of info.constituents ?? []) { push(c.materialName); push(c.name); }
  for (const p of info.profiles ?? []) { push(p.materialName); push(p.name); }
  for (const m of info.materials ?? []) push(m.name);
  return names;
}

/** Match a classification rule against an element's classification refs.
 *  `system` (when set) scopes to one classification system; value ops
 *  match a ref's code (identification) OR name. */
export function matchClassificationRule(
  rule: ClassificationRule,
  refs: readonly ClassificationInfo[],
): boolean {
  const sys = rule.system?.trim().toLowerCase();
  const scoped = sys
    ? refs.filter((r) => (r.system ?? '').toLowerCase() === sys)
    : refs;

  if (rule.op === 'isSet') return scoped.length > 0;
  if (rule.op === 'isNotSet') return scoped.length === 0;

  // Value ops — match against identification (code) and name of each ref.
  const candidates: string[] = [];
  for (const r of scoped) {
    if (r.identification) candidates.push(r.identification);
    if (r.name) candidates.push(r.name);
  }
  // rule.op is now eq | ne | contains | notContains — a StringOp subset.
  return matchStringAnyNone(rule.op, candidates, rule.value);
}

/** Element elevation in metres, derived from its building storey's
 *  elevation. Returns null when the element isn't placed in the spatial
 *  hierarchy (so an elevation rule simply doesn't match it). */
export function elevationOf(store: IfcDataStore, expressId: number): number | null {
  const hierarchy = store.spatialHierarchy;
  if (!hierarchy) return null;
  const storeyId = hierarchy.elementToStorey.get(expressId);
  if (!storeyId) return null;
  const elev = hierarchy.storeyElevations.get(storeyId);
  return typeof elev === 'number' ? elev : null;
}
