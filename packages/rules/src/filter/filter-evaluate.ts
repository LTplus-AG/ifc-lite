/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Path-B runtime evaluator.
 *
 * Applies a list of `FilterRule`s to one or more `IfcDataStore`s without
 * touching DuckDB. Three optimisations make this safe on huge (4M-entity)
 * models without a Worker:
 *
 *  1. **Index prefilter (AND + op:in only).** When the rule list contains
 *     any `ifcType` or `storey` `op:'in'` rule under an AND combinator,
 *     the iteration source is derived from `entityIndex.byType` /
 *     `spatialHierarchy.byStorey` — typically 100× narrowing. Per-entity
 *     rule evaluation still re-checks every rule for correctness, so
 *     picking one prefilter (the smallest bucket) is enough; we don't
 *     need to intersect. `notIn` and `OR` skip the prefilter and fall
 *     back to the full column scan.
 *
 *  2. **Cheap-first per-entity ordering.** Rules are sorted by cost at
 *     evaluation time so column-only checks (`ifcType`, `name`, `storey`,
 *     `predefinedType`) run before `property` / `quantity` rules that
 *     trigger on-demand source-buffer parses. Combined with AND/OR
 *     short-circuit, this avoids the AGENTS.md §2 "never call
 *     extractPropertiesOnDemand in a large loop" trap — a single
 *     ifcType rule excluding 99% of entities skips 99% of the parses.
 *
 *  3. **Async chunked yielding (federated entry).** The federated entry
 *     is async and yields to the event loop every `chunkSize` rows
 *     (default 20_000, same as `buildTier1Index`). `AbortSignal` is
 *     honoured at chunk boundaries; an `onProgress(scanned, total)`
 *     callback fires once per chunk. The synchronous single-model
 *     entry remains for tests and small candidate sets.
 */

import {
  extractPropertiesOnDemand,
  extractTypePropertiesOnDemand,
  extractAllMaterialsOnDemand,
  extractClassificationsOnDemand,
  mergeInheritedPropertySets,
  type IfcDataStore,
  type ClassificationInfo,
} from '@ifc-lite/parser';
import { ownPropertySetsFor, typePropertySetsFor, quantitySetsFor, attributesFor, mutatedAttributeValue } from './filter-evaluate-mutations.js';

import { RelationshipType } from '@ifc-lite/data';
import type { MutablePropertyView } from '@ifc-lite/mutations';

import {
  combineRuleResults,
  type Combinator,
  type FilterRule,
} from './filter-rules.js';
import {
  setOpMatches,
  globalIdOpMatches,
  stringOpMatches,
  matchStringAnyNone,
  numericOpMatches,
} from './filter-ops.js';
import {
  isNumericArrayLike,
  materialiseNumericIterable,
  toNumericIterable,
} from './filter-iteration.js';
import { selectIterationSource, orderRulesByCost } from './filter-iteration-source.js';
import { buildFilterResult, effectiveFilterFields, type EffectiveFilterFields } from './effective-filter-fields.js';
import { throwAbort, yieldToEventLoop } from './filter-evaluate-yield.js';
import {
  modelPrunedUnderAnd,
  modelScopedRuleMatches,
  isModelScopedRule,
  NO_MODEL_TAGS,
  type ModelScope,
} from './filter-evaluate-model-tag.js';

import {
  flattenPsets,
  flattenQtys,
  stringifyValue,
  matchPropertyRule,
  matchQuantityRule,
  matchAttributeRule,
  defaultStoreyName,
  storeyMatchesRefs,
  materialNamesOf, materialMatchCandidates,
  matchClassificationRule, matchParentRule,
  elevationOf,
  type AttrRows,
  type PsetRows,
  type QtyRows,
} from './filter-match.js';
import { resolveEntityPredefinedType } from './entity-predefined-type.js';
import { matchGroupRule } from './filter-group-rule.js';

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
   * Tier-1). Omit to scan every populated entity in the store, with
   * index prefilters applied where possible.
   */
  candidateExpressIds?: Iterable<number>;
  /** Cap. Default 5_000 — enough for downstream batch ops, cheap to bump. */
  limit?: number;
  /** Optional storey-name resolver. Falls back to spatial-hierarchy lookup. */
  storeyNameOf?: (expressId: number) => string;
  /** Optional predefined-type resolver. Falls back to "" when omitted. */
  predefinedTypeOf?: (expressId: number) => string;
  /** Stable identity used by persisted model rules; defaults to `modelId`. */
  modelFilterIdentity?: string;
  /** This model's tag ids (`modelTag` rules, #4215); absent = untagged. */
  modelTagIds?: ReadonlySet<string>;
  /** Every tag id that exists. A `modelTag` rule naming any other id is
   *  UNRESOLVED and matches nothing — absent means "no tags exist", so every
   *  rule naming a tag is unresolved, never silently broad. */
  definedModelTagIds?: ReadonlySet<string>;
}

const DEFAULT_LIMIT = 5_000;
const DEFAULT_CHUNK_SIZE = 20_000;

// ── Sync entry (small candidate sets, tests) ─────────────────────────────────

/**
 * Evaluate `rules` against one model synchronously. Suitable for tests
 * and small candidate sets where the chunked async path's overhead
 * isn't justified. For real UI flows (huge models, cancellable runs),
 * use `evaluateFilterRulesFederated` (async).
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
  const orderedRules = orderRulesByCost(rules);
  const iterIds = toNumericIterable(
    selectIterationSource(store, rules, combinator, options.candidateExpressIds, modelId),
  );
  const out: FilteredElement[] = [];
  const ctx: EvalContext = {
    store,
    modelId,
    scope: {
      filterIdentity: options.modelFilterIdentity ?? modelId,
      tagIds: options.modelTagIds,
      definedModelTagIds: options.definedModelTagIds ?? NO_MODEL_TAGS,
    },
    table: store.entities,
    options,
    hasPropertyRule: orderedRules.some((r) => r.kind === 'property'),
    hasQuantityRule: orderedRules.some((r) => r.kind === 'quantity'),
    hasMaterialRule: orderedRules.some((r) => r.kind === 'material'),
    hasClassificationRule: orderedRules.some((r) => r.kind === 'classification'),
    hasAttributeRule: orderedRules.some((r) => r.kind === 'attribute'),
    typePsetCache: new Map(),
  };

  for (const expressId of iterIds) {
    if (out.length >= limit) break;
    // Skip empty rows from the raw expressId column. ArrayLike sources
    // (the full-table fast-path) include zero-padded slots; bucket
    // sources (byType / byStorey) never do, so this is a no-op there.
    if (!expressId) continue;
    const fields = evaluateOneEntity(ctx, expressId, orderedRules, combinator);
    if (!fields) continue;
    out.push(buildFilterResult(modelId, expressId, fields));
  }
  return out;
}

// ── Async federated entry — production UI path ──────────────────────────────

export interface FederatedEvaluateOptions extends Omit<EvaluateOptions, 'candidateExpressIds'> {
  /**
   * Optional per-model candidate set. When supplied for a model, only
   * those expressIds are evaluated (the typical use is "narrow with
   * Tier-1 first, then verify structured rules"). Models absent from
   * the map fall back to a full scan with index prefilters applied.
   * Pass an empty iterable to skip a model entirely.
   */
  candidateExpressIdsByModel?: ReadonlyMap<string, Iterable<number>>;
  /** Rows per yield boundary. Default 20_000. */
  chunkSize?: number;
  /** Aborts the run between chunks. Throws DOMException("…", "AbortError"). */
  signal?: AbortSignal;
  /** Progress callback fired after each chunk: (scanned, total). When
   *  `total` is unknown (Tier-1 candidate iterables without `.size`),
   *  it's reported as -1. */
  onProgress?: (scanned: number, total: number) => void;
}

/**
 * Evaluate `rules` across multiple federated models, producing a single
 * sorted result list. Async chunked + cancellable + progress-reporting.
 */
/** One federated model as the evaluator sees it. `tagIds` is the model's tag
 *  set at call time — a SNAPSHOT: re-tagging while a run is in flight does not
 *  change what the run matches (the clash resolver relies on this, #4215). */
export interface EvaluatorModel {
  id: string;
  filterIdentity?: string;
  tagIds?: ReadonlySet<string>;
  store: IfcDataStore | null; mutationView?: MutablePropertyView; // #4946
}

export async function evaluateFilterRulesFederated(
  models: ReadonlyArray<EvaluatorModel>,
  rules: readonly FilterRule[],
  combinator: Combinator,
  options: FederatedEvaluateOptions = {},
): Promise<FilteredElement[]> {
  if (rules.length === 0) return [];

  const limit = options.limit ?? DEFAULT_LIMIT;
  const chunkSize = options.chunkSize ?? DEFAULT_CHUNK_SIZE;
  const signal = options.signal;
  const orderedRules = orderRulesByCost(rules);
  const out: FilteredElement[] = [];

  // Pre-compute per-model iteration plans + a global total so the
  // progress callback can render a single bar across the federation.
  const definedModelTagIds = options.definedModelTagIds ?? NO_MODEL_TAGS;
  interface Plan {
    modelId: string;
    scope: ModelScope;
    store: IfcDataStore; mutationView: MutablePropertyView | undefined; // #4946
    iter: ArrayLike<number> | Iterable<number>;
    total: number;
  }
  const plans: Plan[] = [];
  let grandTotal = 0;
  let totalKnown = true;
  for (const m of models) {
    if (!m.store) continue;
    const scope: ModelScope = { filterIdentity: m.filterIdentity ?? m.id, tagIds: m.tagIds, definedModelTagIds };
    // Whole-model prune, AND only: under OR a model failing its model-scoped
    // rules still contributes entities the other rules admit (#4215).
    if (combinator === 'AND' && modelPrunedUnderAnd(orderedRules, scope)) continue;
    const candidates = options.candidateExpressIdsByModel?.get(m.id);
    const source = candidates ?? selectIterationSource(m.store, rules, combinator, undefined, m.id, m.mutationView);
    const arr = materialiseNumericIterable(source);
    if (arr === null) {
      totalKnown = false;
    } else {
      grandTotal += arr.length;
    }
    plans.push({
      modelId: m.id,
      scope,
      store: m.store, mutationView: m.mutationView,
      iter: arr ?? source,
      total: arr ? arr.length : -1,
    });
  }

  let scanned = 0;
  options.onProgress?.(0, totalKnown ? grandTotal : -1);

  for (const plan of plans) {
    if (out.length >= limit) break;
    if (signal?.aborted) throwAbort(signal);

    const ctx: EvalContext = {
      store: plan.store,
      modelId: plan.modelId,
      scope: plan.scope, mutationView: plan.mutationView,
      table: plan.store.entities,
      options,
      hasPropertyRule: orderedRules.some((r) => r.kind === 'property'),
      hasQuantityRule: orderedRules.some((r) => r.kind === 'quantity'),
      hasMaterialRule: orderedRules.some((r) => r.kind === 'material'),
      hasClassificationRule: orderedRules.some((r) => r.kind === 'classification'),
      hasAttributeRule: orderedRules.some((r) => r.kind === 'attribute'),
      typePsetCache: new Map(),
    };

    // Walk the per-model iter in chunkSize-sized strides, yielding the
    // event loop between chunks. ArrayLike fast-path uses index access;
    // the fallback path drains an iterator into chunks.
    if (Array.isArray(plan.iter) || isNumericArrayLike(plan.iter)) {
      const arr = plan.iter as ArrayLike<number>;
      for (let i = 0; i < arr.length && out.length < limit; i += chunkSize) {
        if (signal?.aborted) throwAbort(signal);
        const end = Math.min(i + chunkSize, arr.length);
        for (let j = i; j < end; j++) {
          const expressId = arr[j];
          if (!expressId) continue;
          const fields = evaluateOneEntity(ctx, expressId, orderedRules, combinator);
          if (!fields) continue;
          out.push(buildFilterResult(plan.modelId, expressId, fields));
          if (out.length >= limit) break;
        }
        scanned += end - i;
        options.onProgress?.(scanned, totalKnown ? grandTotal : -1);
        if (end < arr.length && out.length < limit) await yieldToEventLoop();
      }
    } else {
      let buffered = 0;
      for (const expressId of plan.iter as Iterable<number>) {
        if (out.length >= limit) break;
        if (!expressId) continue;
        const fields = evaluateOneEntity(ctx, expressId, orderedRules, combinator);
        if (fields) {
          out.push(buildFilterResult(plan.modelId, expressId, fields));
        }
        buffered++;
        scanned++;
        if (buffered >= chunkSize) {
          buffered = 0;
          if (signal?.aborted) throwAbort(signal);
          options.onProgress?.(scanned, totalKnown ? grandTotal : -1);
          await yieldToEventLoop();
        }
      }
      // Final progress tick for the residual.
      options.onProgress?.(scanned, totalKnown ? grandTotal : -1);
    }
  }

  return out;
}

// ── Per-entity inner loop ────────────────────────────────────────────────────

/** Type-level pset rows in the same shape `extractPropertiesOnDemand` /
 *  `extractTypePropertiesOnDemand` return — what `flattenPsets` /
 *  `mergeInheritedPropertySets` expect. */
type TypePsetList = ReturnType<typeof extractPropertiesOnDemand>;

interface EvalContext {
  store: IfcDataStore;
  /** Scopes a `StoreyRule.refs` exact match to this store's own model. */
  modelId: string;
  /** What the model-scoped rules (`model`, `modelTag`) read. */
  scope: ModelScope; mutationView?: MutablePropertyView; // #4946
  table: IfcDataStore['entities'];
  options: EvaluateOptions;
  hasPropertyRule: boolean;
  hasQuantityRule: boolean;
  hasMaterialRule: boolean;
  hasClassificationRule: boolean;
  hasAttributeRule: boolean;
  /** Per-TYPE pset cache, keyed by the type's expressId and shared across
   *  every entity evaluated against this store (one `EvalContext` per
   *  model/plan). Many instances share one `IfcWallType` etc., so this
   *  turns what would be N source-buffer parses (one per instance) into
   *  one parse per distinct type — see the AGENTS.md §2 large-loop
   *  warning this module already guards against for instance psets. */
  typePsetCache: Map<number, TypePsetList>;
}

function evaluateOneEntity(
  ctx: EvalContext,
  expressId: number,
  orderedRules: readonly FilterRule[],
  combinator: Combinator,
): EffectiveFilterFields | null {
  if (ctx.mutationView?.isDeleted(expressId)) return null;
  const fields = effectiveFilterFields(ctx.store, ctx.mutationView, expressId);
  // Lazy pset/qto reads — only invoked when an ordered rule for that
  // family actually needs the data. Cheap-first ordering means cheap
  // rules check first; AND short-circuit on a cheap miss skips the
  // parse entirely.
  let psetCache: PsetRows | null = null;
  let qtyCache: QtyRows | null = null;
  let matCache: string[] | null = null;
  let classCache: readonly ClassificationInfo[] | null = null;
  let attrCache: AttrRows | null = null;
  const psetsFor = (): PsetRows => {
    if (!psetCache) {
      const ownSets = ownPropertySetsFor(ctx.store, expressId, ctx.mutationView); // #4946, mutation-aware
      const typeSets = getInheritedTypePsets(ctx, expressId);
      // IFC inheritance is per-PROPERTY, not per-set, and the occurrence's
      // own value wins on a name collision — same rule the IDS bridge
      // already applies (`mergeInheritedPropertySets`, packages/parser).
      // A type-only pset (nothing on the instance) is appended as-is, so
      // `isSet`/`isNotSet` now also see properties that exist ONLY on the
      // type — a deliberate presence-semantics change (was instance-only).
      psetCache = flattenPsets(mergeInheritedPropertySets(ownSets, typeSets));
    }
    return psetCache;
  };
  const qtysFor = (): QtyRows => {
    if (!qtyCache) qtyCache = flattenQtys(quantitySetsFor(ctx.store, expressId, ctx.mutationView));
    return qtyCache;
  };
  const matNamesFor = (): string[] => {
    if (!matCache) {
      // Union across ALL associations so a material rule matches an element
      // whose second IfcRelAssociatesMaterial carries the queried name.
      const seen = new Set<string>();
      for (const info of extractAllMaterialsOnDemand(ctx.store, expressId)) {
        for (const n of materialMatchCandidates(info)) seen.add(n);
      }
      matCache = [...seen];
    }
    return matCache;
  };
  const classFor = (): readonly ClassificationInfo[] => {
    if (!classCache) classCache = extractClassificationsOnDemand(ctx.store, expressId);
    return classCache;
  };
  const attrsFor = (): AttrRows => {
    if (!attrCache) attrCache = attributesFor(ctx.store, expressId, ctx.mutationView);
    return attrCache;
  };

  const ruleResults: boolean[] = [];
  for (const rule of orderedRules) {
    const result = evaluateRule(
      rule,
      ctx,
      expressId,
      ctx.hasPropertyRule ? psetsFor : null,
      ctx.hasQuantityRule ? qtysFor : null,
      ctx.hasMaterialRule ? matNamesFor : null,
      ctx.hasClassificationRule ? classFor : null,
      ctx.hasAttributeRule ? attrsFor : null,
      fields,
    );
    ruleResults.push(result);
    if (combinator === 'AND' && !result) return null;
    if (combinator === 'OR' && result) return fields;
  }
  return combineRuleResults(combinator, ruleResults) ? fields : null;
}

/**
 * Resolve `expressId`'s TYPE-level property sets (e.g. `IfcWallType`'s
 * `Pset_WallCommon`) via `IfcRelDefinesByType`, caching the parse per
 * TYPE (`ctx.typePsetCache`) rather than per instance. Many occurrences
 * share one type, so this is O(distinct types) source-buffer parses per
 * filter run, not O(entities) — see the AGENTS.md §2 warning this module
 * already guards for instance psets.
 *
 * Mirrors `packages/ids/src/bridge/properties.ts`'s `inheritedPropertySets`
 * / `typePropertySetsFromTable` split: `extractTypePropertiesOnDemand` only
 * resolves from the source buffer, so on a server-parsed store (no
 * `source`, e.g. after collab/session load) it always returns null — the
 * type's psets there are keyed under the type's own expressId in the
 * pre-built `PropertyTable` (`store.properties.getForEntity(typeId)`,
 * issue #1787's server-path fallback).
 */
function getInheritedTypePsets(ctx: EvalContext, expressId: number): TypePsetList {
  if (!ctx.store.relationships) return [];
  const typeIds = ctx.store.relationships.getRelated(expressId, RelationshipType.DefinesByType, 'inverse');
  if (typeIds.length === 0) return [];
  const typeId = typeIds[0];

  // Only the BASE read is cached per type (review finding: `mutationView` is
  // live/mutable, edited possibly mid-run between chunk yields — caching the
  // mutation-APPLIED result by typeId would keep answering pre-edit psets).
  // The overlay is cheap and applied fresh on every call.
  let base = ctx.typePsetCache.get(typeId);
  if (base === undefined) {
    base = ctx.store.source && ctx.store.source.length > 0
      ? extractTypePropertiesOnDemand(ctx.store, expressId)?.properties ?? []
      : (ctx.store.properties?.getForEntity?.(typeId) ?? []) as unknown as TypePsetList;
    ctx.typePsetCache.set(typeId, base);
  }
  return typePropertySetsFor(base, typeId, ctx.mutationView); // #4946, mutation-aware
}

function evaluateRule(
  rule: FilterRule,
  ctx: EvalContext,
  expressId: number,
  psetsFor: (() => PsetRows) | null,
  qtysFor: (() => QtyRows) | null,
  matNamesFor: (() => string[]) | null,
  classFor: (() => readonly ClassificationInfo[]) | null,
  attrsFor: (() => AttrRows) | null,
  fields: EffectiveFilterFields,
): boolean {
  if (isModelScopedRule(rule)) return modelScopedRuleMatches(rule, ctx.scope);
  switch (rule.kind) {
    case 'storey': {
      // Exact-identity mode (refs present): Name isn't unique.
      if (rule.refs) {
        const isMatch = storeyMatchesRefs(ctx.store, expressId, ctx.modelId, rule);
        return rule.op === 'in' ? isMatch : !isMatch;
      }
      const storeyName = ctx.options.storeyNameOf?.(expressId)
        ?? defaultStoreyName(ctx.store, expressId);
      return setOpMatches(rule.op, storeyName, rule.values);
    }
    case 'ifcType':
      return setOpMatches(rule.op, fields.ifcType, rule.values);
    case 'predefinedType': {
      // No columnar accessor - resolve from the source buffer, per-store (#1462). A live edit (#4946) wins.
      const pt = mutatedAttributeValue(ctx.mutationView, expressId, 'PredefinedType')
        ?? ctx.options.predefinedTypeOf?.(expressId)
        ?? resolveEntityPredefinedType(ctx.store, expressId)
        ?? '';
      return setOpMatches(rule.op, pt, rule.values);
    }
    case 'name': {
      // getNameOrUndefined: absent must reach as undefined, not '' (#4930). A live edit (#4946) wins.
      return stringOpMatches(rule.op, fields.name, rule.value, rule.valueKind);
    }
    case 'globalId':
      return globalIdOpMatches(rule.op, fields.globalId, rule.values);
    case 'attribute': {
      if (!attrsFor) return false;
      return matchAttributeRule(rule, attrsFor());
    }
    case 'property': {
      if (!psetsFor) return false;
      return matchPropertyRule(rule, psetsFor());
    }
    case 'quantity': {
      if (!qtysFor) return false;
      return matchQuantityRule(rule, qtysFor());
    }
    case 'material': {
      if (!matNamesFor) return false;
      return matchStringAnyNone(rule.op, matNamesFor(), rule.value, rule.valueKind);
    }
    case 'classification': {
      if (!classFor) return false;
      return matchClassificationRule(rule, classFor());
    }
    case 'elevation': {
      const elev = elevationOf(ctx.store, expressId);
      if (elev === null) return false;
      return numericOpMatches(rule.op, elev, rule.value);
    }
    case 'type': {
      const typeName = relatingTypeNameOf(ctx, expressId);
      if (typeName === null) return false;
      return stringOpMatches(rule.op, typeName, rule.value, rule.valueKind);
    }
    case 'parent': return matchParentRule(rule, ctx.store, expressId);
    case 'group': return matchGroupRule(rule, ctx.store, expressId);
  }
}

/**
 * The Name of `expressId`'s RELATING TYPE via `IfcRelDefinesByType` (#4094).
 * `null` = no such relation (must never match). `undefined` = the related
 * `IfcTypeObject` has no Name (#4930) — distinct from an empty one.
 */
function relatingTypeNameOf(ctx: EvalContext, expressId: number): string | undefined | null {
  if (!ctx.store.relationships) return null;
  const typeIds = ctx.store.relationships.getRelated(expressId, RelationshipType.DefinesByType, 'inverse');
  if (typeIds.length === 0) return null;
  return ctx.table.getNameOrUndefined(typeIds[0]);
}

// ── Exposed for tests ────────────────────────────────────────────────────────

export const __internal = {
  flattenPsets,
  flattenQtys,
  stringifyValue,
  matchPropertyRule,
  matchQuantityRule,
  matchAttributeRule,
  materialNamesOf,
  matchClassificationRule,
  elevationOf,
  orderRulesByCost,
  selectIterationSource,
};
