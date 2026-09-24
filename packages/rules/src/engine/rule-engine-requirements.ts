/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Element-requirement checking (#5138 PR 3, plan §4.4) — one applicable
 * ELEMENT against a `RuleBlock` (OR of groups, AND/OR inside per group).
 *
 * Every operator except `isSet`/`isNotSet` fails on an absent subject
 * (plan §4 item 2), so `ne`/`notContains`/`notMatches` are proper
 * negations here — the opposite of what `stringOpMatches` does for search's
 * own `undefined` candidate (see `read-subject.ts`'s module doc for why that
 * function is not reused for this decision). Presence is always decided
 * FIRST, once, before any op runs; only `readSubject`'s `present` flag ever
 * produces `'absent'`.
 *
 * `between` (issue's ninth operator) has no operator of its own: the editor
 * authors it as two ordinary rules on the identical subject, one `gte` one
 * `lte`, AND'd in the same group (plan §5's operator table). `foldBetweenPairs`
 * finds that shape and reports it as one combined check.
 */

import type { IfcDataStore } from '@ifc-lite/parser';
import type { CheckKind, EntityResult, FailureReasonCode, RequirementResult } from '@ifc-lite/ids';
import {
  combineRuleResults,
  type AttributeRule,
  type ClassificationRule,
  type FilterRule,
  type GroupRule,
  type ModelFactRule,
  type IfcTypeRule,
  type MaterialRule,
  type NumericOp,
  type ParentRule,
  type PredefinedTypeRule,
  type PropertyRule,
  type QuantityRule,
  type NameRule,
  type TypeNameRule,
  type ValueOp,
} from '../filter/filter-rules.js';
import type { FilterGroup } from '../filter/filter-groups.js';
import type { FilteredElement } from '../filter/filter-evaluate.js';
import { readSubject, type ReadSubjectContext, type SubjectValue } from '../filter/read-subject.js';
import { toSiValues } from '../filter/subject-match.js';
import {
  matchStringAnyNone,
  numericOpMatches,
  setOpMatches,
  stringOpMatches,
  valueOpMatches,
  type OpMatchOptions,
} from '../filter/filter-ops.js';
import type { RuleBlock } from '../rule-set/rule-set.js';

/** The engine always passes both, defaulted from the rule (plan §4 item 3). */
export type ValidationOpts = Required<OpMatchOptions>;

interface RuleOutcome {
  passed: boolean;
  reason?: FailureReasonCode;
  actual: string;
  expected: string;
  facetType: CheckKind;
  checkedDescription: string;
}

/** Shared with `rule-engine-sets.ts` (compare/aggregate render the same
 *  `op` vocabulary). */
export const OP_LABEL: Record<string, string> = {
  eq: '=', ne: '!=', gt: '>', gte: '>=', lt: '<', lte: '<=',
  contains: 'contains', notContains: 'not contains', startsWith: 'starts with',
  matches: 'matches', notMatches: 'not matches',
};

function actualOf(subject: SubjectValue): string {
  // `present === false` covers BOTH a genuinely empty `values` array and one
  // whose only entries are `''`/whitespace (plan §4.2's "empty string is
  // absent" — an explicitly empty `IFCLABEL` renders the same `'""'` an
  // outright-missing property does, not a blank string).
  if (!subject.present) return '""';
  const joined = subject.values.map(String).join('; ');
  return subject.unit ? `${joined} ${subject.unit}` : joined;
}

function subjectLabel(rule: FilterRule): string {
  switch (rule.kind) {
    case 'property': return `${rule.setName}.${rule.propertyName}`;
    case 'quantity': return `${rule.setName}.${rule.quantityName}`;
    case 'attribute': return rule.name;
    case 'name': return 'Name';
    case 'type': return 'Type';
    case 'parent': return 'Parent';
    case 'material': return 'Material';
    case 'classification': return rule.system ? `Classification[${rule.system}]` : 'Classification';
    case 'group': return rule.groupClass ? `Group[${rule.groupClass}]` : 'Group';
    case 'modelFact': return `model.${rule.fact}`;
    case 'ifcType': return 'IfcType';
    case 'predefinedType': return 'PredefinedType';
    default: return rule.kind;
  }
}

/** Maps a `FilterRule` kind onto the closed `CheckKind` reporting vocabulary
 *  (plan §5). Several kinds have no dedicated IDS facet type; the closest
 *  fit is used and documented here rather than invented silently:
 *  `attribute`/`name`/`type`/`globalId` → `attribute` (all read an IFC
 *  attribute), `parent` → `partOf` (bSI's containment/aggregation facet),
 *  `ifcType`/`predefinedType` → `entity` (bSI's entity facet covers both),
 *  `storey` → `spatial` (a `CheckKind`-only addition with no facet analogue). */
function checkKindOf(kind: FilterRule['kind']): CheckKind {
  switch (kind) {
    case 'property': return 'property';
    case 'quantity': return 'quantity';
    case 'attribute':
    case 'name':
    case 'type':
    case 'globalId':
      return 'attribute';
    case 'material': return 'material';
    case 'classification': return 'classification';
    case 'parent':
    case 'group':
      return 'partOf';
    case 'ifcType':
    case 'predefinedType':
      return 'entity';
    case 'storey': return 'spatial';
    case 'modelFact': return 'model';
    default: return 'attribute';
  }
}

function renderExpected(rule: FilterRule): string {
  switch (rule.kind) {
    case 'quantity':
      return `${OP_LABEL[rule.op]} ${rule.value}`;
    case 'property':
    case 'attribute':
    case 'modelFact':
    case 'name':
    case 'type':
    case 'parent':
    case 'material':
    case 'classification':
    case 'group':
      return `${OP_LABEL[rule.op] ?? rule.op} ${'value' in rule ? rule.value : ''}`;
    case 'ifcType':
    case 'predefinedType':
      return `${rule.op === 'in' ? 'in' : 'not in'} [${rule.values.join(', ')}]`;
    default:
      return 'op' in rule ? String((rule as { op: unknown }).op) : '';
  }
}

/** Element-requirement kinds allowed by the plan (§3): every other
 *  `FilterRule` kind reaching here is an authoring bug the rule-set loader
 *  (PR 2) should already have rejected — surfaced as a thrown error rather
 *  than silently passed/failed (caught by `rule-engine.ts`'s per-rule guard
 *  and reported as `SpecificationResult.error`). */
type ElementRule =
  | PropertyRule | QuantityRule | AttributeRule | NameRule | TypeNameRule
  | ParentRule | MaterialRule | ClassificationRule | IfcTypeRule | PredefinedTypeRule | GroupRule | ModelFactRule;

function isElementRule(rule: FilterRule): rule is ElementRule {
  switch (rule.kind) {
    case 'property': case 'quantity': case 'attribute': case 'name': case 'type':
    case 'parent': case 'material': case 'classification': case 'ifcType': case 'predefinedType':
    case 'group': case 'modelFact':
      return true;
    default:
      return false;
  }
}

function checkFilterRule(rule: ElementRule, ctx: ReadSubjectContext, opts: ValidationOpts): RuleOutcome {
  // `valueUnit: 'si'` (#5225): compare SI values, the same reading search uses.
  const subject = (rule.kind === 'property' || rule.kind === 'quantity') && rule.valueUnit === 'si'
    ? toSiValues(readSubject(rule, ctx))
    : readSubject(rule, ctx);
  const facetType = checkKindOf(rule.kind);
  const label = subjectLabel(rule);
  const actual = actualOf(subject);

  if (rule.op === 'isSet' || rule.op === 'isNotSet') {
    const passed = rule.op === 'isSet' ? subject.present : !subject.present;
    const expected = rule.op === 'isSet' ? 'is set' : 'is not set';
    return { passed, reason: passed ? undefined : 'absent', actual, expected, facetType, checkedDescription: `${label} ${expected}` };
  }

  const expected = renderExpected(rule);
  const checkedDescription = `${label} ${expected}`;
  if (!subject.present) {
    return { passed: false, reason: 'absent', actual, expected, facetType, checkedDescription };
  }

  switch (rule.kind) {
    case 'quantity': {
      const nums = subject.values.map(Number).filter(Number.isFinite);
      if (nums.length === 0) return { passed: false, reason: 'notNumeric', actual, expected, facetType, checkedDescription };
      const passed = nums.some((v) => numericOpMatches(rule.op, v, rule.value, opts));
      return { passed, reason: passed ? undefined : 'mismatch', actual, expected, facetType, checkedDescription };
    }
    case 'property':
    case 'attribute':
    case 'modelFact':
      return checkValueOp(rule, subject, opts, facetType, actual, expected, checkedDescription);
    case 'ifcType':
    case 'predefinedType': {
      const candidate = String(subject.values[0] ?? '');
      const passed = setOpMatches(rule.op, candidate, rule.values, opts);
      return { passed, reason: passed ? undefined : 'mismatch', actual, expected, facetType, checkedDescription };
    }
    default: {
      // name | type | parent | material | classification | group — StringOp (or the
      // StringOp-compatible subset of ClassificationOp); multi-valued
      // subjects (parent/material) match ANY for a positive op, NONE for a
      // negative one, via the same convention search already uses.
      const candidates = subject.values.map(String);
      const passed = matchStringAnyNone(rule.op, candidates, rule.value, rule.valueKind, opts);
      return { passed, reason: passed ? undefined : 'mismatch', actual, expected, facetType, checkedDescription };
    }
  }
}

function checkValueOp(
  rule: PropertyRule | AttributeRule | ModelFactRule,
  subject: SubjectValue,
  opts: ValidationOpts,
  facetType: CheckKind,
  actual: string,
  expected: string,
  checkedDescription: string,
): RuleOutcome {
  const strVals = subject.values.map(String);
  const op = rule.op as Exclude<ValueOp, 'isSet' | 'isNotSet'>;

  if (op === 'gt' || op === 'gte' || op === 'lt' || op === 'lte') {
    // Strict `Number(...)`, not `Number.parseFloat` — plan §4 item 4 requires
    // a "finite f64", and `parseFloat('2HR')` (== 2) would silently accept a
    // fire-rating STRING as a number instead of reporting `notNumeric`.
    const rv = Number(rule.value);
    const nums = strVals.map((v) => Number(v)).filter(Number.isFinite);
    if (!Number.isFinite(rv) || nums.length === 0) {
      return { passed: false, reason: 'notNumeric', actual, expected, facetType, checkedDescription };
    }
    const passed = nums.some((cv) => numericOpMatches(op, cv, rv, opts));
    return { passed, reason: passed ? undefined : 'mismatch', actual, expected, facetType, checkedDescription };
  }
  if (op === 'eq' || op === 'ne') {
    const rv = Number(rule.value);
    const nums = strVals.map((v) => Number(v));
    const allFinite = Number.isFinite(rv) && nums.length > 0 && nums.every(Number.isFinite);
    const matchAny = allFinite
      ? nums.some((cv) => numericOpMatches('eq', cv, rv, opts))
      : strVals.some((v) => stringOpMatches('eq', v, rule.value, undefined, opts));
    const passed = op === 'eq' ? matchAny : !matchAny;
    return { passed, reason: passed ? undefined : 'mismatch', actual, expected, facetType, checkedDescription };
  }
  // contains / notContains / matches / notMatches
  const posOp: ValueOp = op === 'notContains' ? 'contains' : op === 'notMatches' ? 'matches' : op;
  const anyPositive = strVals.some((v) => valueOpMatches(posOp, v, rule.value, rule.valueKind, opts));
  const passed = posOp === op ? anyPositive : !anyPositive;
  return { passed, reason: passed ? undefined : 'mismatch', actual, expected, facetType, checkedDescription };
}

// ── `between` folding (gte + lte on the identical subject, plan §5) ────────

interface BetweenPair { kind: 'between'; low: ElementRule & { op: NumericOp | ValueOp }; high: ElementRule & { op: NumericOp | ValueOp } }
type CheckItem = ElementRule | BetweenPair;

function subjectKey(rule: FilterRule): string | null {
  switch (rule.kind) {
    case 'quantity': return `quantity:${rule.setName}:${rule.quantityName}`;
    case 'property': return `property:${rule.setName}:${rule.propertyName}`;
    case 'attribute': return `attribute:${rule.name}`;
    default: return null;
  }
}

function foldBetweenPairs(rules: readonly ElementRule[]): CheckItem[] {
  const used = new Set<number>();
  const out: CheckItem[] = [];
  for (let i = 0; i < rules.length; i++) {
    if (used.has(i)) continue;
    const a = rules[i];
    const keyA = subjectKey(a);
    const opA = 'op' in a ? a.op : undefined;
    if (keyA && (opA === 'gte' || opA === 'lte')) {
      for (let j = i + 1; j < rules.length; j++) {
        if (used.has(j)) continue;
        const b = rules[j];
        if (subjectKey(b) !== keyA) continue;
        const opB = 'op' in b ? b.op : undefined;
        if ((opA === 'gte' && opB === 'lte') || (opA === 'lte' && opB === 'gte')) {
          used.add(i); used.add(j);
          out.push({ kind: 'between', low: opA === 'gte' ? a : b, high: opA === 'lte' ? a : b } as BetweenPair);
          break;
        }
      }
    }
  }
  for (let i = 0; i < rules.length; i++) if (!used.has(i)) out.push(rules[i]);
  return out;
}

function evaluateBetween(pair: BetweenPair, ctx: ReadSubjectContext, opts: ValidationOpts): RuleOutcome {
  const low = checkFilterRule(pair.low, ctx, opts);
  const high = checkFilterRule(pair.high, ctx, opts);
  const passed = low.passed && high.passed;
  const label = subjectLabel(pair.low);
  const lowVal = 'value' in pair.low ? pair.low.value : '';
  const highVal = 'value' in pair.high ? pair.high.value : '';
  const expected = `>= ${lowVal} and <= ${highVal}`;
  return {
    passed,
    reason: passed ? undefined : (low.reason ?? high.reason),
    actual: low.actual,
    expected,
    facetType: low.facetType,
    checkedDescription: `${label} ${expected}`,
  };
}

interface GroupOutcome { passed: boolean; failingCount: number; representative: RuleOutcome }

function evaluateGroup(group: FilterGroup, ctx: ReadSubjectContext, opts: ValidationOpts): GroupOutcome {
  const elementRules = group.rules.filter(isElementRule);
  if (elementRules.length !== group.rules.length) {
    throw new Error(`rule-engine: applicability-only rule kind used in an element requirement (group has ${group.rules.length - elementRules.length} such rule(s))`);
  }
  // `between` is a gte+lte pair AND'd on the identical subject (plan §5's
  // operator table) — only a shorthand within an AND group. In an OR group
  // the two rules are independent alternatives (`Width >= 0.25` OR `Width
  // <= 0.35` — 0.20 satisfies the second on its own), so folding them would
  // silently require BOTH, changing what the group matches (review finding).
  const items = group.combinator === 'AND' ? foldBetweenPairs(elementRules) : elementRules;
  const outcomes = items.map((item) =>
    'kind' in item && item.kind === 'between' ? evaluateBetween(item, ctx, opts) : checkFilterRule(item, ctx, opts),
  );
  if (outcomes.length === 0) return { passed: false, failingCount: 0, representative: { passed: false, actual: '', expected: '', facetType: 'attribute', checkedDescription: 'empty group' } };
  const passed = combineRuleResults(group.combinator, outcomes.map((o) => o.passed));
  const failingCount = outcomes.filter((o) => !o.passed).length;
  const representative = outcomes.find((o) => !o.passed) ?? outcomes[0];
  return { passed, failingCount, representative };
}

/**
 * Check one applicable element against `block` (plan §4.4). `requirementId`/
 * `requirementLabel` seed the singular `requirementResults[0]` every entity
 * row carries — the rule's own id/name, since one `InformationRule`'s
 * `element` requirement is ONE requirement, not one per underlying
 * `FilterRule` (a `between` pair, or several AND'd rules in a group, are
 * still a single pass/fail question).
 */
export function checkElementForEntity(
  requirementId: string,
  block: RuleBlock,
  el: FilteredElement,
  store: IfcDataStore,
  opts: ValidationOpts,
): EntityResult {
  const ctx: ReadSubjectContext = { store, expressId: el.expressId };
  const groupOutcomes = block.groups.map((g) => evaluateGroup(g, ctx, opts));
  const passedGroup = groupOutcomes.find((g) => g.passed);
  const chosen = passedGroup
    ?? groupOutcomes.reduce((best, g) => (g.failingCount < best.failingCount ? g : best), groupOutcomes[0]);
  const passed = !!passedGroup;
  const requirementResult: RequirementResult = {
    requirement: { id: requirementId, label: chosen.representative.checkedDescription, optionality: 'required' },
    status: passed ? 'pass' : 'fail',
    facetType: chosen.representative.facetType,
    checkedDescription: chosen.representative.checkedDescription,
    failureReason: passed ? undefined : chosen.representative.reason,
    actualValue: chosen.representative.actual,
    expectedValue: chosen.representative.expected,
  };
  return {
    expressId: el.expressId,
    modelId: el.modelId,
    entityType: el.ifcType,
    entityName: el.name || undefined,
    globalId: el.globalId,
    passed,
    requirementResults: [requirementResult],
  };
}
