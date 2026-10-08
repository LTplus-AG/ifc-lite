/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Predefined-type and attribute rules: IDSL-PDT-001 … 003, IDSL-ATT-001 … 002. */

import type { IFCVersion } from '@ifc-lite/ids';
import { inheritanceChain } from '../../gate/context.js';
import { rankCandidates } from '../../gate/rank.js';
import { fixIds, quickFix } from '../fix.js';
import type { Finding, LintContext, SpecRule, SpecView } from '../types.js';
import { at } from '../walk.js';
import { setValues } from './entity.js';
import { applicabilityEntityNames, entityNameSites, gated, literals, single, tables } from './util.js';

interface PdtProblem {
  site: ReturnType<typeof entityNameSites>[number];
  entity: string;
  value: string;
  enumeration: readonly string[];
  userDefinable: boolean;
}

/** Predefined-type literals outside the entity's enumeration, per site. */
function pdtProblems(spec: SpecView, ctx: LintContext, declared: (entity: string, value: string) => boolean): PdtProblem[] {
  const out: PdtProblem[] = [];
  for (const site of entityNameSites(spec)) {
    const name = single(site.constraint);
    if (!name || !site.pdt) continue;
    for (const value of literals(site.pdt)) {
      for (const v of spec.versions) {
        const info = tables(ctx, v).entities.get(name.toUpperCase());
        if (!info || info.predefinedTypes.length === 0 || info.predefinedTypes.includes(value)) continue;
        if (declared(info.name, value)) continue;
        out.push({ site, entity: info.name, value, enumeration: info.predefinedTypes, userDefinable: info.predefinedTypes.includes('USERDEFINED') });
        break;
      }
    }
  }
  return out;
}

function pdtField(field: 'entity.name' | 'partOf.entity.name'): 'entity.predefinedType' | 'partOf.entity.predefinedType' {
  return field === 'entity.name' ? 'entity.predefinedType' : 'partOf.entity.predefinedType';
}

function nearest(p: PdtProblem, code: string, n: number) {
  const field = pdtField(p.site.field);
  const ranked = rankCandidates(p.value, p.enumeration, { minScore: 0.4, limit: n });
  const exactCase = p.enumeration.find((e) => e.toUpperCase() === p.value.toUpperCase());
  const picks = exactCase ? [exactCase] : ranked.map((c) => c.value);
  return picks.map((pick) =>
    quickFix(`Use ${pick}`, code, p.site.view.facetId, `${field}|${p.value}|${pick}`, [
      setValues(p.site.view.facetId, field, literals(p.site.pdt).map((v) => (v === p.value ? pick : v))),
    ]),
  );
}

export const PDT_001: SpecRule = {
  code: 'IDSL-PDT-001',
  area: 'PDT',
  scope: 'spec',
  kind: 'static',
  defaultSeverity: 'error',
  title: 'Predefined type not in the entity enumeration',
  rationale:
    "The predefinedType is not a member of the entity's PredefinedType enumeration in this IFC version, and the enumeration has no USERDEFINED member, so no element can carry it. Predefined types are compared case-sensitively.",
  fix: 'Replace it by the closest enumeration value.',
  example: '<entity><name><simpleValue>IFCSITE</simpleValue></name><predefinedType><simpleValue>FOO</simpleValue></predefinedType></entity>',
  check(spec, { ctx, doc }) {
    return pdtProblems(spec, ctx, () => false)
      .filter((p) => !p.userDefinable)
      .map((p) => ({
        ...at(p.site.view, pdtField(p.site.field)),
        message: `"${p.value}" is not a predefined type of ${p.entity}`,
        fixes: gated(doc, ctx, nearest(p, this.code, 3)),
      }));
  },
};

export const PDT_003: SpecRule = {
  code: 'IDSL-PDT-003',
  area: 'PDT',
  scope: 'spec',
  kind: 'static',
  defaultSeverity: 'info',
  title: 'Undeclared user-defined predefined type',
  rationale:
    'The value is not in the PredefinedType enumeration, but the enumeration has USERDEFINED, so IDS matches it against the ObjectType (occurrences) or ElementType / ProcessType (types) of elements whose PredefinedType is USERDEFINED. That is valid (buildingSMART corpus: entity/pass-a_predefined_type_may_specify_a_user_defined_object_type), but it is also what a typo of an enumeration value looks like. Declaring it records that it is intentional.',
  fix: 'Replace it by the closest enumeration value, or declare it as a user-defined type in the Studio sidecar.',
  example: '<entity><name><simpleValue>IFCWALL</simpleValue></name><predefinedType><simpleValue>PARAPETT</simpleValue></predefinedType></entity>',
  check(spec, { ctx, doc }) {
    const decls = doc.meta.custom.userDefinedTypes;
    const declared = (entity: string, value: string) => decls.some((d) => d.entity.toUpperCase() === entity.toUpperCase() && d.value.toUpperCase() === value.toUpperCase());
    return pdtProblems(spec, ctx, declared)
      .filter((p) => p.userDefinable)
      .map((p) => {
        const declare = quickFix(`Declare "${p.value}" as a user-defined type of ${p.entity}`, this.code, p.site.view.facetId, `declare|${p.value}`, [
          { kind: 'meta.custom.declareUserDefinedType', payload: { entity: p.entity, value: p.value } },
        ]);
        return {
          ...at(p.site.view, pdtField(p.site.field)),
          message: `"${p.value}" is not a predefined type of ${p.entity}; it only matches user-defined types`,
          fixes: gated(doc, ctx, [...nearest(p, this.code, 2), declare]),
        };
      });
  },
};

/** The attribute holding a user-defined type for `entity`. */
function userTypeAttribute(ctx: LintContext, versions: IFCVersion[], entity: string): string | undefined {
  for (const attr of ['ObjectType', 'ElementType', 'ProcessType']) {
    if (versions.every((v) => inheritanceChain(tables(ctx, v), entity).some((e) => e.attributes.includes(attr)))) return attr;
  }
  return undefined;
}

export const PDT_002: SpecRule = {
  code: 'IDSL-PDT-002',
  area: 'PDT',
  scope: 'spec',
  kind: 'static',
  defaultSeverity: 'info',
  title: 'USERDEFINED predefined type without an ObjectType requirement',
  rationale:
    'An element with PredefinedType USERDEFINED is meant to say what it is in ObjectType (ElementType for types, ProcessType for process types). A specification that selects USERDEFINED elements without requiring that attribute accepts elements that never say what they are (IDS issues #178, #447).',
  fix: 'Add a requirement that the ObjectType (or ElementType / ProcessType) attribute is present.',
  references: ['https://github.com/buildingSMART/IDS/issues/178', 'https://github.com/buildingSMART/IDS/issues/447'],
  example: '<entity><name><simpleValue>IFCWALL</simpleValue></name><predefinedType><simpleValue>USERDEFINED</simpleValue></predefinedType></entity>',
  check(spec, { ctx, doc }) {
    const out: Finding[] = [];
    const attrs = new Set(
      [...spec.applicability, ...spec.requirements].flatMap((f) => (f.facet.type === 'attribute' ? literals(f.facet.name).map((n) => n.toLowerCase()) : [])),
    );
    for (const view of spec.applicability) {
      if (view.facet.type !== 'entity' || !literals(view.facet.predefinedType).includes('USERDEFINED')) continue;
      const entity = single(view.facet.name);
      const attr = entity ? userTypeAttribute(ctx, spec.versions, entity) : undefined;
      if (!attr || attrs.has(attr.toLowerCase())) continue;
      const fix = quickFix(`Require ${attr}`, this.code, view.facetId, attr, [
        {
          kind: 'facet.add',
          payload: {
            specId: spec.specId,
            section: 'requirements',
            facetId: fixIds(this.code, view.facetId, 'facet')(),
            facet: { type: 'attribute', name: { kind: 'equals', value: attr } },
          },
        },
      ]);
      out.push({ ...at(view, 'entity.predefinedType'), message: `USERDEFINED elements are selected but ${attr} is not required`, fixes: gated(doc, ctx, [fix]) });
    }
    return out;
  },
};

export const ATT_001: SpecRule = {
  code: 'IDSL-ATT-001',
  area: 'ATT',
  scope: 'spec',
  kind: 'static',
  defaultSeverity: 'error',
  title: 'Attribute not defined on the entity',
  rationale:
    'The attribute does not exist on any applicability entity, including inherited attributes, so an attribute requirement always fails and an attribute applicability selects nothing. Attribute names are the EXPRESS names (Name, Description, ObjectType, Tag, …).',
  fix: 'Replace it by the closest attribute of the entity.',
  example: '<entity><name><simpleValue>IFCWALL</simpleValue></name></entity> + <attribute><name><simpleValue>Nmae</simpleValue></name></attribute>',
  check(spec, { ctx, doc }) {
    const entities = applicabilityEntityNames(spec);
    if (!entities.length) return [];
    const out: Finding[] = [];
    for (const view of [...spec.applicability, ...spec.requirements]) {
      if (view.facet.type !== 'attribute') continue;
      const facet = view.facet;
      for (const name of literals(facet.name)) {
        for (const v of spec.versions) {
          const t = tables(ctx, v);
          const chains = entities.map((e) => inheritanceChain(t, e));
          if (chains.some((c) => c.length === 0)) continue; // unknown entity: the audit reports it
          const pool = [...new Set(chains.flatMap((c) => c.flatMap((e) => e.attributes)))];
          if (pool.some((a) => a.toLowerCase() === name.toLowerCase())) continue;
          const picks = rankCandidates(name, pool, { minScore: 0.4, limit: 3 }).map((c) => c.value);
          const fixes = picks.map((p) =>
            quickFix(`Use ${p}`, this.code, view.facetId, `${name}|${p}`, [setValues(view.facetId, 'attribute.name', literals(facet.name).map((x) => (x === name ? p : x)))]),
          );
          out.push({ ...at(view, 'attribute.name'), message: `attribute "${name}" is not defined on ${chains.map((c) => c[0].name).join(' / ')} (${v})`, fixes: gated(doc, ctx, fixes) });
          break;
        }
      }
    }
    return out;
  },
};

export const ATT_002: SpecRule = {
  code: 'IDSL-ATT-002',
  area: 'ATT',
  scope: 'spec',
  kind: 'static',
  defaultSeverity: 'warning',
  title: 'Value check on an entity-typed attribute',
  rationale:
    'The attribute holds a reference to another entity (for example ObjectPlacement or OwnerHistory), not a simple value, so a value constraint on it cannot match. Only its existence can be checked.',
  fix: 'Remove the value so the facet checks existence only.',
  example: '<attribute><name><simpleValue>ObjectPlacement</simpleValue></name><value><simpleValue>x</simpleValue></value></attribute>',
  check(spec, { ctx, doc }) {
    const entities = applicabilityEntityNames(spec);
    if (entities.length !== 1) return [];
    const out: Finding[] = [];
    for (const view of [...spec.applicability, ...spec.requirements]) {
      if (view.facet.type !== 'attribute' || !view.facet.value) continue;
      const name = single(view.facet.name);
      if (!name) continue;
      const complex = spec.versions.find((v) => {
        const meta = ctx.attributes[v].get(name.toLowerCase());
        const chain = inheritanceChain(tables(ctx, v), entities[0]).map((e) => e.name.toUpperCase());
        return !!meta && !chain.some((e) => meta.simpleValueEntities.includes(e)) && chain.some((e) => meta.complexEntities.includes(e));
      });
      if (!complex) continue;
      const fix = quickFix('Check existence only', this.code, view.facetId, 'value', [
        { kind: 'facet.setField', payload: { facetId: view.facetId, field: 'attribute.value', value: null } },
      ]);
      out.push({ ...at(view, 'attribute.value'), message: `${name} is an entity-typed attribute in ${complex}; its value cannot be compared`, fixes: gated(doc, ctx, [fix]) });
    }
    return out;
  },
};
