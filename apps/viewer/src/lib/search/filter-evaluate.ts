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
  const iterIds = toIterable(
    selectIterationSource(store, rules, combinator, options.candidateExpressIds),
  );
  const out: FilteredElement[] = [];
  const ctx: EvalContext = {
    store,
    table: store.entities,
    options,
    hasPropertyRule: orderedRules.some((r) => r.kind === 'property'),
    hasQuantityRule: orderedRules.some((r) => r.kind === 'quantity'),
  };

  for (const expressId of iterIds) {
    if (out.length >= limit) break;
    // Skip empty rows from the raw expressId column. ArrayLike sources
    // (the full-table fast-path) include zero-padded slots; bucket
    // sources (byType / byStorey) never do, so this is a no-op there.
    if (!expressId) continue;
    if (!evaluateOneEntity(ctx, expressId, orderedRules, combinator)) continue;
    out.push(buildResult(modelId, ctx, expressId));
  }
  return out;
}

/** Coerce ArrayLike-or-Iterable into an Iterable so the sync entry can
 *  use `for…of`. The federated entry takes the array fast-path
 *  separately. */
function toIterable(source: ArrayLike<number> | Iterable<number>): Iterable<number> {
  if (Symbol.iterator in Object(source)) return source as Iterable<number>;
  // ArrayLike fallback — wrap as a generator so the for…of loop works.
  return (function* () {
    const arr = source as ArrayLike<number>;
    for (let i = 0; i < arr.length; i++) yield arr[i];
  })();
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

export interface FederatedEvaluateResult {
  /**
   * Concatenated matches (model order preserved, per-model the
   * iteration order — bucket array index when prefilter applied,
   * expressId column index otherwise). Callers that need score-or-name
   * ordering should sort; we don't pre-sort because the output drives
   * a user-visible result table where filtering predicates, not
   * relevance ranking, decide membership.
   */
  matches: FilteredElement[];
  /**
   * True when the evaluator stopped early because the result count hit
   * the configured `limit` while there were unscanned entities. False
   * when the entire iteration source completed (even if `matches.length`
   * happens to equal `limit` exactly — the cap was met without
   * truncation, so the caller should NOT show a "limited" badge).
   */
  truncated: boolean;
  /** Total entities scanned across all models. */
  scanned: number;
}

/**
 * Evaluate `rules` across multiple federated models. Async chunked +
 * cancellable + progress-reporting. Returns the matches plus an
 * explicit `truncated` flag so callers can distinguish "exact cap hit"
 * from "stopped mid-scan".
 */
export async function evaluateFilterRulesFederated(
  models: ReadonlyArray<{ id: string; store: IfcDataStore | null }>,
  rules: readonly FilterRule[],
  combinator: Combinator,
  options: FederatedEvaluateOptions = {},
): Promise<FederatedEvaluateResult> {
  if (rules.length === 0) return { matches: [], truncated: false, scanned: 0 };

  const limit = options.limit ?? DEFAULT_LIMIT;
  const chunkSize = options.chunkSize ?? DEFAULT_CHUNK_SIZE;
  const signal = options.signal;
  const orderedRules = orderRulesByCost(rules);
  const out: FilteredElement[] = [];

  // Pre-compute per-model iteration plans + a global total so the
  // progress callback can render a single bar across the federation.
  interface Plan {
    modelId: string;
    store: IfcDataStore;
    iter: ArrayLike<number> | Iterable<number>;
    total: number;
  }
  const plans: Plan[] = [];
  let grandTotal = 0;
  let totalKnown = true;
  for (const m of models) {
    if (!m.store) continue;
    const candidates = options.candidateExpressIdsByModel?.get(m.id);
    const source = candidates ?? selectIterationSource(m.store, rules, combinator, undefined);
    const arr = materialiseIterable(source);
    if (arr === null) {
      totalKnown = false;
    } else {
      grandTotal += arr.length;
    }
    plans.push({ modelId: m.id, store: m.store, iter: arr ?? source, total: arr ? arr.length : -1 });
  }

  let scanned = 0;
  options.onProgress?.(0, totalKnown ? grandTotal : -1);

  for (const plan of plans) {
    if (out.length >= limit) break;
    if (signal?.aborted) throwAbort(signal);

    const ctx: EvalContext = {
      store: plan.store,
      table: plan.store.entities,
      options,
      hasPropertyRule: orderedRules.some((r) => r.kind === 'property'),
      hasQuantityRule: orderedRules.some((r) => r.kind === 'quantity'),
    };

    // Walk the per-model iter in chunkSize-sized strides, yielding the
    // event loop between chunks. ArrayLike fast-path uses index access;
    // the fallback path drains an iterator into chunks.
    if (Array.isArray(plan.iter) || isArrayLike(plan.iter)) {
      const arr = plan.iter as ArrayLike<number>;
      for (let i = 0; i < arr.length && out.length < limit; i += chunkSize) {
        if (signal?.aborted) throwAbort(signal);
        const end = Math.min(i + chunkSize, arr.length);
        let processedInChunk = 0;
        for (let j = i; j < end; j++) {
          processedInChunk++;
          const expressId = arr[j];
          if (!expressId) continue;
          if (!evaluateOneEntity(ctx, expressId, orderedRules, combinator)) continue;
          out.push(buildResult(plan.modelId, ctx, expressId));
          if (out.length >= limit) break;
        }
        // Count only entities actually visited — without this, a break
        // on `limit` mid-chunk would still credit the WHOLE chunk to
        // `scanned`, hiding truncation (`scanned === grandTotal` while
        // unscanned entries remain).
        scanned += processedInChunk;
        options.onProgress?.(scanned, totalKnown ? grandTotal : -1);
        if (end < arr.length && out.length < limit) await yieldToEventLoop();
      }
    } else {
      let buffered = 0;
      for (const expressId of plan.iter as Iterable<number>) {
        if (out.length >= limit) break;
        if (!expressId) continue;
        if (evaluateOneEntity(ctx, expressId, orderedRules, combinator)) {
          out.push(buildResult(plan.modelId, ctx, expressId));
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

  // Truncation is "we stopped because we hit the cap AND there was
  // still work to do." Reaching `limit` exactly when the iteration
  // also completes naturally is NOT truncation — every match was
  // emitted, the cap just happened to coincide. The signal drives the
  // UI's "limited to N" badge.
  const truncated = totalKnown ? out.length >= limit && scanned < grandTotal : out.length >= limit;
  return { matches: out, truncated, scanned };
}

// ── Iteration source: index prefilter (AND + op:in) ──────────────────────────

/**
 * Decide which expressIds the evaluator walks. Public for testability —
 * consumers should only depend on the results returned, not on the
 * iteration count, but a benchmark / regression test may want to assert
 * the prefilter actually narrows.
 */
export function selectIterationSource(
  store: IfcDataStore,
  rules: readonly FilterRule[],
  combinator: Combinator,
  candidateExpressIds: Iterable<number> | undefined,
): ArrayLike<number> | Iterable<number> {
  // Caller-supplied narrowing wins (Tier-1 candidates).
  if (candidateExpressIds !== undefined) return candidateExpressIds;

  // Prefilter only applies under AND. OR rules are unioned; you can't
  // shrink the candidate set from a single OR clause without losing
  // results from the other clauses.
  if (combinator !== 'AND') return iterateAllExpressIds(store);

  // Try to find the smallest narrowing source. Multiple op:in rules in
  // the same query can each suggest a candidate bucket; we pick the
  // smallest one (the per-entity loop re-checks every rule, so any one
  // valid bucket is correctness-safe — fewer rows = less work).
  let best: number[] | null = null;

  for (const rule of rules) {
    if (rule.kind === 'ifcType' && rule.op === 'in' && rule.values.length > 0) {
      const bucket = unionByType(store, rule.values);
      if (bucket && (best === null || bucket.length < best.length)) best = bucket;
    } else if (rule.kind === 'storey' && rule.op === 'in' && rule.values.length > 0) {
      const bucket = unionByStorey(store, rule.values);
      if (bucket && (best === null || bucket.length < best.length)) best = bucket;
    }
  }

  return best ?? iterateAllExpressIds(store);
}

function unionByType(store: IfcDataStore, names: readonly string[]): number[] | null {
  const byType = store.entityIndex.byType;
  if (!byType || byType.size === 0) return null;
  // STEP type names are stored UPPERCASE; rule values arrive in canonical
  // PascalCase ("IfcWall") so we uppercase here at the boundary.
  const out: number[] = [];
  for (const name of names) {
    const bucket = byType.get(name.toUpperCase());
    if (bucket) for (const id of bucket) out.push(id);
  }
  return out.length > 0 ? out : null;
}

function unionByStorey(store: IfcDataStore, storeyNames: readonly string[]): number[] | null {
  const hierarchy = store.spatialHierarchy;
  if (!hierarchy) return null;
  const wanted = new Set(storeyNames.map((n) => n.toLowerCase()));
  const out: number[] = [];
  // byStorey keys are storey expressIds; their name comes from the
  // entity table. Models rarely have more than ~20 storeys, so this
  // pass is essentially free.
  for (const storeyId of hierarchy.byStorey.keys()) {
    const name = store.entities.getName(storeyId);
    if (!wanted.has(name.toLowerCase())) continue;
    const elements = hierarchy.byStorey.get(storeyId);
    if (elements) for (const id of elements) out.push(id);
  }
  return out.length > 0 ? out : null;
}

// ── Cheap-first rule ordering ────────────────────────────────────────────────

/**
 * AGENTS.md §2: never call `extractPropertiesOnDemand` in a large loop.
 * We can't avoid it entirely for `property`/`quantity` rules, but we can
 * make sure cheap rules check first so AND/OR short-circuit skips the
 * expensive parse for entities that already fail/pass.
 */
const RULE_COST: Record<FilterRule['kind'], number> = {
  // Column-only — single TypedArray read.
  ifcType:        0,
  // Pre-built reverse-map lookup.
  storey:         1,
  // String-table indirection.
  name:           2,
  predefinedType: 2,
  // Source-buffer parse (the AGENTS.md §2 hot path).
  property:       10,
  quantity:       10,
};

export function orderRulesByCost(rules: readonly FilterRule[]): FilterRule[] {
  // Stable sort — equal-cost rules retain their authored order so the
  // user's intent is visible in debug logs / SQL preview.
  return rules
    .map((r, i) => ({ r, i, cost: RULE_COST[r.kind] }))
    .sort((a, b) => a.cost - b.cost || a.i - b.i)
    .map((x) => x.r);
}

// ── Per-entity inner loop ────────────────────────────────────────────────────

interface EvalContext {
  store: IfcDataStore;
  table: IfcDataStore['entities'];
  options: EvaluateOptions;
  hasPropertyRule: boolean;
  hasQuantityRule: boolean;
}

function evaluateOneEntity(
  ctx: EvalContext,
  expressId: number,
  orderedRules: readonly FilterRule[],
  combinator: Combinator,
): boolean {
  // Lazy pset/qto reads — only invoked when an ordered rule for that
  // family actually needs the data. Cheap-first ordering means cheap
  // rules check first; AND short-circuit on a cheap miss skips the
  // parse entirely.
  let psetCache: PsetRows | null = null;
  let qtyCache: QtyRows | null = null;
  const psetsFor = (): PsetRows => {
    if (!psetCache) psetCache = flattenPsets(extractPropertiesOnDemand(ctx.store, expressId));
    return psetCache;
  };
  const qtysFor = (): QtyRows => {
    if (!qtyCache) qtyCache = flattenQtys(extractQuantitiesOnDemand(ctx.store, expressId));
    return qtyCache;
  };

  const ruleResults: boolean[] = [];
  for (const rule of orderedRules) {
    const result = evaluateRule(
      rule,
      ctx,
      expressId,
      ctx.hasPropertyRule ? psetsFor : null,
      ctx.hasQuantityRule ? qtysFor : null,
    );
    ruleResults.push(result);
    if (combinator === 'AND' && !result) return false;
    if (combinator === 'OR' && result) return true;
  }
  return combineRuleResults(combinator, ruleResults);
}

function evaluateRule(
  rule: FilterRule,
  ctx: EvalContext,
  expressId: number,
  psetsFor: (() => PsetRows) | null,
  qtysFor: (() => QtyRows) | null,
): boolean {
  switch (rule.kind) {
    case 'storey': {
      const storeyName = ctx.options.storeyNameOf?.(expressId)
        ?? defaultStoreyName(ctx.store, expressId);
      return setOpMatches(rule.op, storeyName, rule.values);
    }
    case 'ifcType': {
      return setOpMatches(rule.op, ctx.table.getTypeName(expressId), rule.values);
    }
    case 'predefinedType': {
      const pt = ctx.options.predefinedTypeOf?.(expressId) ?? '';
      return setOpMatches(rule.op, pt, rule.values);
    }
    case 'name': {
      return stringOpMatches(rule.op, ctx.table.getName(expressId), rule.value);
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

function buildResult(modelId: string, ctx: EvalContext, expressId: number): FilteredElement {
  return {
    modelId,
    expressId,
    ifcType: ctx.table.getTypeName(expressId),
    name: ctx.table.getName(expressId),
    globalId: ctx.table.getGlobalId(expressId),
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Return the raw expressId column as the iteration source. The
 *  per-entity loops already skip empty rows (`if (!expressId) continue`)
 *  so the typed-array shape is correctness-safe AND lets the federated
 *  entry report a `total` rather than streaming with `total = -1`. */
function iterateAllExpressIds(store: IfcDataStore): ArrayLike<number> {
  return store.entities.expressId;
}

function isArrayLike(value: unknown): value is ArrayLike<number> {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { length?: unknown }).length === 'number'
  );
}

/** Try to materialise an iterable into an array so the federated loop
 *  can chunk-iterate by index (faster + provides a `total` for progress).
 *  Returns null when the source is unknown-size and we'd rather stream. */
function materialiseIterable(
  source: ArrayLike<number> | Iterable<number>,
): ArrayLike<number> | null {
  if (Array.isArray(source)) return source;
  if (isArrayLike(source)) return source;
  if (source instanceof Set) return Array.from(source);
  // Generators / unknown-size iterables: keep streaming. The federated
  // loop falls back to the iterator branch with a buffered chunk count.
  return null;
}

function throwAbort(signal: AbortSignal): never {
  // Match the shape DOM throws on AbortController.signal.aborted reads —
  // callers can `instanceof DOMException && err.name === 'AbortError'`.
  throw new DOMException(
    signal.reason instanceof Error ? signal.reason.message : 'evaluateFilterRules aborted',
    'AbortError',
  );
}

/** Yield control to the event loop. Mirrors `tier1-index.ts` so we
 *  don't pin the Node test runner — `scheduler.yield` (browsers /
 *  Node 22+) and `setImmediate` (Node fallback) are preferred over
 *  the MessageChannel trick because the latter requires explicit
 *  port closure to release the loop reference. */
function yieldToEventLoop(): Promise<void> {
  const maybeScheduler = (globalThis as typeof globalThis & {
    scheduler?: { yield?: () => Promise<void> };
  }).scheduler;
  if (typeof maybeScheduler?.yield === 'function') return maybeScheduler.yield();
  if (typeof setImmediate === 'function') {
    return new Promise<void>((resolve) => { setImmediate(() => resolve()); });
  }
  return new Promise<void>((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
      channel.port1.close();
      channel.port2.close();
      resolve();
    };
    channel.port2.postMessage(null);
  });
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
  orderRulesByCost,
  selectIterationSource,
};
