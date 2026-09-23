/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The `<name>.rules.json` file format for information validation (#5138).
 *
 * Rules are authored in the `FilterRule` vocabulary applicability already
 * uses (`lib/search`), not a second grammar — this module only adds the
 * shapes the search chips/selector do not need: a requirement (what has to
 * be true of the applicable set), and the `unique`/`aggregate`/`compare`
 * kinds that buildingSMART's own IDS 1.0 cannot express (plan §2). Subjects
 * are never redefined here; `Subject` is a `FilterRule` minus its operator,
 * so `readSubject` (PR 3) and the rule editor (PR 5) share one taxonomy with
 * search.
 *
 * `rule-set-io.ts` (parse/validate/serialize/export) and
 * `requirement-text.ts` (the `unique`/`aggregate`/`compare` text grammar)
 * are the other two modules in this package; this one is pure types plus
 * the version constant, so every consumer can import it without pulling in
 * `JSON.parse` or DOM download machinery.
 */

import type {
  AttributeRule,
  PropertyRule,
  QuantityRule,
  ClassificationRule,
  GroupRule,
  NumericOp,
} from '../filter/filter-rules.js';
import type { FilterGroup } from '../filter/filter-groups.js';

export const RULE_SET_VERSION = 1 as const;

export interface RuleSetFile {
  version: typeof RULE_SET_VERSION;
  name: string;
  description?: string;
  /** Persisted default target; the run-time picker can override. */
  targets?: RuleSetTargets;
  rules: InformationRule[];
}

/** Never a local model id. Both lists are OR-ed; empty/absent = every loaded model. */
export interface RuleSetTargets {
  /** `model.sourceFingerprint` values (= `EvaluatorModel.filterIdentity`, what `ModelRule.values` already match on). */
  modelFingerprints?: string[];
  /** `ModelTagRule.tagIds` (#4215). Unresolved ids match nothing, never "all". */
  modelTagIds?: string[];
}

export interface InformationRule {
  id: string;                 // uuid, stable across edits
  name: string;
  description?: string;
  severity?: 'error' | 'warning';   // default 'error'; warning never fails a delivery verdict
  /** Which elements the rule applies to. Groups OR-ed, rules inside AND/OR per group.
   *  `ifcType` rules may carry `exactClass`. */
  applicability: RuleBlock;
  requirement: Requirement;
  cardinality?: { minApplicable?: number; maxApplicable?: number };
  /** IDS is case-sensitive (bSI #346); default true. Applies to eq/ne/contains/notContains/in/notIn
   *  and to unique/groupBy keys. Regex flags remain the author's; globalId is always exact. */
  caseSensitive?: boolean;
  /** Relative tolerance for numeric eq/ne/gte/lte; default 1e-6 (bSI #418). */
  tolerance?: number;
}

export interface RuleBlock {
  groups: FilterGroup[];      // from lib/search/filter-groups.ts, verbatim
  /** How the block was last edited; editor reopens in that mode. */
  authoredAs: 'chips' | 'selector';
}

export type Requirement =
  | { kind: 'element'; block: RuleBlock }     // per-element, the issue's nine operators
  | UniqueRequirement | AggregateRequirement | CompareRequirement | UnitRequirement;

/** A FilterRule minus its operator/operand — the exact input `readSubject` takes. */
type SubjectOf<R> = Omit<R, 'op' | 'value' | 'values' | 'valueKind'>;
export type Subject =
  | SubjectOf<AttributeRule>          // { kind:'attribute'; name }
  | SubjectOf<PropertyRule>           // { kind:'property'; setName; setNameKind?; propertyName; propertyNameKind? }
  | SubjectOf<QuantityRule>           // { kind:'quantity'; setName; …; quantityName; … }
  | SubjectOf<ClassificationRule>     // { kind:'classification'; system? }
  | SubjectOf<GroupRule>              // { kind:'group'; groupClass? } — IfcRelAssignsToGroup (#5226)
  | { kind: 'name' | 'material' | 'storey' | 'parent' | 'type' | 'ifcType'
          | 'predefinedType' | 'globalId' };

export interface UniqueRequirement {
  kind: 'unique';
  subject: Subject;
  /** federation (default): the same value in two models is a duplicate. */
  scope?: 'perModel' | 'federation';
}

export interface AggregateRequirement {
  kind: 'aggregate';
  fn: 'count' | 'sum' | 'min' | 'max' | 'avg';
  subject?: Subject;                  // required unless fn === 'count'
  groupBy?: {
    subject: Subject;
    /** Elements whose own subject value (or identity, for `parent`) defines the full
     *  key set, so EMPTY groups exist and can fail (`count gte 1`). */
    universe?: RuleBlock;
  };
  op: NumericOp;
  value: number;
}

export interface CompareRequirement {
  kind: 'compare';
  left: Subject;
  right: Subject;
  op: NumericOp;
  valueType?: 'number' | 'date';      // default number
}

/**
 * "Width is recorded in mm" (#5300): every value of `subject` on an
 * applicable element must be recorded in `unit`, a display symbol as the
 * property panel shows it (`mm`, `m`, `m²`, `m³`, `kg`, …). Per element,
 * like `element`. IDS 1.0 cannot express this (bSI discussion #437).
 */
export interface UnitRequirement {
  kind: 'unit';
  /** A property or quantity subject; no other subject carries a unit. */
  subject: SubjectOf<PropertyRule> | SubjectOf<QuantityRule>;
  unit: string;
}
