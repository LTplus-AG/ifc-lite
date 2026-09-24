/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Set-level requirement checking (#5138 PR 3) — `unique` (plan §4.5) and
 * `aggregate` (§4.6). Unlike `element` (per-entity, `rule-engine-
 * requirements.ts`), these produce `SetResult`s describing a GROUP of
 * entities. `compare` (§4.7) is per-entity like `element`, not a set kind —
 * it lives in `rule-engine-compare.ts` (split out once this file crossed the
 * module-size budget), reusing `describeSubject`/`baseRow` from here.
 */

import type { IfcDataStore } from '@ifc-lite/parser';
import type { EntityResult, FailureReasonCode, RequirementResult, SetResult } from '@ifc-lite/ids';
import { collectSpatialAncestors } from '@ifc-lite/data';
import { numericOpMatches } from '../filter/filter-ops.js';
import { evaluateFilterGroupsFederated } from '../filter/filter-evaluate-groups.js';
import type { FilteredElement, EvaluatorModel } from '../filter/filter-evaluate.js';
import { readSubject } from '../filter/read-subject.js';
import type { Subject, UniqueRequirement, AggregateRequirement } from '../rule-set/rule-set.js';
import { OP_LABEL, type ValidationOpts } from './rule-engine-requirements.js';
import { maybeYieldChunk, finalProgress, type RuleEngineProgress } from './rule-engine-chunk.js';

const SET_RESULT_CAP = 1_000;

/** Shared with `rule-engine-compare.ts` (same `Subject` label rendering). */
export function describeSubject(subject: Subject): string {
  switch (subject.kind) {
    case 'property': return `${subject.setName}.${subject.propertyName}`;
    case 'quantity': return `${subject.setName}.${subject.quantityName}`;
    case 'attribute': return subject.name;
    case 'classification': return subject.system ? `Classification[${subject.system}]` : 'Classification';
    case 'group': return subject.groupClass ? `Group[${subject.groupClass}]` : 'Group';
    case 'modelFact': return `model.${subject.fact}`;
    default: return subject.kind;
  }
}

/**
 * Fold a raw subject value into a bucket/group key. `globalId` is NEVER
 * case-folded, `caseSensitive` or not — review finding: same rule
 * `filter-ops.ts`'s `globalIdOpMatches` already applies (a GlobalId is a
 * 22-char base64 GUID where case IS the identity; folding it would merge
 * two genuinely different elements' ids, e.g. `abc`/`ABC`, into one
 * "duplicate").
 */
function foldKey(value: string, subjectKind: Subject['kind'], caseSensitive: boolean): string {
  if (subjectKind === 'globalId') return value;
  return caseSensitive ? value : value.toLowerCase();
}

/** Shared with `rule-engine-compare.ts`. */
export function baseRow(el: FilteredElement, passed: boolean, result: RequirementResult): EntityResult {
  return {
    expressId: el.expressId,
    modelId: el.modelId,
    entityType: el.ifcType,
    entityName: el.name || undefined,
    globalId: el.globalId,
    passed,
    requirementResults: [result],
  };
}

// ── unique (plan §4.5) ──────────────────────────────────────────────────────

/** The shape every requirement-kind checker returns, folded by
 *  `rule-engine.ts`'s `finalizeSpecification`. `setResults`/
 *  `setResultsTruncated` are optional — `element`/`compare` never populate
 *  them (they are per-entity kinds, not set kinds). */
export interface SetCheckOutcome {
  entityResults: EntityResult[];
  setResults?: SetResult[];
  setResultsTruncated?: boolean;
  /**
   * `aggregate` only (#5177): the number of DISTINCT applicable elements that
   * fail the rule, i.e. every element excluded for an absent/non-numeric
   * subject plus every member of a group whose aggregate fails — the same
   * attribution `checkUnique` makes by giving every duplicate member a
   * failing row. `checkAggregate` does not emit a row per failing-group
   * member (a whole federation's worth of rows for no reporting value), so
   * `entityResults` alone under-counts; this is the count it would have had.
   * Taken on the full, pre-cap `setResults`, so it stays exact when
   * `setResultsTruncated` is true.
   */
  failedElementCount?: number;
}

export async function checkUnique(
  requirementId: string,
  requirement: UniqueRequirement,
  applicable: readonly FilteredElement[],
  storesById: ReadonlyMap<string, IfcDataStore>,
  opts: ValidationOpts,
  ruleIndex: number,
  signal: AbortSignal | undefined,
  onProgress: ((p: RuleEngineProgress) => void) | undefined,
): Promise<SetCheckOutcome> {
  const label = `unique(${describeSubject(requirement.subject)})`;
  const perModel = requirement.scope === 'perModel';
  const entityResults: EntityResult[] = [];
  // scope key ('' for federation, else modelId) -> folded value -> members.
  const buckets = new Map<string, Map<string, { el: FilteredElement; value: string }[]>>();

  for (let i = 0; i < applicable.length; i++) {
    const el = applicable[i];
    const store = storesById.get(el.modelId);
    if (store) {
      const subject = readSubject(requirement.subject, { store, expressId: el.expressId });
      if (!subject.present) {
        entityResults.push(baseRow(el, false, {
          requirement: { id: requirementId, label, optionality: 'required' },
          status: 'fail', facetType: 'unique', checkedDescription: label,
          failureReason: 'absent', actualValue: '""', expectedValue: 'unique',
        }));
      } else {
        const scopeKey = perModel ? el.modelId : '';
        let scoped = buckets.get(scopeKey);
        if (!scoped) buckets.set(scopeKey, (scoped = new Map()));
        for (const raw of subject.values) {
          const s = String(raw);
          if (s.trim().length === 0) continue;
          const key = foldKey(s, requirement.subject.kind, opts.caseSensitive);
          let bucket = scoped.get(key);
          if (!bucket) scoped.set(key, (bucket = []));
          bucket.push({ el, value: s });
        }
      }
    }
    await maybeYieldChunk(i + 1, applicable.length, ruleIndex, signal, onProgress);
  }
  finalProgress(applicable.length, ruleIndex, signal, onProgress);

  const dupGroups: { value: string; members: { el: FilteredElement; value: string }[] }[] = [];
  for (const scoped of buckets.values()) {
    for (const members of scoped.values()) {
      if (members.length > 1) dupGroups.push({ value: members[0].value, members });
    }
  }
  dupGroups.sort((a, b) => b.members.length - a.members.length);

  for (const g of dupGroups) {
    const actual = `${g.value} (${g.members.length}×)`;
    for (const m of g.members) {
      entityResults.push(baseRow(m.el, false, {
        requirement: { id: requirementId, label, optionality: 'required' },
        status: 'fail', facetType: 'unique', checkedDescription: label,
        failureReason: 'duplicate', actualValue: actual, expectedValue: 'unique',
      }));
    }
  }

  const setResultsTruncated = dupGroups.length > SET_RESULT_CAP;
  const setResults: SetResult[] = dupGroups.slice(0, SET_RESULT_CAP).map((g) => ({
    kind: 'duplicate',
    label: g.value,
    actual: `${g.value} (${g.members.length}×)`,
    expected: 'unique',
    passed: false,
    failureReason: 'duplicate',
    members: g.members.map((m) => ({ modelId: m.el.modelId, expressId: m.el.expressId })),
  }));

  return { setResults, setResultsTruncated, entityResults };
}

// ── aggregate (plan §4.6) ────────────────────────────────────────────────────

interface Accumulator {
  count: number;
  sum: number;
  min: number;
  max: number;
  units: Set<string>;
  skipped: number;
  keyLabel: string;
  members: { modelId: string; expressId: number }[];
}

function newAccumulator(keyLabel: string): Accumulator {
  return { count: 0, sum: 0, min: Infinity, max: -Infinity, units: new Set(), skipped: 0, keyLabel, members: [] };
}

/** The DIRECT (nearest) spatial parent — `collectSpatialAncestors`'s BFS
 *  walk yields nearest-first, so its first entry is exactly that; plan
 *  §4.6 asks for the direct parent's identity, not the whole ancestor
 *  chain `parent=` (search) matches against. */
function directParentOf(store: IfcDataStore, expressId: number): number | undefined {
  if (!store.relationships) return undefined;
  return collectSpatialAncestors(store.relationships, expressId)[0];
}

/**
 * Every group key `el` contributes to — plural, per plan §3: "an element
 * contributes to every key it carries", so a multi-valued `groupBy` subject
 * (`material`, `classification`) lands the same element in EVERY matching
 * group, not just its first value. `parent` stays single-valued (an element
 * has exactly one direct spatial parent); everything else de-dupes an
 * element's own repeated values so one element can't double-count itself
 * into the SAME group twice.
 */
function groupKeysOf(
  requirement: AggregateRequirement,
  el: FilteredElement,
  store: IfcDataStore,
  caseSensitive: boolean,
): { key: string; label: string }[] {
  if (!requirement.groupBy) return [{ key: '*', label: '' }];
  if (requirement.groupBy.subject.kind === 'parent') {
    const parentId = directParentOf(store, el.expressId);
    if (parentId === undefined) return [];
    return [{ key: `${el.modelId}:${parentId}`, label: store.entities.getName(parentId) }];
  }
  const subject = readSubject(requirement.groupBy.subject, { store, expressId: el.expressId });
  if (!subject.present) return [];
  const out: { key: string; label: string }[] = [];
  const seen = new Set<string>();
  for (const raw of subject.values) {
    const s = String(raw);
    if (s.trim().length === 0) continue;
    const key = foldKey(s, requirement.groupBy.subject.kind, caseSensitive);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ key, label: s });
  }
  return out;
}

/** Seed every group the `universe` block defines with an EMPTY accumulator,
 *  so a group with zero contributing members (e.g. an `IfcElementAssembly`
 *  with no `IfcPlate`) still produces a `count 0` set result that can fail —
 *  without this, that key never appears at all (plan §4.6, §11 risk). */
async function seedUniverse(
  requirement: AggregateRequirement,
  models: ReadonlyArray<EvaluatorModel>,
  storesById: ReadonlyMap<string, IfcDataStore>,
  caseSensitive: boolean,
  groups: Map<string, Accumulator>,
): Promise<void> {
  const universe = requirement.groupBy?.universe;
  if (!universe) return;
  const universeEls = await evaluateFilterGroupsFederated(models, universe.groups, { limit: Number.MAX_SAFE_INTEGER });
  for (const uel of universeEls) {
    const store = storesById.get(uel.modelId);
    if (!store) continue;
    if (requirement.groupBy?.subject.kind === 'parent') {
      const key = `${uel.modelId}:${uel.expressId}`;
      if (!groups.has(key)) groups.set(key, newAccumulator(store.entities.getName(uel.expressId)));
      continue;
    }
    if (!requirement.groupBy) continue;
    const subject = readSubject(requirement.groupBy.subject, { store, expressId: uel.expressId });
    for (const raw of subject.values) {
      const s = String(raw);
      if (s.trim().length === 0) continue;
      const key = foldKey(s, requirement.groupBy.subject.kind, caseSensitive);
      if (!groups.has(key)) groups.set(key, newAccumulator(s));
    }
  }
}

export async function checkAggregate(
  requirementId: string,
  requirement: AggregateRequirement,
  applicable: readonly FilteredElement[],
  storesById: ReadonlyMap<string, IfcDataStore>,
  models: ReadonlyArray<EvaluatorModel>,
  opts: ValidationOpts,
  ruleIndex: number,
  signal: AbortSignal | undefined,
  onProgress: ((p: RuleEngineProgress) => void) | undefined,
): Promise<SetCheckOutcome> {
  const label = `${requirement.fn}(${requirement.subject ? describeSubject(requirement.subject) : ''})`;
  const groups = new Map<string, Accumulator>();
  await seedUniverse(requirement, models, storesById, opts.caseSensitive, groups);

  const entityResults: EntityResult[] = [];
  const excludedRow = (el: FilteredElement, reason: FailureReasonCode): EntityResult => baseRow(el, false, {
    requirement: { id: requirementId, label, optionality: 'required' },
    status: 'fail', facetType: 'aggregate', checkedDescription: label,
    failureReason: reason, actualValue: reason === 'absent' ? '""' : '(non-numeric)', expectedValue: 'numeric',
  });
  const accFor = (key: string, groupLabel: string): Accumulator => {
    let acc = groups.get(key);
    if (!acc) groups.set(key, (acc = newAccumulator(groupLabel)));
    return acc;
  };

  for (let i = 0; i < applicable.length; i++) {
    const el = applicable[i];
    const store = storesById.get(el.modelId);
    if (store) {
      const groupKeys = groupKeysOf(requirement, el, store, opts.caseSensitive);
      if (groupKeys.length > 0) {
        if (requirement.fn === 'count') {
          for (const gk of groupKeys) {
            const acc = accFor(gk.key, gk.label);
            acc.members.push({ modelId: el.modelId, expressId: el.expressId });
            acc.count++;
          }
        } else {
          const subject = readSubject(requirement.subject!, { store, expressId: el.expressId });
          const nums = subject.present ? subject.values.map(Number).filter(Number.isFinite) : [];
          const reason: FailureReasonCode | undefined = !subject.present ? 'absent' : nums.length === 0 ? 'notNumeric' : undefined;
          for (const gk of groupKeys) {
            const acc = accFor(gk.key, gk.label);
            acc.members.push({ modelId: el.modelId, expressId: el.expressId });
            if (reason) { acc.skipped++; continue; }
            acc.count++;
            for (const n of nums) { acc.sum += n; if (n < acc.min) acc.min = n; if (n > acc.max) acc.max = n; }
            if (subject.unit) acc.units.add(subject.unit);
          }
          // One entity row per excluded ELEMENT (not per group it belongs to).
          if (reason) entityResults.push(excludedRow(el, reason));
        }
      }
    }
    await maybeYieldChunk(i + 1, applicable.length, ruleIndex, signal, onProgress);
  }
  finalProgress(applicable.length, ruleIndex, signal, onProgress);

  const setResults: SetResult[] = [];
  for (const acc of groups.values()) {
    const value = requirement.fn === 'count' ? acc.count
      : requirement.fn === 'sum' ? acc.sum
      : requirement.fn === 'min' ? (acc.count > 0 ? acc.min : 0)
      : requirement.fn === 'max' ? (acc.count > 0 ? acc.max : 0)
      : (acc.count > 0 ? acc.sum / acc.count : 0); // avg
    const unitMismatch = acc.units.size > 1;
    const unitSuffix = acc.units.size === 1 ? ` ${[...acc.units][0]}` : '';
    const passed = !unitMismatch && numericOpMatches(requirement.op, value, requirement.value, opts);
    setResults.push({
      kind: 'aggregate',
      label,
      groupKey: requirement.groupBy ? acc.keyLabel : undefined,
      actual: unitMismatch ? `mixed units: ${[...acc.units].join(', ')}` : `${value}${unitSuffix}`,
      expected: `${OP_LABEL[requirement.op]} ${requirement.value}`,
      passed,
      failureReason: passed ? undefined : (unitMismatch ? 'mismatch' : 'aggregate'),
      skipped: acc.skipped > 0 ? acc.skipped : undefined,
      members: acc.members,
    });
  }
  // Counted on the FULL (pre-cap) list — see `failedElementCount`'s doc. A
  // key set, because an element can sit in several groups (groupBy material).
  const failedElements = new Set(entityResults.map((r) => `${r.modelId}:${r.expressId}`));
  for (const set of setResults) {
    if (set.passed) continue;
    for (const m of set.members) failedElements.add(`${m.modelId}:${m.expressId}`);
  }
  orderSetResultsForCap(setResults);
  const setResultsTruncated = setResults.length > SET_RESULT_CAP;
  return {
    setResults: setResults.slice(0, SET_RESULT_CAP), setResultsTruncated, entityResults,
    failedElementCount: failedElements.size,
  };
}

/** Failing groups first, then largest first. The cap slices from the front,
 *  so a failing group must never sit behind 1 000 passing ones — otherwise the
 *  truncated list is all-pass and the rule reads `pass` (review on #5160). */
export function orderSetResultsForCap(results: SetResult[]): void {
  results.sort((a, b) => Number(a.passed) - Number(b.passed) || b.members.length - a.members.length);
}
