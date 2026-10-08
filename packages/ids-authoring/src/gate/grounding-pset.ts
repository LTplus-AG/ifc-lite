/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Property grounding (§5): standard set (GATE-PSET-001), property
 * (GATE-PROP-001), enumeration value (GATE-ENUM-001), dataType
 * (GATE-DT-001) and custom-set declarations (GATE-CUST-00x).
 *
 * A set name with a reserved prefix (`Pset_`, `Qto_`) must be a standard
 * set of every IFC version of the spec. Any other literal set name is a
 * CUSTOM set and must be declared (`meta.custom.declarePset`, or the
 * context's library) so a typo of a standard name cannot slip through as
 * "custom".
 */

import { RESERVED_PSET_PREFIXES, type IfcPropertyInfo, type IfcPropertySetInfo } from '@ifc-lite/data';
import type { IDSPropertyFacet } from '@ifc-lite/ids';
import type { CustomPsetDecl } from '../document/types.js';
import { inheritanceChain, type VersionTables } from './context.js';
import { applicabilityEntities, literals, perVersion, single, type FieldScope, type GroundingProblem } from './grounding.js';
import { rankCandidates } from './rank.js';

export function isReservedPsetName(name: string): boolean {
  return RESERVED_PSET_PREFIXES.some((p) => name.startsWith(p));
}

function declaredCustom(scope: FieldScope, name: string): CustomPsetDecl | undefined {
  return scope.customPsets.find((d) => d.name === name) ?? scope.ctx.custom.find((d) => d.name === name);
}

/** Boost sets applicable to the applicability entities (or their supertypes). */
function applicableBoost(t: VersionTables, entities: string[]) {
  const ancestors = new Set(entities.flatMap((e) => inheritanceChain(t, e).map((x) => x.name.toUpperCase())));
  return (name: string) => {
    const pset = t.psets.get(name);
    if (!pset || !ancestors.size) return undefined;
    const hit = pset.applicableEntities.find((a) => ancestors.has(a.toUpperCase()));
    return hit ? { boost: 0.25, reason: `applicable to ${entities.join(', ')}` } : undefined;
  };
}

function checkPropertySet(scope: FieldScope, facet: IDSPropertyFacet): GroundingProblem[] {
  const names = literals(facet.propertySet);
  const entities = applicabilityEntities(scope.spec);
  const custom = names.filter((n) => !isReservedPsetName(n) && !declaredCustom(scope, n));
  const out: GroundingProblem[] = [];
  if (custom.length) {
    // Version-independent: suggest the closest standard names of the first version.
    const t = scope.ctx.tables[scope.versions[0]];
    for (const n of custom) {
      out.push({
        code: 'GATE-CUST-001',
        message: `"${n}" is not a standard property set and is not declared as custom; declare it with meta.custom.declarePset or use a standard set`,
        value: n,
        candidates: rankCandidates(n, t.psetNames, { boost: applicableBoost(t, entities) }),
      });
    }
  }
  const reserved = names.filter(isReservedPsetName);
  out.push(
    ...perVersion(scope.versions, scope.ctx, (t) =>
      reserved
        .filter((n) => !t.psets.has(n) && !(n.startsWith('Qto_') && !t.hasQuantitySets))
        .map((n) => ({
          code: 'GATE-PSET-001' as const,
          message: `"${n}" uses a reserved prefix but is not a standard ${n.startsWith('Qto_') ? 'quantity' : 'property'} set`,
          value: n,
          candidates: rankCandidates(n, t.psetNames, { boost: applicableBoost(t, entities) }),
        })),
    ),
  );
  return out;
}

function standardProperty(t: VersionTables, facet: IDSPropertyFacet): { pset: IfcPropertySetInfo; prop?: IfcPropertyInfo; name?: string } | undefined {
  const psetName = single(facet.propertySet);
  const pset = psetName ? t.psets.get(psetName) : undefined;
  if (!pset) return undefined;
  const name = single(facet.baseName);
  return { pset, name, prop: name ? pset.properties.find((p) => p.name === name) : undefined };
}

function checkBaseName(scope: FieldScope, facet: IDSPropertyFacet): GroundingProblem[] {
  const names = literals(facet.baseName);
  const psetName = single(facet.propertySet);
  if (!names.length || !psetName) return [];
  const decl = declaredCustom(scope, psetName);
  if (decl && !isReservedPsetName(psetName)) {
    if (!decl.properties) return [];
    const allowed = decl.properties.map((p) => p.name);
    return names
      .filter((n) => !allowed.includes(n))
      .map((n) => ({
        code: 'GATE-CUST-003' as const,
        message: `"${n}" is not declared in custom property set ${psetName}`,
        value: n,
        candidates: rankCandidates(n, allowed, { minScore: 0 }),
      }));
  }
  return perVersion(scope.versions, scope.ctx, (t) => {
    const pset = t.psets.get(psetName);
    if (!pset) return []; // reported on propertySet (or an unverifiable Qto_)
    const own = pset.properties.map((p) => p.name);
    return names
      .filter((n) => !own.includes(n))
      .map((n) => {
        const elsewhere = (t.psetsByProperty.get(n) ?? []).slice(0, 3).map((other) => ({ value: `${other}.${n}`, score: 1, reason: `${n} is defined in ${other}` }));
        return {
          code: 'GATE-PROP-001' as const,
          message: `"${n}" is not a property of ${psetName}`,
          value: n,
          candidates: [...rankCandidates(n, own), ...elsewhere],
        };
      });
  });
}

/** IDS template type names accepted as dataType for a property kind (mirrors the audit). */
const TEMPLATE_DATATYPE: Partial<Record<IfcPropertyInfo['kind'], string>> = {
  single: 'IFCPROPERTYSINGLEVALUE',
  enumeration: 'IFCPROPERTYENUMERATEDVALUE',
  list: 'IFCPROPERTYLISTVALUE',
  bounded: 'IFCPROPERTYBOUNDEDVALUE',
  reference: 'IFCPROPERTYREFERENCEVALUE',
};

function checkDataType(scope: FieldScope, facet: IDSPropertyFacet): GroundingProblem[] {
  const dt = single(facet.dataType);
  if (!dt) return [];
  const upper = dt.toUpperCase();
  return perVersion(scope.versions, scope.ctx, (t) => {
    if (!t.dataTypes.has(upper)) {
      return [{ code: 'GATE-DT-001' as const, message: `"${dt}" is not an IFC data type`, value: dt, candidates: rankCandidates(dt, [...t.dataTypes.keys()]) }];
    }
    const prop = standardProperty(t, facet)?.prop;
    const expected = prop?.dataType ?? (prop?.kind === 'enumeration' ? 'IfcLabel' : undefined);
    if (!prop || !expected || expected.toUpperCase() === upper || TEMPLATE_DATATYPE[prop.kind] === upper) return [];
    return [
      {
        code: 'GATE-DT-001' as const,
        message: `${single(facet.propertySet)}.${prop.name} is typed ${expected.toUpperCase()} in the standard, not ${upper}`,
        value: dt,
        candidates: [{ value: expected.toUpperCase(), score: 1, reason: 'standard data type' }],
      },
    ];
  });
}

function checkEnumValue(scope: FieldScope, facet: IDSPropertyFacet): GroundingProblem[] {
  const values = literals(facet.value);
  if (!values.length) return [];
  return perVersion(scope.versions, scope.ctx, (t) => {
    const prop = standardProperty(t, facet)?.prop;
    const allowed = prop?.kind === 'enumeration' ? prop.enumeration : undefined;
    if (!prop || !allowed?.length) return [];
    return values
      .filter((v) => !allowed.includes(v))
      .map((v) => {
        const folded = allowed.find((a) => a.toLowerCase() === v.toLowerCase());
        const ranked = rankCandidates(v, allowed, { minScore: 0 });
        return {
          code: 'GATE-ENUM-001' as const,
          message: `"${v}" is not a value of ${single(facet.propertySet)}.${prop.name}`,
          value: v,
          candidates: folded ? [{ value: folded, score: 1, reason: 'same value, different case' }, ...ranked.filter((c) => c.value !== folded)] : ranked,
        };
      });
  });
}

/** Property-facet grounding for one field. */
export function groundPropertyFields(scope: FieldScope): GroundingProblem[] {
  const f = scope.facet;
  if (f.type !== 'property') return [];
  switch (scope.field) {
    case 'property.propertySet':
      return checkPropertySet(scope, f);
    case 'property.baseName':
      return checkBaseName(scope, f);
    case 'property.dataType':
      return checkDataType(scope, f);
    case 'property.value':
      return checkEnumValue(scope, f);
    default:
      return [];
  }
}
