/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Set-level requirement checking (#5138 PR 3) — `unique` (plan §4.5),
 * `aggregate` (§4.6) and `compare` (§4.7). Unlike `element` (per-entity,
 * `rule-engine-requirements.ts`), `unique`/`aggregate` produce `SetResult`s
 * describing a GROUP of entities; `compare` is per-entity like `element`
 * but reads two `Subject`s instead of matching one against an operand, so
 * it lives here beside the other new requirement kinds rather than in the
 * `element` module.
 */

import type { IfcDataStore } from '@ifc-lite/parser';
import type { CheckKind, EntityResult, FailureReasonCode, RequirementResult, SetResult } from '@ifc-lite/ids';
import { collectSpatialAncestors } from '@ifc-lite/data';
import { numericOpMatches } from '../search/filter-ops.js';
import { evaluateFilterGroupsFederated } from '../search/filter-evaluate-groups.js';
import type { FilteredElement, EvaluatorModel } from '../search/filter-evaluate.js';
import { readSubject } from '../search/read-subject.js';
import type { Subject, UniqueRequirement, AggregateRequirement, CompareRequirement } from './rule-set.js';
import { OP_LABEL, type ValidationOpts } from './rule-engine-requirements.js';

const SET_RESULT_CAP = 1_000;

function describeSubject(subject: Subject): string {
  switch (subject.kind) {
    case 'property': return `${subject.setName}.${subject.propertyName}`;
    case 'quantity': return `${subject.setName}.${subject.quantityName}`;
    case 'attribute': return subject.name;
    case 'classification': return subject.system ? `Classification[${subject.system}]` : 'Classification';
    default: return subject.kind;
  }
}

function baseRow(el: FilteredElement, passed: boolean, result: RequirementResult): EntityResult {
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
}

export function checkUnique(
  requirementId: string,
  requirement: UniqueRequirement,
  applicable: readonly FilteredElement[],
  storesById: ReadonlyMap<string, IfcDataStore>,
  opts: ValidationOpts,
): SetCheckOutcome {
  const label = `unique(${describeSubject(requirement.subject)})`;
  const perModel = requirement.scope === 'perModel';
  const entityResults: EntityResult[] = [];
  // scope key ('' for federation, else modelId) -> folded value -> members.
  const buckets = new Map<string, Map<string, { el: FilteredElement; value: string }[]>>();

  for (const el of applicable) {
    const store = storesById.get(el.modelId);
    if (!store) continue;
    const subject = readSubject(requirement.subject, { store, expressId: el.expressId });
    if (!subject.present) {
      entityResults.push(baseRow(el, false, {
        requirement: { id: requirementId, label, optionality: 'required' },
        status: 'fail', facetType: 'unique', checkedDescription: label,
        failureReason: 'absent', actualValue: '""', expectedValue: 'unique',
      }));
      continue;
    }
    const scopeKey = perModel ? el.modelId : '';
    let scoped = buckets.get(scopeKey);
    if (!scoped) buckets.set(scopeKey, (scoped = new Map()));
    for (const raw of subject.values) {
      const s = String(raw);
      if (s.trim().length === 0) continue;
      const key = opts.caseSensitive ? s : s.toLowerCase();
      let bucket = scoped.get(key);
      if (!bucket) scoped.set(key, (bucket = []));
      bucket.push({ el, value: s });
    }
  }

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

function groupKeyOf(
  requirement: AggregateRequirement,
  el: FilteredElement,
  store: IfcDataStore,
  caseSensitive: boolean,
): { key: string; label: string } | undefined {
  if (!requirement.groupBy) return { key: '*', label: '' };
  if (requirement.groupBy.subject.kind === 'parent') {
    const parentId = directParentOf(store, el.expressId);
    if (parentId === undefined) return undefined;
    return { key: `${el.modelId}:${parentId}`, label: store.entities.getName(parentId) };
  }
  const subject = readSubject(requirement.groupBy.subject, { store, expressId: el.expressId });
  if (!subject.present) return undefined;
  const raw = String(subject.values[0]);
  return { key: caseSensitive ? raw : raw.toLowerCase(), label: raw };
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
      const key = caseSensitive ? s : s.toLowerCase();
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

  for (const el of applicable) {
    const store = storesById.get(el.modelId);
    if (!store) continue;
    const groupKey = groupKeyOf(requirement, el, store, opts.caseSensitive);
    if (!groupKey) continue;
    let acc = groups.get(groupKey.key);
    if (!acc) groups.set(groupKey.key, (acc = newAccumulator(groupKey.label)));
    acc.members.push({ modelId: el.modelId, expressId: el.expressId });

    if (requirement.fn === 'count') { acc.count++; continue; }
    const subject = readSubject(requirement.subject!, { store, expressId: el.expressId });
    if (!subject.present) { acc.skipped++; entityResults.push(excludedRow(el, 'absent')); continue; }
    const nums = subject.values.map(Number).filter(Number.isFinite);
    if (nums.length === 0) { acc.skipped++; entityResults.push(excludedRow(el, 'notNumeric')); continue; }
    acc.count++;
    for (const n of nums) { acc.sum += n; if (n < acc.min) acc.min = n; if (n > acc.max) acc.max = n; }
    if (subject.unit) acc.units.add(subject.unit);
  }

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
  setResults.sort((a, b) => b.members.length - a.members.length);
  const setResultsTruncated = setResults.length > SET_RESULT_CAP;
  return { setResults: setResults.slice(0, SET_RESULT_CAP), setResultsTruncated, entityResults };
}

// ── compare (plan §4.7) ──────────────────────────────────────────────────────

/** ISO-8601 date or date-time — plan §4.7. No locale formats, no
 *  `IfcCalendarDate` reconstruction (deferred, plan §10). */
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})?)?$/;

export function checkCompare(
  requirementId: string,
  requirement: CompareRequirement,
  applicable: readonly FilteredElement[],
  storesById: ReadonlyMap<string, IfcDataStore>,
  opts: ValidationOpts,
): { entityResults: EntityResult[] } {
  const expected = `${describeSubject(requirement.left)} ${OP_LABEL[requirement.op]} ${describeSubject(requirement.right)}`;
  const facetType: CheckKind = 'compare';
  const entityResults: EntityResult[] = [];

  for (const el of applicable) {
    const store = storesById.get(el.modelId);
    if (!store) continue;
    const ctx = { store, expressId: el.expressId };
    const left = readSubject(requirement.left, ctx);
    const right = readSubject(requirement.right, ctx);
    let passed = false;
    let reason: FailureReasonCode | undefined;
    let actual: string;

    if (!left.present || !right.present) {
      reason = 'absent';
      actual = `${left.present ? String(left.values[0]) : '""'} ⟂ ${right.present ? String(right.values[0]) : '""'}`;
    } else if ((requirement.valueType ?? 'number') === 'date') {
      const lv = String(left.values[0]);
      const rv = String(right.values[0]);
      actual = `${lv} ⟂ ${rv}`;
      const lOk = ISO_DATE_RE.test(lv) && Number.isFinite(Date.parse(lv));
      const rOk = ISO_DATE_RE.test(rv) && Number.isFinite(Date.parse(rv));
      if (!lOk || !rOk) {
        reason = 'notDate';
      } else {
        passed = numericOpMatches(requirement.op, Date.parse(lv), Date.parse(rv));
        reason = passed ? undefined : 'mismatch';
      }
    } else {
      const lv = Number(left.values[0]);
      const rv = Number(right.values[0]);
      actual = `${left.values[0]} ⟂ ${right.values[0]}`;
      if (!Number.isFinite(lv) || !Number.isFinite(rv)) {
        reason = 'notNumeric';
      } else {
        passed = numericOpMatches(requirement.op, lv, rv, opts);
        reason = passed ? undefined : 'mismatch';
      }
    }

    entityResults.push(baseRow(el, passed, {
      requirement: { id: requirementId, label: expected, optionality: 'required' },
      status: passed ? 'pass' : 'fail', facetType, checkedDescription: expected,
      failureReason: passed ? undefined : reason, actualValue: actual, expectedValue: expected,
    }));
  }
  return { entityResults };
}
