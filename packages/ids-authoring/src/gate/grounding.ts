/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Grounding of LITERAL names against the per-version schema tables (§5):
 * entity (GATE-ENT-001), predefined type (GATE-PDT-001) and attribute
 * (GATE-ATT-001, including inherited attributes). Property-set grounding is
 * in `./grounding-pset.ts`.
 *
 * Only literals are grounded: a `simpleValue`, or each value of an
 * `enumeration`. Patterns and bounds on names are legal IDS and are left to
 * lint (ADR-003).
 */

import type { IDSConstraint, IDSFacet, IDSSpecification, IFCVersion } from '@ifc-lite/ids';
import type { FacetFieldName } from '../document/fields.js';
import type { CustomPsetDecl } from '../document/types.js';
import { inheritanceChain, tablesFor, type GateContext, type VersionTables } from './context.js';
import { rankCandidates } from './rank.js';
import type { GateCandidate, GateCode } from './types.js';

export interface GroundingProblem {
  code: GateCode;
  message: string;
  candidates: GateCandidate[];
  value?: string;
  versions?: IFCVersion[];
}

/** What a field check may look at besides the facet itself. */
export interface FieldScope {
  ctx: GateContext;
  spec: IDSSpecification;
  versions: IFCVersion[];
  facet: IDSFacet;
  field: FacetFieldName;
  customPsets: readonly CustomPsetDecl[];
}

/** The literal values of a constraint (simpleValue, or each enumeration value). */
export function literals(c: IDSConstraint | undefined): string[] {
  if (!c) return [];
  if (c.type === 'simpleValue') return c.value === '' ? [] : [c.value];
  if (c.type === 'enumeration') return c.values.filter((v) => v !== '');
  return [];
}

/** The single literal of a constraint, if it is a non-empty simpleValue. */
export function single(c: IDSConstraint | undefined): string | undefined {
  return c?.type === 'simpleValue' && c.value !== '' ? c.value : undefined;
}

/** Distinct, known IFC versions of a spec. */
export function specVersions(spec: IDSSpecification): IFCVersion[] {
  return [...new Set(spec.ifcVersions)];
}

/** Literal entity names in the spec's applicability. */
export function applicabilityEntities(spec: IDSSpecification): string[] {
  return spec.applicability.facets.flatMap((f) => (f.type === 'entity' ? literals(f.name) : []));
}

/**
 * Run `probe` per version and merge failures that are identical across
 * versions (same code and value) into one problem listing the versions.
 */
export function perVersion(
  versions: IFCVersion[],
  ctx: GateContext,
  probe: (tables: VersionTables, version: IFCVersion) => GroundingProblem[],
): GroundingProblem[] {
  const merged = new Map<string, GroundingProblem>();
  for (const version of versions) {
    for (const p of probe(tablesFor(ctx, version), version)) {
      const key = `${p.code}|${p.value ?? ''}`;
      const seen = merged.get(key);
      if (seen) seen.versions = [...(seen.versions ?? []), version];
      else merged.set(key, { ...p, versions: [version] });
    }
  }
  return [...merged.values()].map((p) => ({ ...p, message: `${p.message} (${(p.versions ?? []).join(', ')})` }));
}

function checkEntityName(scope: FieldScope, c: IDSConstraint | undefined): GroundingProblem[] {
  const names = literals(c);
  if (!names.length) return [];
  return perVersion(scope.versions, scope.ctx, (t) =>
    names
      .filter((n) => !t.entities.has(n.toUpperCase()))
      .map((n) => ({
        code: 'GATE-ENT-001' as const,
        message: `"${n}" is not an IFC entity`,
        value: n,
        candidates: rankCandidates(n, t.entityNames),
      })),
  );
}

function checkPredefinedType(scope: FieldScope, entity: IDSConstraint | undefined, c: IDSConstraint | undefined): GroundingProblem[] {
  const entityName = single(entity);
  const values = literals(c);
  if (!entityName || !values.length) return [];
  return perVersion(scope.versions, scope.ctx, (t) => {
    const info = t.entities.get(entityName.toUpperCase());
    // Unknown entity is reported on the name; an entity without a
    // PredefinedType enumeration in the tables cannot be checked.
    if (!info || info.predefinedTypes.length === 0) return [];
    const allowed = new Set(info.predefinedTypes.map((p) => p.toUpperCase()));
    return values
      .filter((v) => !allowed.has(v.toUpperCase()))
      .map((v) => ({
        code: 'GATE-PDT-001' as const,
        message: `"${v}" is not a predefined type of ${info.name}`,
        value: v,
        candidates: rankCandidates(v, info.predefinedTypes, { minScore: 0 }),
      }));
  });
}

function checkAttributeName(scope: FieldScope, c: IDSConstraint | undefined): GroundingProblem[] {
  const names = literals(c);
  if (!names.length) return [];
  const entities = applicabilityEntities(scope.spec);
  return perVersion(scope.versions, scope.ctx, (t) => {
    // Against the applicability entity (inherited attributes included) when
    // it is a single known literal, else against every attribute of the version.
    const chain = entities.length === 1 ? inheritanceChain(t, entities[0]) : [];
    const pool = chain.length ? new Set(chain.flatMap((e) => e.attributes)) : t.attributeNames;
    const folded = new Set([...pool].map((a) => a.toLowerCase()));
    const where = chain.length ? `on ${chain[0].name}` : 'on any IFC entity';
    return names
      .filter((n) => !folded.has(n.toLowerCase()))
      .map((n) => ({
        code: 'GATE-ATT-001' as const,
        message: `attribute "${n}" does not exist ${where}`,
        value: n,
        candidates: rankCandidates(n, pool),
      }));
  });
}

/** Entity, predefined-type and attribute grounding for one field. */
export function groundEntityFields(scope: FieldScope): GroundingProblem[] {
  const f = scope.facet;
  switch (scope.field) {
    case 'entity.name':
      return f.type === 'entity' ? checkEntityName(scope, f.name) : [];
    case 'entity.predefinedType':
      return f.type === 'entity' ? checkPredefinedType(scope, f.name, f.predefinedType) : [];
    case 'partOf.entity.name':
      return f.type === 'partOf' ? checkEntityName(scope, f.entity?.name) : [];
    case 'partOf.entity.predefinedType':
      return f.type === 'partOf' ? checkPredefinedType(scope, f.entity?.name, f.entity?.predefinedType) : [];
    case 'attribute.name':
      return f.type === 'attribute' ? checkAttributeName(scope, f.name) : [];
    default:
      return [];
  }
}
