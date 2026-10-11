/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Property-set and property rules: IDSL-PSET-001 … 003, IDSL-PROP-001 … 003. */

import type { IfcPropertyInfo, IfcPropertySetInfo } from '@ifc-lite/data';
import type { IDSPropertyFacet, IFCVersion } from '@ifc-lite/ids';
import type { VersionTables } from '../../gate/context.js';
import { isReservedPsetName } from '../../gate/grounding-pset.js';
import { rankCandidates } from '../../gate/rank.js';
import { quickFix } from '../fix.js';
import type { FacetView, Finding, LintContext, SpecRule, SpecView } from '../types.js';
import { at } from '../walk.js';
import { setValues } from './entity.js';
import { applicabilityEntityNames, gated, isSubtypeOf, listSome, literals, single, tables } from './util.js';

interface PropertySite {
  view: FacetView;
  facet: IDSPropertyFacet;
}

function propertySites(spec: SpecView): PropertySite[] {
  return [...spec.applicability, ...spec.requirements].flatMap((view) => (view.facet.type === 'property' ? [{ view, facet: view.facet }] : []));
}

/** The standard property (and its set) per version, when both names are literals. */
function standardProperty(t: VersionTables, facet: IDSPropertyFacet): { pset: IfcPropertySetInfo; prop?: IfcPropertyInfo } | undefined {
  const psetName = single(facet.propertySet);
  const pset = psetName ? t.psets.get(psetName) : undefined;
  if (!pset) return undefined;
  const name = single(facet.baseName);
  return { pset, prop: name ? pset.properties.find((p) => p.name === name) : undefined };
}

/** `applicableEntities` plus each class's companion type (mirrors the audit, #1441). */
function applicableWithTypes(t: VersionTables, pset: IfcPropertySetInfo): string[] {
  const out = new Set(pset.applicableEntities);
  for (const name of pset.applicableEntities) {
    const e = t.entities.get(name.toUpperCase());
    if (e?.typeEntity) out.add(e.typeEntity);
    else if (t.entities.has(`${name.toUpperCase()}TYPE`)) out.add(`${name}Type`);
  }
  return [...out];
}

function psetApplies(t: VersionTables, pset: IfcPropertySetInfo, entity: string): boolean {
  return applicableWithTypes(t, pset).some((a) => isSubtypeOf(t, entity, a));
}

export const PSET_001: SpecRule = {
  code: 'IDSL-PSET-001',
  area: 'PSET',
  scope: 'spec',
  kind: 'static',
  defaultSeverity: 'warning',
  title: 'Standard property set not applicable to the entity',
  rationale:
    "The standard property set is not defined for any applicability entity (per its applicable entities, including subtypes and companion type objects). Authoring tools will not offer it on those elements, so the requirement is likely to fail on every model. The audit reports the same mismatch; lint adds the applicable alternatives.",
  fix: 'Switch to an applicable standard set that defines the same property.',
  example: '<entity><name><simpleValue>IFCDOOR</simpleValue></name></entity> + <property><propertySet><simpleValue>Pset_WallCommon</simpleValue></propertySet>…',
  check(spec, { ctx, doc }) {
    const entities = applicabilityEntityNames(spec);
    if (!entities.length) return [];
    const out: Finding[] = [];
    for (const { view, facet } of propertySites(spec)) {
      const psetName = single(facet.propertySet);
      if (!psetName) continue;
      const version = spec.versions.find((v) => {
        const t = tables(ctx, v);
        const pset = t.psets.get(psetName);
        if (!pset || !pset.applicableEntities.length || entities.some((e) => !t.entities.has(e))) return false;
        return !entities.some((e) => psetApplies(t, pset, e));
      });
      if (!version) continue;
      const t = tables(ctx, version);
      const name = single(facet.baseName);
      const alternatives = name
        ? (t.psetsByProperty.get(name) ?? []).filter((p) => p !== psetName && entities.some((e) => psetApplies(t, t.psets.get(p) as IfcPropertySetInfo, e))).slice(0, 3)
        : [];
      const fixes = alternatives.map((p) => quickFix(`Use ${p}`, this.code, view.facetId, p, [setValues(view.facetId, 'property.propertySet', [p])]));
      out.push({
        ...at(view, 'property.propertySet'),
        message: `${psetName} is not applicable to ${listSome(entities.map((e) => t.entities.get(e)?.name ?? e))} (${version})`,
        fixes: gated(doc, ctx, fixes),
      });
    }
    return out;
  },
};

const PROJECT_PREFIX = 'Project_';

export const PSET_002: SpecRule = {
  code: 'IDSL-PSET-002',
  area: 'PSET',
  scope: 'spec',
  kind: 'static',
  defaultSeverity: 'error',
  title: 'Custom property set with a reserved prefix',
  rationale:
    'The prefixes Pset_ and Qto_ are reserved for sets published by buildingSMART. A set with such a name that is not a standard set of the IFC version is either a typo of a standard name or a custom set that must use its own prefix. (Qto_ names cannot be verified for IFC2X3 and IFC4, whose tables have no quantity sets; they are not flagged.)',
  fix: 'Use the closest standard set, or rename it with a project prefix and declare it as a custom set.',
  example: '<propertySet><simpleValue>Pset_MyCompanyData</simpleValue></propertySet>',
  check(spec, { ctx, doc }) {
    const out: Finding[] = [];
    for (const { view, facet } of propertySites(spec)) {
      const psetName = single(facet.propertySet);
      if (!psetName || !isReservedPsetName(psetName)) continue;
      const version = spec.versions.find((v) => {
        const t = tables(ctx, v);
        return !t.psets.has(psetName) && !(psetName.startsWith('Qto_') && !t.hasQuantitySets);
      });
      if (!version) continue;
      const t = tables(ctx, version);
      const near = rankCandidates(psetName, t.psetNames, { minScore: 0.6, limit: 2 }).map((c) =>
        quickFix(`Use ${c.value}`, this.code, view.facetId, c.value, [setValues(view.facetId, 'property.propertySet', [c.value])]),
      );
      const renamed = PROJECT_PREFIX + psetName.slice(psetName.indexOf('_') + 1);
      const declared = doc.meta.custom.psets.some((p) => p.name === renamed);
      const rename = quickFix(`Rename to ${renamed} (custom set)`, this.code, view.facetId, renamed, [
        ...(declared ? [] : [{ kind: 'meta.custom.declarePset' as const, payload: { decl: { name: renamed } } }]),
        setValues(view.facetId, 'property.propertySet', [renamed]),
      ]);
      out.push({ ...at(view, 'property.propertySet'), message: `${psetName} uses a reserved prefix but is not a standard set (${version})`, fixes: gated(doc, ctx, [...near, rename]) });
    }
    return out;
  },
};

function backing(t: VersionTables, dataType: string | undefined): string | undefined {
  return dataType ? t.dataTypes.get(dataType.toUpperCase())?.backingType : undefined;
}

const NUMERIC_BACKING = new Set(['xs:double', 'xs:integer', 'xs:decimal', 'xs:float']);
const NUMBER = /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/;

export const PSET_003: SpecRule = {
  code: 'IDSL-PSET-003',
  area: 'PSET',
  scope: 'spec',
  kind: 'static',
  defaultSeverity: 'warning',
  title: 'Quantity set with a non-measure data type or value',
  rationale:
    'Quantities (Qto_ sets) are always numeric measures (length, area, volume, count, weight, time). A Qto_ requirement with a text data type such as IFCLABEL, or a non-numeric value, can never be satisfied by a real quantity.',
  fix: "Use the quantity's standard data type (where the tables define it).",
  example: '<property dataType="IFCLABEL"><propertySet><simpleValue>Qto_WallBaseQuantities</simpleValue></propertySet><baseName><simpleValue>Length</simpleValue></baseName></property>',
  check(spec, { ctx, doc }) {
    const out: Finding[] = [];
    for (const { view, facet } of propertySites(spec)) {
      const psetName = single(facet.propertySet);
      if (!psetName?.startsWith('Qto_')) continue;
      const dt = single(facet.dataType);
      const t = tables(ctx, spec.versions[0]);
      const b = backing(t, dt);
      if (dt && b && !NUMERIC_BACKING.has(b)) {
        const expected = spec.versions.map((v) => standardProperty(tables(ctx, v), facet)?.prop?.dataType).find(Boolean);
        const fix = expected
          ? quickFix(`Use ${expected.toUpperCase()}`, this.code, view.facetId, 'dt', [setValues(view.facetId, 'property.dataType', [expected.toUpperCase()])])
          : undefined;
        out.push({ ...at(view, 'property.dataType'), message: `${psetName} holds numeric quantities, but the data type is ${dt.toUpperCase()} (${b})`, fixes: gated(doc, ctx, [fix]) });
        continue;
      }
      const text = literals(facet.value).filter((v) => !NUMBER.test(v.trim()));
      if (text.length) out.push({ ...at(view, 'property.value'), message: `${psetName} holds numeric quantities, but the value ${text.map((v) => `"${v}"`).join(', ')} is not a number` });
    }
    return out;
  },
};

export const PROP_001: SpecRule = {
  code: 'IDSL-PROP-001',
  area: 'PROP',
  scope: 'spec',
  kind: 'static',
  defaultSeverity: 'error',
  title: 'Property not in the standard property set',
  rationale: 'The standard set does not define this property, so no conforming model carries it there. It is usually a typo, or a property that lives in another standard set.',
  fix: 'Use the closest property of the set, or the standard set that defines this property.',
  example: '<propertySet><simpleValue>Pset_DoorCommon</simpleValue></propertySet><baseName><simpleValue>FireRatng</simpleValue></baseName>',
  check(spec, { ctx, doc }) {
    const out: Finding[] = [];
    for (const { view, facet } of propertySites(spec)) {
      const name = single(facet.baseName);
      if (!name) continue;
      const version = spec.versions.find((v) => {
        const s = standardProperty(tables(ctx, v), facet);
        return s && !s.prop;
      });
      if (!version) continue;
      const t = tables(ctx, version);
      const pset = standardProperty(t, facet)?.pset as IfcPropertySetInfo;
      const own = rankCandidates(name, pset.properties.map((p) => p.name), { minScore: 0.4, limit: 2 }).map((c) =>
        quickFix(`Use ${c.value}`, this.code, view.facetId, c.value, [setValues(view.facetId, 'property.baseName', [c.value])]),
      );
      const elsewhere = (t.psetsByProperty.get(name) ?? []).slice(0, 2).map((p) =>
        quickFix(`Use ${p}.${name}`, this.code, view.facetId, `pset|${p}`, [setValues(view.facetId, 'property.propertySet', [p])]),
      );
      out.push({ ...at(view, 'property.baseName'), message: `"${name}" is not a property of ${pset.name} (${version})`, fixes: gated(doc, ctx, [...own, ...elsewhere]) });
    }
    return out;
  },
};

const TEMPLATE_FOR_KIND: Partial<Record<IfcPropertyInfo['kind'], string>> = {
  single: 'IFCPROPERTYSINGLEVALUE',
  enumeration: 'IFCPROPERTYENUMERATEDVALUE',
  list: 'IFCPROPERTYLISTVALUE',
  bounded: 'IFCPROPERTYBOUNDEDVALUE',
  reference: 'IFCPROPERTYREFERENCEVALUE',
};

/** The standard data type of a property (IfcLabel for enumerations, as the audit). */
export function expectedDataType(prop: IfcPropertyInfo | undefined): string | undefined {
  return prop?.dataType ?? (prop?.kind === 'enumeration' ? 'IfcLabel' : undefined);
}

export const PROP_002: SpecRule = {
  code: 'IDSL-PROP-002',
  area: 'PROP',
  scope: 'spec',
  kind: 'static',
  defaultSeverity: 'warning',
  title: 'Data type differs from the standard property',
  rationale:
    'The dataType differs from the type the standard property set declares for this property. Conforming models carry the standard type, so the requirement fails on them; value comparison also follows the data type.',
  fix: 'Set the standard data type.',
  example: '<property dataType="IFCREAL"><propertySet><simpleValue>Pset_WallCommon</simpleValue></propertySet><baseName><simpleValue>IsExternal</simpleValue></baseName></property>',
  check(spec, { ctx, doc }) {
    const out: Finding[] = [];
    for (const { view, facet } of propertySites(spec)) {
      const dt = single(facet.dataType)?.toUpperCase();
      if (!dt) continue;
      for (const v of spec.versions) {
        const prop = standardProperty(tables(ctx, v), facet)?.prop;
        const expected = expectedDataType(prop)?.toUpperCase();
        if (!prop || !expected || expected === dt || TEMPLATE_FOR_KIND[prop.kind] === dt) continue;
        const fix = quickFix(`Use ${expected}`, this.code, view.facetId, expected, [setValues(view.facetId, 'property.dataType', [expected])]);
        out.push({ ...at(view, 'property.dataType'), message: `${single(facet.propertySet)}.${prop.name} is ${expected} in the standard, not ${dt} (${v})`, fixes: gated(doc, ctx, [fix]) });
        break;
      }
    }
    return out;
  },
};

function numericLooking(facet: IDSPropertyFacet): boolean {
  const c = facet.value;
  if (!c) return false;
  if (c.type === 'bounds') return [c.minInclusive, c.maxInclusive, c.minExclusive, c.maxExclusive].some((x) => x !== undefined);
  return c.type !== 'simpleValue' && !!c.base && NUMERIC_BACKING.has(c.base);
}

function standardTypeIn(ctx: LintContext, versions: IFCVersion[], facet: IDSPropertyFacet): string | undefined {
  const types = new Set(versions.map((v) => expectedDataType(standardProperty(tables(ctx, v), facet)?.prop)?.toUpperCase()));
  const [only] = types;
  return types.size === 1 ? only : undefined;
}

export const PROP_003: SpecRule = {
  code: 'IDSL-PROP-003',
  area: 'PROP',
  scope: 'spec',
  kind: 'static',
  defaultSeverity: 'info',
  title: 'Numeric constraint without a data type',
  rationale:
    'The value is a numeric range or a numeric restriction, but the property has no dataType. The data type decides how values are compared (and which unit applies), so checkers may compare such a value as text or skip it.',
  fix: "Add the standard property's data type (when the set is standard).",
  example: '<property><propertySet>…</propertySet><baseName>…</baseName><value><xs:restriction base="xs:double"><xs:minInclusive value="0"/></xs:restriction></value></property>',
  check(spec, { ctx, doc }) {
    const out: Finding[] = [];
    for (const { view, facet } of propertySites(spec)) {
      if (facet.dataType || !numericLooking(facet)) continue;
      const dt = standardTypeIn(ctx, spec.versions, facet);
      const fix = dt
        ? quickFix(`Add dataType ${dt}`, this.code, view.facetId, dt, [{ kind: 'facet.setField', payload: { facetId: view.facetId, field: 'property.dataType', value: { kind: 'equals', value: dt } } }])
        : undefined;
      out.push({ ...at(view, 'property.value'), message: `numeric value on ${single(facet.baseName) ?? 'a property'} without a dataType`, fixes: gated(doc, ctx, [fix]) });
    }
    return out;
  },
};
