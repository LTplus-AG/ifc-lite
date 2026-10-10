/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Entity rules IDSL-ENT-001 … 005. */

import type { FacetFieldName } from '../../document/fields.js';
import type { ValueInput } from '../../ops/types.js';
import type { Uuid } from '../../uuid.js';
import { quickFix, type OpBody } from '../fix.js';
import type { Finding, SpecRule } from '../types.js';
import { at } from '../walk.js';
import {
  canonicalEntity,
  concreteDescendants,
  entityNameSites,
  gated,
  isSubtypeOf,
  listSome,
  literals,
  replaceLiteral,
  tables,
} from './util.js';

export function setValues(facetId: Uuid, field: FacetFieldName, values: readonly string[]): OpBody {
  const value: ValueInput = values.length === 1 ? { kind: 'equals', value: values[0] } : { kind: 'oneOf', values: [...values] };
  return { kind: 'value.set', payload: { facetId, field, value } };
}

/** Above this many subtypes the expansion is not offered as a fix. */
const MAX_EXPANSION = 120;

export const ENT_001: SpecRule = {
  code: 'IDSL-ENT-001',
  area: 'ENT',
  scope: 'spec',
  kind: 'static',
  defaultSeverity: 'error',
  title: 'Abstract entity in an entity facet',
  rationale:
    'IDS 1.0 entity facets match the exact class, never its subtypes. An abstract class such as IfcBuildingElement is never instantiated, so a facet naming it matches no element at all: an applicability selects nothing and a requirement always fails.',
  fix: 'Replace the abstract class by an enumeration of its concrete subtypes (those concrete in every IFC version of the specification).',
  assumptions: [
    {
      id: 'A-03',
      verified:
        'buildingSMART corpus case entity/invalid-subclasses_are_not_considered_as_matching (IFCWALL does not match an IFCWALLSTANDARDCASE instance) and the exact-match entity checker in @ifc-lite/ids (checkEntityFacet), which cites the IDS user manual: "There is no automatic inheritance in IDS entity facet interpretation".',
    },
  ],
  references: ['https://github.com/buildingSMART/IDS/blob/development/Documentation/UserManual/entity-facet.md'],
  example: '<entity><name><simpleValue>IFCBUILDINGELEMENT</simpleValue></name></entity>',
  check(spec, { ctx, doc }) {
    const out: Finding[] = [];
    for (const site of entityNameSites(spec)) {
      for (const name of literals(site.constraint)) {
        const abstractIn = spec.versions.filter((v) => tables(ctx, v).entities.get(name.toUpperCase())?.abstract);
        if (!abstractIn.length) continue;
        const subtypes = concreteDescendants(ctx, spec.versions, name);
        const canonical = canonicalEntity(ctx, spec.versions, name) ?? name;
        const fix =
          subtypes.length && subtypes.length <= MAX_EXPANSION
            ? quickFix(`Expand to ${subtypes.length} concrete subtypes`, this.code, site.view.facetId, `${site.field}|${name}`, [
                setValues(site.view.facetId, site.field, replaceLiteral(site.constraint, name, subtypes)),
              ])
            : undefined;
        out.push({
          ...at(site.view, site.field),
          message: `${canonical} is abstract (${abstractIn.join(', ')}) and matches no element; IDS does not match subtypes${subtypes.length ? ` such as ${listSome(subtypes, 3)}` : ''}`,
          fixes: gated(doc, ctx, [fix]),
        });
      }
    }
    return out;
  },
};

/** Removed in IFC4X3 with a direct replacement: the parent class. */
const REPLACED_SUFFIX = /(StandardCase|ElementedCase)$/;

export const ENT_002: SpecRule = {
  code: 'IDSL-ENT-002',
  area: 'ENT',
  scope: 'spec',
  kind: 'static',
  defaultSeverity: 'info',
  title: 'Entity removed in IFC4X3',
  rationale:
    'The entity exists in the IFC versions this specification targets but was removed in IFC4X3 (for example IfcWallElementedCase or IfcBeamStandardCase, whose instances are plain IfcWall / IfcBeam in IFC4X3). Requirements written against it will not carry over when the specification is retargeted.',
  fix: 'Also match the IFC4X3 replacement (the parent class), keeping the original name so older models still match.',
  example: '<specification ifcVersion="IFC4"> … <entity><name><simpleValue>IFCBEAMSTANDARDCASE</simpleValue></name></entity>',
  check(spec, { ctx, doc }) {
    if (spec.versions.some((v) => v.startsWith('IFC4X3'))) return [];
    const ifc4x3 = tables(ctx, 'IFC4X3');
    const out: Finding[] = [];
    for (const site of entityNameSites(spec)) {
      for (const name of literals(site.constraint)) {
        const canonical = canonicalEntity(ctx, spec.versions, name);
        if (!canonical || ifc4x3.entities.has(name.toUpperCase())) continue;
        const info = tables(ctx, spec.versions[0]).entities.get(name.toUpperCase());
        const parent = REPLACED_SUFFIX.test(canonical) && info?.parent && ifc4x3.entities.has(info.parent.toUpperCase()) ? info.parent : undefined;
        const fix = parent
          ? quickFix(`Also match ${parent}`, this.code, site.view.facetId, `${site.field}|${name}`, [
              setValues(site.view.facetId, site.field, replaceLiteral(site.constraint, name, [name, parent])),
            ])
          : undefined;
        const already = parent && literals(site.constraint).some((v) => v.toUpperCase() === parent.toUpperCase());
        if (already) continue;
        out.push({
          ...at(site.view, site.field),
          message: `${canonical} does not exist in IFC4X3${parent ? `; IFC4X3 models use ${parent}` : ''}`,
          fixes: gated(doc, ctx, [fix]),
        });
      }
    }
    return out;
  },
};

export const ENT_003: SpecRule = {
  code: 'IDSL-ENT-003',
  area: 'ENT',
  scope: 'spec',
  kind: 'static',
  defaultSeverity: 'info',
  title: 'Entity has subtypes the author may also mean',
  rationale:
    'An applicability entity matches only that exact class. Concrete subtypes (IfcWallStandardCase and IfcWallElementedCase for IfcWall in IFC4, IfcSlabStandardCase for IfcSlab, …) are not selected unless listed. This is often intended, but frequently it is not.',
  fix: 'Add the concrete subtypes to the entity enumeration.',
  example: '<applicability><entity><name><simpleValue>IFCWALL</simpleValue></name></entity></applicability> (IFC4)',
  check(spec, { ctx, doc }) {
    const out: Finding[] = [];
    for (const view of spec.applicability) {
      if (view.facet.type !== 'entity') continue;
      const listed = literals(view.facet.name);
      const listedUpper = new Set(listed.map((n) => n.toUpperCase()));
      for (const name of listed) {
        if (spec.versions.some((v) => tables(ctx, v).entities.get(name.toUpperCase())?.abstract !== false)) continue;
        const missing = concreteDescendants(ctx, spec.versions, name).filter((s) => !listedUpper.has(s.toUpperCase()));
        if (!missing.length) continue;
        const canonical = canonicalEntity(ctx, spec.versions, name) ?? name;
        const fix = quickFix(`Add ${listSome(missing, 3)}`, this.code, view.facetId, name, [
          setValues(view.facetId, 'entity.name', replaceLiteral(view.facet.name, name, [name, ...missing])),
        ]);
        out.push({
          ...at(view, 'entity.name'),
          message: `${canonical} does not select its subtypes ${listSome(missing)}`,
          fixes: gated(doc, ctx, [fix]),
        });
      }
    }
    return out;
  },
};

const NOT_FOR_TYPES = new Set(['IfcRelContainedInSpatialStructure', 'IfcRelVoidsElement', 'IfcRelFillsElement']);

export const ENT_004: SpecRule = {
  code: 'IDSL-ENT-004',
  area: 'ENT',
  scope: 'spec',
  kind: 'static',
  defaultSeverity: 'warning',
  title: 'Type entity where an occurrence is meant',
  rationale:
    'The applicability selects a type object (an IfcTypeObject subtype such as IfcDoorType) but the specification also uses a spatial containment, voiding or filling relation. Type objects are never contained in a storey, voided or filled; only occurrences are. Note that occurrences inherit the properties of their type, so checking the occurrence also covers type-level properties.',
  fix: 'Switch the applicability to the occurrence class.',
  example: '<entity><name><simpleValue>IFCDOORTYPE</simpleValue></name></entity> + <partOf relation="IFCRELCONTAINEDINSPATIALSTRUCTURE">',
  check(spec, { ctx, doc }) {
    const relation = [...spec.applicability, ...spec.requirements].find((f) => f.facet.type === 'partOf' && NOT_FOR_TYPES.has(f.facet.relation));
    if (!relation || relation.facet.type !== 'partOf') return [];
    const out: Finding[] = [];
    for (const view of spec.applicability) {
      if (view.facet.type !== 'entity') continue;
      for (const name of literals(view.facet.name)) {
        if (!spec.versions.every((v) => isSubtypeOf(tables(ctx, v), name, 'IfcTypeObject'))) continue;
        const occurrence = occurrenceOf(spec.versions.map((v) => tables(ctx, v)), name);
        const canonical = canonicalEntity(ctx, spec.versions, name) ?? name;
        const fix = occurrence
          ? quickFix(`Use ${occurrence}`, this.code, view.facetId, name, [setValues(view.facetId, 'entity.name', replaceLiteral(view.facet.name, name, [occurrence]))])
          : undefined;
        out.push({
          ...at(view, 'entity.name'),
          message: `${canonical} is a type object and cannot take part in ${relation.facet.relation}${occurrence ? `; did you mean ${occurrence}?` : ''}`,
          fixes: gated(doc, ctx, [fix]),
        });
      }
    }
    return out;
  },
};

/** The occurrence class whose companion type is `typeName`, in every version. */
function occurrenceOf(all: ReturnType<typeof tables>[], typeName: string): string | undefined {
  const upper = typeName.toUpperCase();
  let found: string | undefined;
  for (const t of all) {
    let hit: string | undefined;
    for (const e of t.entities.values()) {
      if (e.typeEntity?.toUpperCase() === upper) hit = e.name;
    }
    if (!hit && upper.endsWith('TYPE') && t.entities.has(upper.slice(0, -4))) hit = t.entities.get(upper.slice(0, -4))?.name;
    if (!hit || (found && found !== hit)) return undefined;
    found = hit;
  }
  return found;
}

export const ENT_005: SpecRule = {
  code: 'IDSL-ENT-005',
  area: 'ENT',
  scope: 'spec',
  kind: 'static',
  defaultSeverity: 'warning',
  title: 'Entity name not in upper case',
  rationale:
    'IDS 1.0 writes entity names in upper case (IFCWALL). Some checkers compare names case-insensitively and others reject mixed case (the buildingSMART corpus case entity/invalid-entities_must_be_specified_as_uppercase_strings), so a mixed-case name behaves differently across tools.',
  fix: 'Rewrite the name in upper case.',
  example: '<entity><name><simpleValue>IfcWall</simpleValue></name></entity>',
  check(spec, { ctx, doc }) {
    const out: Finding[] = [];
    for (const site of entityNameSites(spec)) {
      const values = literals(site.constraint);
      const lower = values.filter((v) => v !== v.toUpperCase());
      if (!lower.length) continue;
      const fix = quickFix('Use upper case', this.code, site.view.facetId, site.field, [
        setValues(site.view.facetId, site.field, values.map((v) => v.toUpperCase())),
      ]);
      out.push({ ...at(site.view, site.field), message: `entity name ${lower.map((v) => `"${v}"`).join(', ')} is not upper case`, fixes: gated(doc, ctx, [fix]) });
    }
    return out;
  },
};
