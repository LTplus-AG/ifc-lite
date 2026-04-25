/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Path-B runtime evaluator.
 *
 * Applies a list of `FilterRule`s to one or more `IfcDataStore`s without
 * touching DuckDB. Designed to chain after Tier-0/Tier-1 text search: the
 * caller passes a candidate set (the search results' expressIds), and we
 * evaluate the structured rules over just that subset — so an empty text
 * query plus `kind:'ifcType'` falls back to scanning the full entity
 * table (still cheap because only EntityTable columns are touched), but
 * `text:"wall" + ifcType:[IfcWall]` only re-checks the ~50 hits.
 *
 * Pset / Qto extraction is lazy: we never call extractPropertiesOnDemand
 * unless a rule actually requires it for the entity in question. This is
 * the load-hot-path-safe equivalent of the Rust `pset_index` map — the
 * cost is paid per-element when needed, not pre-built.
 */

import {
  extractPropertiesOnDemand,
  extractQuantitiesOnDemand,
  type IfcDataStore,
} from '@ifc-lite/parser';

import {
  combineRuleResults,
  setOpMatches,
  stringOpMatches,
  numericOpMatches,
  valueOpMatches,
  type Combinator,
  type FilterRule,
  type PropertyRule,
  type QuantityRule,
} from './filter-rules.js';

/** A single matched element. Mirrors the Rust `FilteredElement` shape. */
export interface FilteredElement {
  modelId: string;
  expressId: number;
  ifcType: string;
  name: string;
  globalId: string;
}

export interface EvaluateOptions {
  /**
   * Restrict evaluation to these expressIds (e.g. the result list from
   * Tier-1). Omit to scan every populated entity in the store.
   */
  candidateExpressIds?: Iterable<number>;
  /** Cap. Default 5_000 — enough for downstream batch ops, cheap to bump. */
  limit?: number;
  /** Optional storey-name resolver. Falls back to "" when omitted. */
  storeyNameOf?: (expressId: number) => string;
  /** Optional predefined-type resolver. Falls back to "" when omitted. */
  predefinedTypeOf?: (expressId: number) => string;
}

const DEFAULT_LIMIT = 5_000;

/**
 * Evaluate `rules` against one model. Returns up to `limit` matching
 * elements, each tagged with `modelId` for federated callers.
 */
export function evaluateFilterRules(
  modelId: string,
  store: IfcDataStore,
  rules: readonly FilterRule[],
  combinator: Combinator,
  options: EvaluateOptions = {},
): FilteredElement[] {
  if (rules.length === 0) return [];

  const limit = options.limit ?? DEFAULT_LIMIT;
  const table = store.entities;
  const out: FilteredElement[] = [];

  // Decide which iteration source to walk.
  //   - candidateExpressIds when the caller has already narrowed (Tier-1)
  //   - otherwise scan the whole expressId column once
  const iterIds: Iterable<number> = options.candidateExpressIds
    ?? iterateAllExpressIds(store);

  // Pset/Qto rules are the only ones that need on-demand extraction.
  // Pre-flag this so the inner loop can skip the expensive work entirely
  // when there are no such rules.
  const hasPropertyRule = rules.some((r) => r.kind === 'property');
  const hasQuantityRule = rules.some((r) => r.kind === 'quantity');

  for (const expressId of iterIds) {
    if (out.length >= limit) break;
    const passes = evaluateOneEntity(
      store,
      expressId,
      rules,
      combinator,
      hasPropertyRule,
      hasQuantityRule,
      options,
    );
    if (!passes) continue;

    out.push({
      modelId,
      expressId,
      ifcType: table.getTypeName(expressId),
      name: table.getName(expressId),
      globalId: table.getGlobalId(expressId),
    });
  }

  return out;
}

export interface FederatedEvaluateOptions extends Omit<EvaluateOptions, 'candidateExpressIds'> {
  /**
   * Optional per-model candidate set. When supplied for a model, only
   * those expressIds are evaluated (the typical use is "narrow with
   * Tier-1 first, then verify structured rules"). Models absent from
   * the map fall back to a full scan of their entity column. Pass an
   * empty iterable to skip a model entirely.
   */
  candidateExpressIdsByModel?: ReadonlyMap<string, Iterable<number>>;
}

/**
 * Evaluate `rules` across multiple federated models, producing a single
 * sorted result list. Mirrors the Rust `run_element_filter` shape.
 */
export function evaluateFilterRulesFederated(
  models: ReadonlyArray<{ id: string; store: IfcDataStore | null }>,
  rules: readonly FilterRule[],
  combinator: Combinator,
  options: FederatedEvaluateOptions = {},
): FilteredElement[] {
  if (rules.length === 0) return [];
  const limit = options.limit ?? DEFAULT_LIMIT;
  const out: FilteredElement[] = [];

  for (const m of models) {
    if (!m.store) continue;
    const remaining = limit - out.length;
    if (remaining <= 0) break;
    const candidates = options.candidateExpressIdsByModel?.get(m.id);
    const local = evaluateFilterRules(m.id, m.store, rules, combinator, {
      storeyNameOf: options.storeyNameOf,
      predefinedTypeOf: options.predefinedTypeOf,
      candidateExpressIds: candidates,
      limit: remaining,
    });
    out.push(...local);
  }
  return out;
}

// ── Internals ─────────────────────────────────────────────────────────────────

function* iterateAllExpressIds(store: IfcDataStore): IterableIterator<number> {
  const table = store.entities;
  const ids = table.expressId;
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i];
    if (id !== 0) yield id;
  }
}

function evaluateOneEntity(
  store: IfcDataStore,
  expressId: number,
  rules: readonly FilterRule[],
  combinator: Combinator,
  hasPropertyRule: boolean,
  hasQuantityRule: boolean,
  options: EvaluateOptions,
): boolean {
  const table = store.entities;

  // Lazy pset/qto reads — only invoked when a property/quantity rule
  // actually needs the data for *this* entity. Cached for the lifetime
  // of the evaluation call (one entity at a time).
  let psetCache: PsetRows | null = null;
  let qtyCache: QtyRows | null = null;
  const psetsFor = (): PsetRows => {
    if (!psetCache) psetCache = flattenPsets(extractPropertiesOnDemand(store, expressId));
    return psetCache;
  };
  const qtysFor = (): QtyRows => {
    if (!qtyCache) qtyCache = flattenQtys(extractQuantitiesOnDemand(store, expressId));
    return qtyCache;
  };

  // Short-circuit aware: AND fails on first false; OR succeeds on first true.
  const ruleResults: boolean[] = [];
  for (const rule of rules) {
    const result = evaluateRule(
      rule,
      store,
      expressId,
      table,
      hasPropertyRule ? psetsFor : null,
      hasQuantityRule ? qtysFor : null,
      options,
    );
    ruleResults.push(result);

    if (combinator === 'AND' && !result) return false;
    if (combinator === 'OR' && result) return true;
  }
  return combineRuleResults(combinator, ruleResults);
}

function evaluateRule(
  rule: FilterRule,
  store: IfcDataStore,
  expressId: number,
  table: IfcDataStore['entities'],
  psetsFor: (() => PsetRows) | null,
  qtysFor: (() => QtyRows) | null,
  options: EvaluateOptions,
): boolean {
  switch (rule.kind) {
    case 'storey': {
      const storeyName = options.storeyNameOf?.(expressId)
        ?? defaultStoreyName(store, expressId);
      return setOpMatches(rule.op, storeyName, rule.values);
    }
    case 'ifcType': {
      return setOpMatches(rule.op, table.getTypeName(expressId), rule.values);
    }
    case 'predefinedType': {
      const pt = options.predefinedTypeOf?.(expressId) ?? '';
      return setOpMatches(rule.op, pt, rule.values);
    }
    case 'name': {
      return stringOpMatches(rule.op, table.getName(expressId), rule.value);
    }
    case 'property': {
      if (!psetsFor) return false;
      return matchPropertyRule(rule, psetsFor());
    }
    case 'quantity': {
      if (!qtysFor) return false;
      return matchQuantityRule(rule, qtysFor());
    }
  }
}

// ── Pset / Qto matching ──────────────────────────────────────────────────────

interface PsetRow { setName: string; propertyName: string; value: string }
type PsetRows = ReadonlyArray<PsetRow>;

interface QtyRow { setName: string; quantityName: string; value: number }
type QtyRows = ReadonlyArray<QtyRow>;

function flattenPsets(
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

function flattenQtys(
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

function stringifyValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return String(value);
  return String(value);
}

function matchPropertyRule(rule: PropertyRule, rows: PsetRows): boolean {
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

function matchQuantityRule(rule: QuantityRule, rows: QtyRows): boolean {
  return rows.some(
    (r) =>
      r.setName.toLowerCase() === rule.setName.toLowerCase() &&
      r.quantityName.toLowerCase() === rule.quantityName.toLowerCase() &&
      numericOpMatches(rule.op, r.value, rule.value),
  );
}

// ── Storey lookup fallback ────────────────────────────────────────────────────

function defaultStoreyName(store: IfcDataStore, expressId: number): string {
  // Prefer the spatial hierarchy when available — O(1) lookup via the
  // pre-built elementToStorey map. Without it, fall back to "" so the
  // setOp comparison just degrades to "no match for storey rules".
  const hierarchy = store.spatialHierarchy;
  if (!hierarchy) return '';
  const storeyId = hierarchy.elementToStorey.get(expressId);
  if (!storeyId) return '';
  return store.entities.getName(storeyId);
}

// ── Exposed for tests ────────────────────────────────────────────────────────

export const __internal = {
  flattenPsets,
  flattenQtys,
  stringifyValue,
  matchPropertyRule,
  matchQuantityRule,
};
