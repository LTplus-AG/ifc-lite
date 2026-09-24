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
  extractPropertiesOnDemand,
  extractQuantitiesOnDemand,
  extractAllEntityAttributes,
  extractAllMaterialsOnDemand,
  extractClassificationsOnDemand,
  extractTypePropertiesOnDemand,
  mergeInheritedPropertySets,
  type IfcDataStore,
} from '@ifc-lite/parser';
import { RelationshipType, QuantityType, collectSpatialAncestors } from '@ifc-lite/data';
import type { Subject } from '../rule-set/rule-set.js';
import { nameMatches, stringifyValue, defaultStoreyName, materialNamesOf } from './filter-match.js';
import { resolveEntityPredefinedType } from './entity-predefined-type.js';
import { projectSiScale, projectUnitSymbol, quantityValueSiScale, QUANTITY_MEASURE_TYPE } from './measure-units.js';
import { assignedGroupNames } from './filter-group-rule.js';

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
}

function fromStrings(values: ReadonlyArray<string | undefined>): SubjectValue {
  const defined = values.filter((v): v is string => v !== undefined);
  return { present: defined.some((v) => v.trim().length > 0), values: defined };
}

function quantityUnitSymbol(store: IfcDataStore, quantityType: number): string | undefined {
  return projectUnitSymbol(store, QUANTITY_MEASURE_TYPE[quantityType as QuantityType]);
}

/** `expressId`'s type-level property sets via `IfcRelDefinesByType`, the
 *  on-demand-only twin of `filter-evaluate.ts`'s `getInheritedTypePsets`
 *  (no per-run cache / mutation overlay here — see the module doc). */
function inheritedTypePsets(store: IfcDataStore, expressId: number) {
  if (!store.relationships) return [];
  const typeIds = store.relationships.getRelated(expressId, RelationshipType.DefinesByType, 'inverse');
  if (typeIds.length === 0) return [];
  const typeId = typeIds[0];
  if (store.source && store.source.length > 0) {
    return extractTypePropertiesOnDemand(store, expressId)?.properties ?? [];
  }
  return (store.properties?.getForEntity?.(typeId) ?? []) as ReturnType<typeof extractPropertiesOnDemand>;
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
    case 'property': {
      const own = extractPropertiesOnDemand(store, expressId);
      const merged = mergeInheritedPropertySets(own, inheritedTypePsets(store, expressId));
      const values: string[] = [];
      const valueUnits: Array<string | undefined> = [];
      const valueSiScales: Array<number | undefined> = [];
      for (const set of merged) {
        if (!nameMatches(subject.setName, set.name, subject.setNameKind)) continue;
        for (const p of set.properties) {
          if (!nameMatches(subject.propertyName, p.name, subject.propertyNameKind)) continue;
          values.push(stringifyValue(p.value));
          // Type-inherited rows are typed without `unit`; own rows carry it.
          const explicit = 'unit' in p && typeof p.unit === 'string' ? p.unit : undefined;
          valueUnits.push(explicit ?? projectUnitSymbol(store, p.dataType));
          const explicitScale = 'unitSiScale' in p && typeof p.unitSiScale === 'number' ? p.unitSiScale : undefined;
          valueSiScales.push(explicit !== undefined ? explicitScale : projectSiScale(store, p.dataType));
        }
      }
      return { ...fromStrings(values), valueUnits, valueSiScales };
    }
    case 'quantity': {
      const values: number[] = [];
      const valueUnits: Array<string | undefined> = [];
      const valueSiScales: Array<number | undefined> = [];
      for (const qset of extractQuantitiesOnDemand(store, expressId)) {
        if (!nameMatches(subject.setName, qset.name, subject.setNameKind)) continue;
        for (const q of qset.quantities) {
          if (!nameMatches(subject.quantityName, q.name, subject.quantityNameKind)) continue;
          values.push(q.value);
          // An explicit `IfcPhysicalSimpleQuantity.Unit` overrides the
          // project assignment, for display as much as for the check.
          valueUnits.push(q.explicitUnit ?? quantityUnitSymbol(store, q.type));
          valueSiScales.push(quantityValueSiScale(store, q));
        }
      }
      return { present: values.length > 0, values, unit: valueUnits.find((u) => u !== undefined), valueUnits, valueSiScales };
    }
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
