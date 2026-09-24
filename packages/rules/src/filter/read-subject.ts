/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `readSubject` — the ONE reader the information-validation engine (#5138 PR
 * 3, `lib/validation/rule-engine*.ts`) uses to pull a `Subject`'s raw values
 * off one element, before any operator is applied. New file rather than
 * grown into `filter-match.ts` (already 353 lines; the plan's own size
 * budget note applies) — and, more importantly, a NEW function rather than a
 * literal `matchXRule → op(readSubject(...))` refactor of the existing
 * search matchers there.
 *
 * Why not the refactor the plan describes as the default: every existing
 * matcher's absent-handling is tuned to SEARCH's own convention, and that
 * convention is not uniform across rule kinds — `stringOpMatches` (used by
 * `name`/`type`/`parent` inline in `filter-evaluate.ts`) matches `ne` /
 * `notContains` / `notMatches` TRUE on an absent candidate (a missing Name
 * satisfies "Name != Foo"), while `matchAttributeRule` / `matchPropertyRule`
 * already fail every op but `isNotSet` on absent. Validation needs the
 * SECOND convention for every subject, uniformly (plan §4 item 2: "every
 * operator except isNotSet fails on present === false with absent" — so
 * `ne`/`notContains`/`notMatches` become proper negations, not "vacuously
 * true on absent"). Reusing `stringOpMatches`'s existing undefined branch
 * for `name`/`type`/`parent` would import the WRONG convention; changing
 * that branch would change search's own `ne`/`notContains` results
 * (`filter-evaluate-absent-name.test.ts` pins the current behaviour). So
 * `readSubject` reads values only — presence and per-op pass/fail rules are
 * the validation engine's own concern (`rule-engine-requirements.ts`),
 * applied via `matchStringAnyNone`/`valueOpMatches`/`numericOpMatches`
 * (`filter-ops.ts`) with an empty candidate list standing in for "absent",
 * which already fails every op (`matchStringAnyNone`'s own `candidates.
 * length === 0` branch — see that engine module for how this is used).
 *
 * `filter-match.ts` is UNCHANGED by this file (0-line diff) — every matcher
 * it exports keeps meaning exactly what it means today.
 */

import {
  extractAllEntityAttributes,
  extractAllMaterialsOnDemand,
  extractClassificationsOnDemand,
  type IfcDataStore,
} from '@ifc-lite/parser';
import { RelationshipType, collectSpatialAncestors } from '@ifc-lite/data';
import type { Subject } from '../rule-set/rule-set.js';
import { stringifyValue, defaultStoreyName, materialNamesOf } from './filter-match.js';
import { resolveEntityPredefinedType } from './entity-predefined-type.js';
import { readMeasureSubject } from './read-measure-subject.js';
import { assignedGroupNames } from './filter-group-rule.js';
import { readModelFact } from './filter-model-fact.js';

/** What `readSubject` needs about the element it reads. No `mutationView` —
 *  the engine reads the model as loaded, not with live in-session edits
 *  applied (those are a follow-up; noted in the PR body). */
export interface ReadSubjectContext {
  store: IfcDataStore;
  expressId: number;
}

/** The result `readSubject` returns for every `Subject` kind. */
export interface SubjectValue {
  /** At least one value, after `String(v).trim()`, is non-empty (plan §4.2). */
  present: boolean;
  values: ReadonlyArray<string | number>;
  /** Quantity subjects only — the stored unit label, when known. */
  unit?: string;
  /**
   * Property and quantity subjects only: the unit each entry of `values` is
   * recorded in, index for index (#5300). The value's own explicit `Unit`
   * when the file declares one, otherwise the project unit for its measure
   * type; `undefined` for a value that has no unit (a label, a count, an
   * untyped property).
   */
  valueUnits?: ReadonlyArray<string | undefined>;
  /**
   * Property and quantity subjects only, aligned with `values`: the factor
   * that turns each value into SI base units, from the same unit as
   * `valueUnits`; `undefined` for a value with no unit (#5225).
   */
  valueSiScales?: ReadonlyArray<number | undefined>;
  /**
   * Property subjects only: one value per matched property, a list, enumerated
   * or table value as its joined display text, where `values` holds each
   * member (#5475). The set checks (`unique`, `aggregate`, `compare`) read
   * a property as ONE value, so they use these; element checks match members.
   */
  displayValues?: ReadonlyArray<string>;
}

/** `subject` read as whole values: each property once, as the set checks compare it (#5475). */
export function readSubjectWhole(subject: Subject, ctx: ReadSubjectContext): SubjectValue {
  const read = readSubject(subject, ctx);
  return read.displayValues ? { ...read, values: read.displayValues } : read;
}

function fromStrings(values: ReadonlyArray<string | undefined>): SubjectValue {
  const defined = values.filter((v): v is string => v !== undefined);
  return { present: defined.some((v) => v.trim().length > 0), values: defined };
}


/** `expressId`'s relating TYPE object's Name, via `IfcRelDefinesByType` — the
 *  read-only twin of `filter-evaluate.ts`'s `relatingTypeNameOf`. */
function relatingTypeName(store: IfcDataStore, expressId: number): string | undefined {
  if (!store.relationships) return undefined;
  const typeIds = store.relationships.getRelated(expressId, RelationshipType.DefinesByType, 'inverse');
  if (typeIds.length === 0) return undefined;
  return store.entities.getNameOrUndefined(typeIds[0]);
}

/**
 * Read one `Subject`'s raw values off `ctx.expressId`. Callers may pass a
 * full `FilterRule` in place of a `Subject` — every rule kind's shape is a
 * structural superset of its `Subject` (`SubjectOf<R>` in `rule-set.ts`), so
 * the extra `op`/`value`/`values` fields are simply ignored here.
 */
export function readSubject(subject: Subject, ctx: ReadSubjectContext): SubjectValue {
  const { store, expressId } = ctx;
  switch (subject.kind) {
    case 'attribute': {
      const wanted = subject.name.toLowerCase();
      const found = extractAllEntityAttributes(store, expressId).find((a) => a.name.toLowerCase() === wanted);
      return fromStrings([found === undefined ? undefined : stringifyValue(found.value)]);
    }
    case 'property':
    case 'quantity':
      return readMeasureSubject(subject, store, expressId);
    case 'classification': {
      const sys = subject.system?.trim().toLowerCase();
      const refs = extractClassificationsOnDemand(store, expressId).filter(
        (r) => !r.unresolved && (!sys || (r.system ?? '').toLowerCase() === sys),
      );
      // BOTH the code AND the name per ref, not one-or-the-other — review
      // finding: classification matching is code OR name
      // (`matchClassificationRule`, filter-match.ts), so a rule matching
      // either value must see it here too. A ref with `{identification:
      // '123', name:'Fire rating'}` contributes TWO values; deduped so a
      // ref whose code and name happen to be identical doesn't double-count.
      const values = new Set<string>();
      for (const r of refs) {
        if (r.identification) values.add(r.identification);
        if (r.name) values.add(r.name);
      }
      return fromStrings([...values]);
    }
    case 'material': {
      const names = new Set<string>();
      for (const info of extractAllMaterialsOnDemand(store, expressId)) {
        for (const n of materialNamesOf(info)) names.add(n);
      }
      return fromStrings([...names]);
    }
    case 'name':
      return fromStrings([store.entities.getNameOrUndefined(expressId)]);
    case 'type':
      return fromStrings([relatingTypeName(store, expressId)]);
    case 'ifcType':
      return fromStrings([store.entities.getTypeName(expressId)]);
    case 'predefinedType':
      return fromStrings([resolveEntityPredefinedType(store, expressId)]);
    case 'globalId':
      return fromStrings([store.entities.getGlobalId(expressId)]);
    case 'storey': {
      const name = defaultStoreyName(store, expressId);
      return fromStrings([name.length > 0 ? name : undefined]);
    }
    case 'modelFact':
      return fromStrings(readModelFact(store, subject.fact).map(String));
    case 'group': {
      // Present = assigned to at least one such group, named or not (#5226):
      // membership is the fact, a group's Name is only what value ops read.
      const names = assignedGroupNames(store, expressId, subject.groupClass);
      return { present: names.length > 0, values: names.filter((n): n is string => n !== undefined) };
    }
    case 'parent': {
      const names = store.relationships
        ? collectSpatialAncestors(store.relationships, expressId).map((id) => store.entities.getNameOrUndefined(id))
        : [];
      return fromStrings(names);
    }
  }
}
