/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * IFC schema cross-checks for an IDS document.
 *
 * Backed by the full per-IFC-version schema tables in `@ifc-lite/data`
 * (generated from buildingSMART/IDS-Audit-tool's `SchemaInfo.*.g.cs`):
 *
 *  - 771 entities for IFC2X3, 932 for IFC4, 1008 for IFC4X3
 *  - 1485 property sets covering 7624 properties total
 *  - 18 partOf relation rows (6 per version)
 *
 * Verifies that entity names, predefined types, property sets, properties,
 * attributes and partOf relations referenced in facets actually exist in
 * the IFC version declared on each specification.
 */

import {
  findAttribute,
  findDataType,
  findEntity,
  findPropertySet,
  getInheritanceChain,
  getPartOfRelations,
  getPropertySets,
  isEntitySubtypeOf,
  RESERVED_PSET_PREFIXES,
  type IfcEntityInfo,
  type IfcPropertyInfo,
  type IfcSchemaVersion,
} from '@ifc-lite/data';

import type {
  IDSDocument,
  IDSEntityFacet,
  IDSFacet,
  IDSSpecification,
  IFCVersion,
} from '../../types.js';
import type { IDSAuditIssue, IDSAuditOptions } from '../types.js';

export async function runIfcSchemaAudit(
  doc: IDSDocument,
  options: Pick<IDSAuditOptions, 'ifcVersion'>
): Promise<IDSAuditIssue[]> {
  const issues: IDSAuditIssue[] = [];
  for (let i = 0; i < doc.specifications.length; i++) {
    const spec = doc.specifications[i];
    const versions = pickVersions(spec, options.ifcVersion);
    if (versions.length === 0) continue; // XSD audit will already have flagged this
    // IDS specs apply to *every* listed `@ifcVersion`. A constraint
    // valid in IFC2X3 but not in IFC4 must surface even when IFC2X3
    // appears first. Walk each version and dedupe issues that fire
    // identically across them (same code + path) — only carry the
    // first version's `detail` so reports stay readable.
    const seen = new Set<string>();
    for (const version of versions) {
      const perVersion: IDSAuditIssue[] = [];
      await auditSpec(spec, version, `specifications[${i}]`, perVersion);
      for (const iss of perVersion) {
        const key = `${iss.code}|${iss.path}|${iss.message}`;
        if (seen.has(key)) continue;
        seen.add(key);
        issues.push(iss);
      }
    }
  }
  return issues;
}

function pickVersions(
  spec: IDSSpecification,
  override?: IFCVersion
): IfcSchemaVersion[] {
  if (override) {
    const n = normaliseSchemaVersion(override);
    return n ? [n] : [];
  }
  const out: IfcSchemaVersion[] = [];
  const seen = new Set<IfcSchemaVersion>();
  for (const v of spec.ifcVersions) {
    const n = normaliseSchemaVersion(v);
    if (n && !seen.has(n)) {
      seen.add(n);
      out.push(n);
    }
  }
  return out;
}

function normaliseSchemaVersion(v: IFCVersion): IfcSchemaVersion | undefined {
  switch (v) {
    case 'IFC2X3':
    case 'IFC4':
    case 'IFC4X3':
    case 'IFC4X3_ADD2':
      return v;
    default:
      return undefined;
  }
}

async function auditSpec(
  spec: IDSSpecification,
  version: IfcSchemaVersion,
  basePath: string,
  issues: IDSAuditIssue[]
): Promise<void> {
  // The applicability block can declare an entity facet that requirement
  // facets (attribute / property) need to cross-check against.
  const applicabilityEntity = spec.applicability.facets.find(
    (f): f is IDSEntityFacet => f.type === 'entity'
  );

  for (let fi = 0; fi < spec.applicability.facets.length; fi++) {
    const facet = spec.applicability.facets[fi];
    await auditFacet(
      facet,
      version,
      `${basePath}.applicability.facets[${fi}]`,
      applicabilityEntity,
      issues
    );
  }

  for (let ri = 0; ri < spec.requirements.length; ri++) {
    const req = spec.requirements[ri];
    await auditFacet(
      req.facet,
      version,
      `${basePath}.requirements[${ri}]`,
      applicabilityEntity,
      issues
    );
  }
}

async function auditFacet(
  facet: IDSFacet,
  version: IfcSchemaVersion,
  path: string,
  applicabilityEntity: IDSEntityFacet | undefined,
  issues: IDSAuditIssue[]
): Promise<void> {
  switch (facet.type) {
    case 'entity':
      await auditEntityFacet(facet, version, path, issues);
      break;
    case 'property':
      await auditPropertyFacet(
        facet,
        version,
        path,
        applicabilityEntity,
        issues
      );
      break;
    case 'attribute':
      await auditAttributeFacet(
        facet,
        version,
        path,
        applicabilityEntity,
        issues
      );
      break;
    case 'partOf':
      await auditPartOfFacet(facet, version, path, applicabilityEntity, issues);
      break;
    case 'classification':
      await auditClassificationFacet(version, applicabilityEntity, path, issues);
      break;
    case 'material':
      await auditMaterialFacet(version, applicabilityEntity, path, issues);
      break;
  }
}

/**
 * Classification facets bind via `IfcRelAssociatesClassification`,
 * which only accepts subtypes of `IfcObjectDefinition` (IFC4+) or
 * `IfcRoot` (IFC2X3). Applicability entities outside that hierarchy —
 * e.g. `IfcCurve`, `IfcGeometricRepresentationItem` — can never be
 * classified. Mirrors upstream `schema.GetRelAsssignClassificationClasses`.
 */
async function auditClassificationFacet(
  version: IfcSchemaVersion,
  applicabilityEntity: IDSEntityFacet | undefined,
  path: string,
  issues: IDSAuditIssue[]
): Promise<void> {
  if (!applicabilityEntity) return;
  if (applicabilityEntity.name.type !== 'simpleValue') return;
  const entityName = applicabilityEntity.name.value;
  if (!entityName) return;
  // IFC4 / IFC4X3 use IfcObjectDefinition; IFC2X3 uses IfcRoot.
  const expected = version === 'IFC2X3' ? 'IfcRoot' : 'IfcObjectDefinition';
  const ok = await isEntitySubtypeOf(version, entityName, expected);
  if (!ok) {
    issues.push({
      severity: 'error',
      code: 'E_IFC_PARTOF_ENTITY',
      message: `applicability entity "${entityName}" cannot be classified in ${version} (must be a subtype of ${expected})`,
      path,
      facetType: 'classification',
      detail: { value: entityName, required: expected, version },
    });
  }
}

async function auditMaterialFacet(
  version: IfcSchemaVersion,
  applicabilityEntity: IDSEntityFacet | undefined,
  path: string,
  issues: IDSAuditIssue[]
): Promise<void> {
  if (!applicabilityEntity) return;
  if (applicabilityEntity.name.type !== 'simpleValue') return;
  const entityName = applicabilityEntity.name.value;
  if (!entityName) return;
  // Same rule as classification — material associations require a
  // subtype of IfcObjectDefinition (IFC4+) / IfcRoot (IFC2X3).
  const expected = version === 'IFC2X3' ? 'IfcRoot' : 'IfcObjectDefinition';
  const ok = await isEntitySubtypeOf(version, entityName, expected);
  if (!ok) {
    issues.push({
      severity: 'error',
      code: 'E_IFC_PARTOF_ENTITY',
      message: `applicability entity "${entityName}" cannot have a material in ${version} (must be a subtype of ${expected})`,
      path,
      facetType: 'material',
      detail: { value: entityName, required: expected, version },
    });
  }
}

async function auditEntityFacet(
  facet: IDSEntityFacet,
  version: IfcSchemaVersion,
  path: string,
  issues: IDSAuditIssue[]
): Promise<void> {
  if (facet.name.type !== 'simpleValue') {
    // Pattern / enumeration / bounds: cross-check is impossible without
    // resolving every match, so we skip — a regex like `IFC.*` is valid.
    return;
  }
  const name = facet.name.value;
  if (!name) return;

  const entity = await findEntity(version, name);
  if (!entity) {
    issues.push({
      severity: 'error',
      code: 'E_IFC_ENTITY_UNKNOWN',
      message: `entity name "${name}" is not a known IFC entity for ${version}`,
      path: `${path}.name`,
      facetType: 'entity',
      detail: { value: name, version },
    });
    return;
  }
  if (facet.predefinedType && entity.predefinedTypes.length > 0) {
    checkPredefinedType(
      facet.predefinedType,
      entity,
      version,
      `${path}.predefinedType`,
      issues
    );
  }
}

function checkPredefinedType(
  c: import('../../types.js').IDSConstraint,
  entity: IfcEntityInfo,
  version: IfcSchemaVersion,
  path: string,
  issues: IDSAuditIssue[]
): void {
  const valid = (v: string): boolean =>
    entity.predefinedTypes.includes(v.toUpperCase());
  switch (c.type) {
    case 'simpleValue': {
      const v = c.value;
      if (v && !valid(v)) {
        issues.push({
          severity: 'error',
          code: 'E_IFC_PREDEF_TYPE_INVALID',
          message: `predefined type "${v}" is not valid for ${entity.name} (${version})`,
          path,
          facetType: 'entity',
          detail: { value: v, entity: entity.name, version },
        });
      }
      break;
    }
    case 'enumeration': {
      for (const v of c.values) {
        if (v && !valid(v)) {
          issues.push({
            severity: 'error',
            code: 'E_IFC_PREDEF_TYPE_INVALID',
            message: `predefined type enumeration value "${v}" is not valid for ${entity.name} (${version})`,
            path,
            facetType: 'entity',
            detail: { value: v, entity: entity.name, version },
          });
        }
      }
      break;
    }
    case 'pattern': {
      // If the pattern compiles, test each known predefined type to be
      // sure at least one matches. Otherwise warn (pattern syntax check
      // already produces W_REGEX_UNVERIFIED).
      try {
        const rx = new RegExp(`^${c.pattern}$`);
        const anyMatch = entity.predefinedTypes.some((p) => rx.test(p));
        if (!anyMatch) {
          issues.push({
            severity: 'error',
            code: 'E_IFC_PREDEF_TYPE_INVALID',
            message: `predefined type pattern "${c.pattern}" matches no value for ${entity.name} (${version})`,
            path,
            facetType: 'entity',
            detail: { pattern: c.pattern, entity: entity.name, version },
          });
        }
      } catch {
        /* coherence pass already warned */
      }
      break;
    }
    case 'bounds':
      // Bounds make no sense on a predefined-type enum — XSD audit will
      // already have flagged the structural mismatch indirectly.
      break;
  }
}

async function auditPropertyFacet(
  facet: Extract<IDSFacet, { type: 'property' }>,
  version: IfcSchemaVersion,
  path: string,
  applicabilityEntity: IDSEntityFacet | undefined,
  issues: IDSAuditIssue[]
): Promise<void> {
  // Always cross-check the @dataType when present, even before pset
  // existence — an invalid IFC dataType is its own error class.
  if (facet.dataType && facet.dataType.type === 'simpleValue') {
    const dt = facet.dataType.value;
    if (dt) {
      const found = await findDataType(version, dt);
      if (!found) {
        issues.push({
          severity: 'error',
          code: 'E_IFC_DATATYPE_UNKNOWN',
          message: `dataType "${dt}" is not a known IFC measure/type for ${version}`,
          path: `${path}.dataType`,
          facetType: 'property',
          detail: { value: dt, version },
        });
      } else if (facet.value) {
        // Restriction-base compatibility (upstream Report 303): when a
        // <value> is set with an xs:restriction, its base must match the
        // dataType's backing type.
        checkRestrictionBase(
          facet.value,
          found.backingType,
          dt,
          `${path}.value`,
          issues
        );
      }
    }
  }

  if (facet.propertySet.type !== 'simpleValue') return;
  const psetName = facet.propertySet.value;
  if (!psetName) return;
  const pset = await findPropertySet(version, psetName);

  // Reserved-prefix check: `Pset_*` and `Qto_*` are reserved for
  // buildingSMART-published sets. Mirrors `IdsProperty.cs` upstream.
  const isReserved = RESERVED_PSET_PREFIXES.some((p) => psetName.startsWith(p));
  if (!pset) {
    if (isReserved && (await canVerifyReservedSet(version, psetName))) {
      issues.push({
        severity: 'warning',
        code: 'W_IFC_PSET_RESERVED_PREFIX',
        message: `property set "${psetName}" uses a reserved buildingSMART prefix but is not a known standard ${psetName.startsWith('Qto_') ? 'quantity set' : 'pset'} for ${version}`,
        path: `${path}.propertySet`,
        facetType: 'property',
        detail: { value: psetName, version },
      });
    }
    return;
  }

  // Applicability cross-check: warn when the spec restricts applicability
  // to an entity that isn't on the pset's `applicableEntities` list (or
  // a subtype of one). Works for simpleValue entity names and for
  // pattern/enumeration constraints — in the latter case we resolve
  // candidate entity names by matching the constraint against the
  // schema's full entity list.
  if (applicabilityEntity && pset.applicableEntities.length > 0) {
    const candidates = await resolveEntityCandidates(
      applicabilityEntity,
      version
    );
    if (candidates.length > 0) {
      // Type/occurrence duality: a pset declared applicable to an
      // occurrence class (e.g. `IfcElement`) is equally applicable to that
      // class's companion *type* entity (`IfcElementType`) — IFC lets the
      // same pset attach to either the occurrence or its type, and a type
      // pset propagates to its occurrences. The standard validators honour
      // this. Without it, an IDS that targets type entities (e.g.
      // `IfcActuatorType`) with a standard element pset (e.g.
      // `Pset_ManufacturerTypeInformation`, whose `applicableEntities` is
      // just `IfcElement`) is wrongly flagged as inapplicable. (#1441)
      const applicable = await expandWithCompanionTypes(
        version,
        pset.applicableEntities
      );
      const anyMatches = (
        await Promise.all(
          candidates.map((c) => psetApplies(version, c, applicable))
        )
      ).some(Boolean);
      if (!anyMatches) {
        const label =
          candidates.length === 1 ? candidates[0] : `{${candidates.join(', ')}}`;
        issues.push({
          severity: 'error',
          code: 'E_IFC_PROP_NOT_IN_PSET',
          message: `${pset.name} is not applicable to ${label} in ${version}`,
          path: `${path}.propertySet`,
          facetType: 'property',
          detail: { pset: pset.name, entity: label, version },
        });
      }
    }
  }

  if (facet.baseName.type === 'simpleValue') {
    const propName = facet.baseName.value;
    if (propName) {
      const prop = pset.properties.find((p) => p.name === propName);
      if (!prop) {
        issues.push({
          severity: 'error',
          code: 'E_IFC_PROP_NOT_IN_PSET',
          message: `property "${propName}" is not part of ${pset.name} (${version})`,
          path: `${path}.baseName`,
          facetType: 'property',
          detail: { property: propName, pset: pset.name, version },
        });
      } else if (
        facet.dataType &&
        facet.dataType.type === 'simpleValue' &&
        facet.dataType.value
      ) {
        checkDataTypeMatch(
          prop,
          facet.dataType.value,
          path,
          pset.name,
          propName,
          issues
        );
      }
    }
  }
}

function checkDataTypeMatch(
  prop: IfcPropertyInfo,
  declared: string,
  path: string,
  psetName: string,
  propName: string,
  issues: IDSAuditIssue[]
): void {
  // `IDSPROPERTYSINGLEVALUE` etc. — the IDS spec uses the IFC pset
  // template type name, not the IFC datatype. We allow both: if the
  // declared value matches either the property's IFC datatype (e.g.
  // `IfcLabel`) or the canonical IDS template form (`IFCPROPERTYSINGLEVALUE`
  // for kind=`single`, `IFCPROPERTYENUMERATEDVALUE` for kind=`enumeration`,
  // etc.), we don't warn.
  //
  // Enumerated properties (PEnum_*) carry no `dataType` in the pset
  // definitions — their values serialize as IfcLabel, so IFCLABEL is the
  // canonical IDS dataType for them. Mirrors upstream IdsLib's
  // `HasDataTypes` (EnumerationPropertyType → ["IFCLABEL"]).
  const declaredUpper = declared.toUpperCase();
  const expected =
    prop.dataType ?? (prop.kind === 'enumeration' ? 'IfcLabel' : undefined);
  if (expected && expected.toUpperCase() === declaredUpper) return;
  const idsTemplate = idsTemplateForKind(prop.kind);
  if (idsTemplate && declaredUpper === idsTemplate) return;
  // No backing datatype known for this property shape (e.g. table
  // values, which carry two datatypes we don't model) — skip rather
  // than guess, like upstream when `HasDataTypes` returns false.
  if (!expected) return;
  // Upstream IDS-Audit-tool treats this as an error (Report 303 family)
  // — declaring a different dataType than the standard pset specifies is
  // an authoring mistake, not a stylistic warning.
  issues.push({
    severity: 'error',
    code: 'W_IFC_DATATYPE_MISMATCH',
    message: `${psetName}.${propName} is typed ${expected} in the standard, not ${declared}`,
    path: `${path}.dataType`,
    facetType: 'property',
    detail: {
      expected,
      actual: declared,
      property: propName,
    },
  });
}

/**
 * Upstream IDS-Audit-tool's Report 303 — when a `<value>` carries an
 * `xs:restriction`, its `@base` must be compatible with the dataType's
 * backing XSD type. The parser preserves the raw `@base` attribute on
 * pattern/enumeration/bounds constraints, so we use that directly when
 * present and only fall back to inferring from the restriction shape
 * when the source XML didn't carry a base.
 *
 * Inferring from shape alone is ambiguous: `<xs:enumeration value="1"/>`
 * looks like a string enumeration unless we know the parent
 * `<xs:restriction base="xs:integer">`.
 */
function checkRestrictionBase(
  c: import('../../types.js').IDSConstraint,
  backingType: string,
  dataType: string,
  path: string,
  issues: IDSAuditIssue[]
): void {
  // Only restrictions can mismatch — simpleValue is always treated as
  // string-compatible by the IDS XSD.
  if (c.type === 'simpleValue') return;
  const declaredBase =
    c.type === 'pattern' || c.type === 'enumeration' || c.type === 'bounds'
      ? c.base
      : undefined;
  let inferred: string | undefined;
  if (declaredBase) {
    inferred = declaredBase;
  } else {
    switch (c.type) {
      case 'pattern':
      case 'enumeration':
        inferred = 'xs:string';
        break;
      case 'bounds':
        if (
          typeof c.length === 'number' ||
          typeof c.minLength === 'number' ||
          typeof c.maxLength === 'number'
        ) {
          inferred = 'xs:string';
        } else {
          inferred = 'xs:double';
        }
        break;
    }
  }
  if (!inferred) return;
  if (!isXsTypeCompatible(inferred, backingType)) {
    issues.push({
      severity: 'error',
      code: 'E_RESTRICTION_BASE_MISMATCH',
      message: `xs:restriction base (${inferred}) is not compatible with dataType "${dataType}" (backing ${backingType})`,
      path,
      facetType: 'property',
      detail: { inferred, expected: backingType, dataType },
    });
  }
}

/**
 * XSD type compatibility per upstream `IdsProperty.cs`: the restriction
 * `@base` must equal the IFC dataType's backing XSD type exactly. The
 * one wrinkle is the `xs:double` / `xs:decimal` / `xs:float` family —
 * upstream's `XsTypes.IsValid` accepts any of them as
 * floating-point — so those three are treated as equivalent.
 *
 * `xs:integer` is *not* promoted to floats: upstream rejects an
 * `xs:integer` restriction on an `IFCREAL`-backing property since
 * decimal values would be invalid against the integer pattern.
 */
function isXsTypeCompatible(inferred: string, expected: string): boolean {
  if (inferred === expected) return true;
  const floats = new Set(['xs:double', 'xs:decimal', 'xs:float']);
  if (floats.has(inferred) && floats.has(expected)) return true;
  return false;
}

function idsTemplateForKind(kind: IfcPropertyInfo['kind']): string | undefined {
  switch (kind) {
    case 'single':
      return 'IFCPROPERTYSINGLEVALUE';
    case 'enumeration':
      return 'IFCPROPERTYENUMERATEDVALUE';
    case 'list':
      return 'IFCPROPERTYLISTVALUE';
    case 'bounded':
      return 'IFCPROPERTYBOUNDEDVALUE';
    case 'reference':
      return 'IFCPROPERTYREFERENCEVALUE';
    default:
      return undefined;
  }
}

async function psetApplies(
  version: IfcSchemaVersion,
  entityName: string,
  applicable: readonly string[]
): Promise<boolean> {
  for (const candidate of applicable) {
    if (await isEntitySubtypeOf(version, entityName, candidate)) return true;
  }
  return false;
}

/**
 * Expand a pset's `applicableEntities` (always occurrence classes in the
 * buildingSMART data) with each class's companion *type* entity, so the
 * applicability check accepts an IDS that targets type entities.
 *
 * Standard psets list only the occurrence class — e.g.
 * `Pset_ManufacturerTypeInformation` → `["IfcElement"]` — yet IFC permits
 * attaching the same pset to the corresponding type (`IfcElementType` and
 * its subtypes), and many IDS specs do exactly that. Classes without a
 * type twin (e.g. `IfcSite`, `IfcMaterial`) contribute nothing. (#1441)
 *
 * IFC4+ entity rows carry an authoritative `typeEntity` link. IFC2X3 rows
 * omit it, so we fall back to the `<Occurrence>Type` naming convention —
 * but only when that type entity actually exists in the schema version,
 * so we never invent a non-existent class.
 */
async function expandWithCompanionTypes(
  version: IfcSchemaVersion,
  applicable: readonly string[]
): Promise<string[]> {
  const expanded = new Set<string>(applicable);
  for (const name of applicable) {
    const entity = await findEntity(version, name);
    if (!entity) continue;
    if (entity.typeEntity) {
      expanded.add(entity.typeEntity);
      continue;
    }
    const namedType = `${name}Type`;
    if (await findEntity(version, namedType)) expanded.add(namedType);
  }
  return [...expanded];
}

/** Memoised "does this schema version have any `Qto_*` set?" lookup. */
const quantitySetCoverage = new Map<IfcSchemaVersion, boolean>();

async function versionHasQuantitySets(
  version: IfcSchemaVersion
): Promise<boolean> {
  const cached = quantitySetCoverage.get(version);
  if (cached !== undefined) return cached;
  const sets = await getPropertySets(version);
  const has = sets.some((p) => p.name.startsWith('Qto_'));
  quantitySetCoverage.set(version, has);
  return has;
}

/**
 * Whether the reserved-prefix warning can be trusted for `name` in this
 * version — i.e. whether our schema tables are complete enough to assert
 * "this reserved name is not a known standard set".
 *
 * `Pset_*` coverage is complete across all versions. Quantity sets (`Qto_*`)
 * are not: the upstream IDS-Audit-tool data only enumerates them for IFC4X3,
 * so IFC2X3/IFC4 carry no `Qto_*` rows at all. Without that data we cannot
 * tell an authoring typo from a real standard set we simply do not have
 * (e.g. `Qto_SpaceBaseQuantities`, which is standard in IFC4), so suppressing
 * the warning is the honest choice rather than emitting a false positive.
 * Verifying `Qto_*` against an incomplete table caused #1442. We deliberately
 * do not backfill a synthesised per-version quantity-set list, since entity
 * existence alone cannot prove a set belongs to an earlier schema version.
 */
async function canVerifyReservedSet(
  version: IfcSchemaVersion,
  name: string
): Promise<boolean> {
  if (!name.startsWith('Qto_')) return true;
  return versionHasQuantitySets(version);
}

/**
 * Resolve the set of candidate entity names matched by an entity facet's
 * `name` constraint. simpleValue → singleton list; enumeration → its
 * values; pattern → entity names from the schema that match the regex.
 * Returns an empty list when the constraint can't be resolved.
 */
async function resolveEntityCandidates(
  facet: IDSEntityFacet,
  version: IfcSchemaVersion
): Promise<string[]> {
  switch (facet.name.type) {
    case 'simpleValue':
      return facet.name.value ? [facet.name.value] : [];
    case 'enumeration':
      return facet.name.values.filter((v) => !!v);
    case 'pattern': {
      try {
        const rx = new RegExp(`^${facet.name.pattern}$`);
        const { getEntities } = await import('@ifc-lite/data');
        const list = await getEntities(version);
        return list
          .filter((e) => rx.test(e.name.toUpperCase()) || rx.test(e.name))
          .map((e) => e.name);
      } catch {
        return [];
      }
    }
    default:
      return [];
  }
}

async function auditAttributeFacet(
  facet: Extract<IDSFacet, { type: 'attribute' }>,
  version: IfcSchemaVersion,
  path: string,
  applicabilityEntity: IDSEntityFacet | undefined,
  issues: IDSAuditIssue[]
): Promise<void> {
  if (!applicabilityEntity) return; // Can't cross-check without an entity.
  if (applicabilityEntity.name.type !== 'simpleValue') return;
  if (facet.name.type !== 'simpleValue') return;

  const entityName = applicabilityEntity.name.value;
  const attrName = facet.name.value;
  if (!entityName || !attrName) return;

  const chain = await getInheritanceChain(version, entityName);
  if (chain.length === 0) return; // Unknown entity already flagged.

  if (!chainHasAttribute(chain, attrName)) {
    issues.push({
      severity: 'error',
      code: 'E_IFC_ATTR_UNKNOWN_FOR_ENTITY',
      message: `attribute "${attrName}" is not defined on ${chain[0].name} (${version})`,
      path: `${path}.name`,
      facetType: 'attribute',
      detail: { attribute: attrName, entity: chain[0].name, version },
    });
    return;
  }

  // Upstream Report 102: when a `<value>` constraint is supplied on an
  // attribute that doesn't admit a simple value (e.g. complex/entity-
  // typed attributes like `IfcTask.TaskTime`), surface as an error.
  if (facet.value === undefined) return;
  const meta = await findAttribute(version, attrName);
  if (!meta) return; // unknown to lookup → defer to schema fix
  // The applicability entity must appear in `simpleValueEntities` for
  // the value constraint to be meaningful.
  const entityUpper = chain[0].name.toUpperCase();
  const inheritedEntities = chain.map((e) => e.name.toUpperCase());
  const allowsSimpleValue = inheritedEntities.some((e) =>
    meta.simpleValueEntities.includes(e)
  );
  const isComplexHere = inheritedEntities.some((e) =>
    meta.complexEntities.includes(e)
  );
  if (!allowsSimpleValue && isComplexHere) {
    issues.push({
      severity: 'error',
      code: 'E_IFC_ATTR_UNKNOWN_FOR_ENTITY',
      message: `attribute "${attrName}" on ${entityUpper} is a complex/entity-typed attribute and cannot carry a simple <value> constraint (${version})`,
      path: `${path}.value`,
      facetType: 'attribute',
      detail: { attribute: attrName, entity: entityUpper, version },
    });
  }
}

function chainHasAttribute(
  chain: readonly IfcEntityInfo[],
  attrName: string
): boolean {
  const lower = attrName.toLowerCase();
  for (const entity of chain) {
    for (const a of entity.attributes) {
      if (a.toLowerCase() === lower) return true;
    }
  }
  return false;
}

async function auditPartOfFacet(
  facet: Extract<IDSFacet, { type: 'partOf' }>,
  version: IfcSchemaVersion,
  path: string,
  applicabilityEntity: IDSEntityFacet | undefined,
  issues: IDSAuditIssue[]
): Promise<void> {
  const relations = await getPartOfRelations(version);
  // The parser normalises unrecognised relations to a fallback enum
  // value; when it does, it preserves the original string in
  // `rawRelation`. Prefer the raw value for cross-checking so we can
  // flag bogus inputs.
  const probe = facet.rawRelation ?? facet.relation;
  const probeUpper = probe.toUpperCase();
  const relation = relations.find((r) => r.relation === probeUpper);
  if (!relation) {
    issues.push({
      severity: 'error',
      code: 'E_IFC_PARTOF_RELATION',
      message: `partOf relation "${probe}" is not valid for ${version}`,
      path: `${path}.relation`,
      facetType: 'partOf',
      detail: { value: probe, version },
    });
    return;
  }
  if (
    facet.entity &&
    facet.entity.name.type === 'simpleValue' &&
    facet.entity.name.value
  ) {
    const name = facet.entity.name.value;
    const entity = await findEntity(version, name);
    if (!entity) {
      issues.push({
        severity: 'error',
        code: 'E_IFC_PARTOF_ENTITY',
        message: `partOf entity "${name}" is not a known IFC entity for ${version}`,
        path: `${path}.entity.name`,
        facetType: 'partOf',
        detail: { value: name, version },
      });
      return;
    }
    // Upstream (`PartOfRelationInformation`) further constrains the
    // partOf entity to be a subtype of the relation's `owner`. Apply
    // that too — it's the most useful signal for catching e.g.
    // "IFCRELCONTAINEDINSPATIALSTRUCTURE on an IfcWindow" mistakes.
    const ownerName = relation.owner;
    const ok = await isEntitySubtypeOf(version, entity.name, ownerName);
    if (!ok) {
      issues.push({
        severity: 'error',
        code: 'E_IFC_PARTOF_ENTITY',
        message: `partOf @entity "${entity.name}" is not a subtype of "${ownerName}" required by ${facet.relation} (${version})`,
        path: `${path}.entity.name`,
        facetType: 'partOf',
        detail: {
          value: entity.name,
          required: ownerName,
          relation: facet.relation,
          version,
        },
      });
    }
  }
  // The applicability entity (the "thing we're filtering on") must be a
  // subtype of the relation's `member` constraint, e.g. an
  // `IfcRelNests` requirement only makes sense if the applicability
  // entity is itself an `IfcObjectDefinition`.
  if (
    applicabilityEntity &&
    applicabilityEntity.name.type === 'simpleValue' &&
    applicabilityEntity.name.value
  ) {
    const appName = applicabilityEntity.name.value;
    const memberOk = await isEntitySubtypeOf(version, appName, relation.member);
    if (!memberOk) {
      issues.push({
        severity: 'error',
        code: 'E_IFC_PARTOF_ENTITY',
        message: `applicability entity "${appName}" cannot be the member of ${facet.relation}; ${facet.relation} requires the member to be a subtype of "${relation.member}" (${version})`,
        path: `${path}.relation`,
        facetType: 'partOf',
        detail: {
          applicability: appName,
          required: relation.member,
          relation: facet.relation,
          version,
        },
      });
    }
  }
}
