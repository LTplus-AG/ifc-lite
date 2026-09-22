/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `RuleBlock`/`Requirement` parsing for `.rules.json` files (#5138). Split
 * out of `rule-set-io.ts` to stay under the module-size cap.
 */

import type { RuleBlock, Requirement, Subject, UniqueRequirement, AggregateRequirement, CompareRequirement } from './rule-set.js';
import { parseFilterGroups, type FilterGroup } from '../search/filter-groups.js';
import type { FilterRule, NumericOp } from '../search/filter-rules.js';
import { fail, isPlainObject, unknownKeysOf, warnUnknownFields } from './rule-set-io-shared.js';
import { parseSubject, isSingleValuedSubject } from './rule-set-io-subject.js';
import { checkAggregateSubject } from './aggregate-requirement-invariant.js';

const NUMERIC_OPS: ReadonlySet<string> = new Set<NumericOp>(['eq', 'ne', 'gt', 'gte', 'lt', 'lte']);
const AGGREGATE_FNS = new Set(['count', 'sum', 'min', 'max', 'avg']);
const AUTHORED_AS = new Set(['chips', 'selector']);
const UNIQUE_SCOPES = new Set(['perModel', 'federation']);

/** Kinds a `requirement: { kind: 'element' }` block may filter on — the
 *  issue's nine operators, per-element only. `model`/`modelTag`/`storey`/
 *  `globalId`/`elevation` scope WHICH elements to check, they are not
 *  themselves checkable facts, so they belong in `applicability` only. */
/** Exported so the rule editor (#5138 PR 5, `validation/RuleBlockEditor.tsx`)
 *  can restrict its "Add rule" menu to exactly what this parser accepts —
 *  one list, not a second copy that could drift. */
export const ELEMENT_REQUIREMENT_KINDS: ReadonlySet<FilterRule['kind']> = new Set([
  'property', 'quantity', 'attribute', 'name', 'material', 'classification',
  'type', 'parent', 'predefinedType', 'ifcType',
]);

/** Parses a `RuleBlock`, restricting which `FilterRule` kinds may appear.
 *  Pass `null` for applicability/`groupBy.universe` (same vocabulary a saved
 *  search filter allows, minus `elevation`/ref-carrying `storey`, checked
 *  unconditionally below); pass `ELEMENT_REQUIREMENT_KINDS` for an
 *  `element` requirement's block. */
export function parseRuleBlock(raw: unknown, where: string, allowedKinds: ReadonlySet<FilterRule['kind']> | null): RuleBlock {
  if (!isPlainObject(raw)) fail(`${where}: must be an object`);
  const b = raw as Record<string, unknown>;
  const groups = parseFilterGroups(b.groups);
  if (!groups) fail(`${where}: "groups" is missing or unreadable`);
  if (b.authoredAs !== undefined && !AUTHORED_AS.has(b.authoredAs as string)) fail(`${where}: bad "authoredAs"`);

  for (const group of groups) validateBlockRules(group, where, allowedKinds);

  warnUnknownFields(where, unknownKeysOf(b, ['groups', 'authoredAs']));
  return { groups, authoredAs: (b.authoredAs as RuleBlock['authoredAs']) ?? 'chips' };
}

function validateBlockRules(group: FilterGroup, where: string, allowedKinds: ReadonlySet<FilterRule['kind']> | null): void {
  for (const rule of group.rules) {
    if (rule.kind === 'elevation') fail(`${where}: "elevation" rules are not allowed (no aggregate meaning, plan §3)`);
    if (rule.kind === 'storey' && 'refs' in rule && rule.refs) {
      fail(`${where}: a storey rule with "refs" (local runtime ids) cannot be saved to a rule-set file`);
    }
    if (allowedKinds && !allowedKinds.has(rule.kind)) {
      fail(`${where}: requirement rules may not use kind "${rule.kind}" (allowed: ${[...allowedKinds].join(', ')})`);
    }
  }
}

export function parseRequirement(raw: unknown, where: string): Requirement {
  if (!isPlainObject(raw)) fail(`${where}: "requirement" must be an object`);
  const r = raw as Record<string, unknown>;
  const kind = r.kind;

  if (kind === 'element') {
    const block = parseRuleBlock(r.block, `${where}.block`, ELEMENT_REQUIREMENT_KINDS);
    return { kind: 'element', block };
  }
  if (kind === 'unique') return parseUniqueRequirement(r, where);
  if (kind === 'aggregate') return parseAggregateRequirement(r, where);
  if (kind === 'compare') return parseCompareRequirement(r, where);
  fail(`${where}: unrecognised requirement kind ${JSON.stringify(kind)}`);
}

function parseUniqueRequirement(r: Record<string, unknown>, where: string): UniqueRequirement {
  const subject = parseSubject(r.subject, `${where}.subject`);
  if (r.scope !== undefined && !UNIQUE_SCOPES.has(r.scope as string)) fail(`${where}: bad "scope"`);
  return { kind: 'unique', subject, ...(r.scope !== undefined ? { scope: r.scope as UniqueRequirement['scope'] } : {}) };
}

function parseAggregateRequirement(r: Record<string, unknown>, where: string): AggregateRequirement {
  if (typeof r.fn !== 'string' || !AGGREGATE_FNS.has(r.fn)) fail(`${where}: bad "fn"`);
  const fn = r.fn as AggregateRequirement['fn'];

  let subject: Subject | undefined;
  if (r.subject !== undefined) {
    subject = parseSubject(r.subject, `${where}.subject`);
  }
  // Shared with the text parser (#5182) — a subject is required unless `fn`
  // is `count`, and a present subject must be single-valued unless `fn` is
  // `count` (multi-valued subjects like material/classification/parent only
  // make sense as a bucketing key, not as something to sum/average).
  const subjectError = checkAggregateSubject(fn, subject);
  if (subjectError) fail(`${where}: ${subjectError}`);

  let groupBy: AggregateRequirement['groupBy'];
  if (r.groupBy !== undefined) {
    if (!isPlainObject(r.groupBy)) fail(`${where}.groupBy: must be an object`);
    const g = r.groupBy as Record<string, unknown>;
    const groupSubject = parseSubject(g.subject, `${where}.groupBy.subject`);
    const universe = g.universe !== undefined ? parseRuleBlock(g.universe, `${where}.groupBy.universe`, null) : undefined;
    groupBy = { subject: groupSubject, ...(universe ? { universe } : {}) };
  }

  if (!NUMERIC_OPS.has(r.op as string)) fail(`${where}: bad "op"`);
  if (typeof r.value !== 'number' || !Number.isFinite(r.value)) fail(`${where}: "value" must be a finite number`);

  return {
    kind: 'aggregate',
    fn,
    ...(subject ? { subject } : {}),
    ...(groupBy ? { groupBy } : {}),
    op: r.op as NumericOp,
    value: r.value,
  };
}

function parseCompareRequirement(r: Record<string, unknown>, where: string): CompareRequirement {
  const left = parseSubject(r.left, `${where}.left`);
  const right = parseSubject(r.right, `${where}.right`);
  if (!isSingleValuedSubject(left)) fail(`${where}.left: "compare" needs a single-valued subject, "${left.kind}" is multi-valued`);
  if (!isSingleValuedSubject(right)) fail(`${where}.right: "compare" needs a single-valued subject, "${right.kind}" is multi-valued`);
  if (!NUMERIC_OPS.has(r.op as string)) fail(`${where}: bad "op"`);
  if (r.valueType !== undefined && r.valueType !== 'number' && r.valueType !== 'date') fail(`${where}: bad "valueType"`);
  return {
    kind: 'compare', left, right, op: r.op as NumericOp,
    ...(r.valueType !== undefined ? { valueType: r.valueType as CompareRequirement['valueType'] } : {}),
  };
}
