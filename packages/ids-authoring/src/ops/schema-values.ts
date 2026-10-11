/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * JSON Schema `$defs` for values and raw IDS content (constraints, facets,
 * specifications, node snapshots). The op schemas in `./schema.ts`
 * reference these. Hand-kept in sync with `./types.ts` and
 * `@ifc-lite/ids`' types; `schema.test.ts` round-trips every corpus
 * document through them.
 */

import { ALL_FACET_FIELDS } from '../document/fields.js';
import type { JsonSchema } from './json-schema-lite.js';

/** Object schema with `additionalProperties: false`. */
export function obj(properties: Record<string, JsonSchema>, required: string[] = []): JsonSchema {
  return { type: 'object', properties, required, additionalProperties: false };
}

const ref = (name: string): JsonSchema => ({ $ref: `#/$defs/${name}` });
const str: JsonSchema = { type: 'string' };
const num: JsonSchema = { type: 'number' };
const int0: JsonSchema = { type: 'integer', minimum: 0 };
const bool: JsonSchema = { type: 'boolean' };
const uri: JsonSchema = { type: 'string', minLength: 1 };

const DRAFTS: Record<string, JsonSchema> = {
  DraftAny: obj({ kind: { const: 'any' } }, ['kind']),
  DraftEquals: obj({ kind: { const: 'equals' }, value: ref('Scalar') }, ['kind', 'value']),
  DraftOneOf: obj(
    { kind: { const: 'oneOf' }, values: { type: 'array', items: ref('Scalar'), minItems: 1 }, base: ref('XsdBase') },
    ['kind', 'values'],
  ),
  DraftPattern: obj({ kind: { const: 'pattern' }, pattern: { type: 'string', minLength: 1 }, base: ref('XsdBase') }, [
    'kind',
    'pattern',
  ]),
  DraftRange: obj(
    {
      kind: { const: 'range' },
      min: num,
      minInclusive: bool,
      max: num,
      maxInclusive: bool,
      unit: str,
      base: ref('XsdBase'),
    },
    ['kind'],
  ),
  DraftLength: obj({ kind: { const: 'length' }, exact: int0, min: int0, max: int0 }, ['kind']),
  DraftDigits: obj({ kind: { const: 'digits' }, total: { type: 'integer', minimum: 1 }, fraction: int0 }, ['kind']),
  DraftAll: obj({ kind: { const: 'all' }, of: { type: 'array', items: ref('ConstraintDraft'), minItems: 1 } }, [
    'kind',
    'of',
  ]),
  RawConstraint: obj({ kind: { const: 'raw' }, constraint: ref('IDSConstraint') }, ['kind', 'constraint']),
};

const DRAFT_NAMES = Object.keys(DRAFTS).filter((n) => n !== 'RawConstraint');

const conjunct: JsonSchema = { type: 'array', items: ref('IDSConstraint') };

const IDS_CONTENT: Record<string, JsonSchema> = {
  IDSSimpleValue: obj({ type: { const: 'simpleValue' }, value: str }, ['type', 'value']),
  IDSPattern: obj({ type: { const: 'pattern' }, pattern: str, base: str, and: conjunct }, ['type', 'pattern']),
  IDSEnumeration: obj({ type: { const: 'enumeration' }, values: { type: 'array', items: str }, base: str, and: conjunct }, [
    'type',
    'values',
  ]),
  IDSBounds: obj(
    {
      type: { const: 'bounds' },
      minInclusive: num,
      maxInclusive: num,
      minExclusive: num,
      maxExclusive: num,
      length: num,
      minLength: num,
      maxLength: num,
      totalDigits: num,
      fractionDigits: num,
      base: str,
      and: conjunct,
      unparseableFacets: { type: 'array', items: obj({ facet: str, rawValue: str }, ['facet', 'rawValue']) },
    },
    ['type'],
  ),
  IDSConstraint: { oneOf: [ref('IDSSimpleValue'), ref('IDSPattern'), ref('IDSEnumeration'), ref('IDSBounds')] },
  IDSEntityFacet: obj({ type: { const: 'entity' }, name: ref('IDSConstraint'), predefinedType: ref('IDSConstraint') }, [
    'type',
    'name',
  ]),
  IDSAttributeFacet: obj({ type: { const: 'attribute' }, name: ref('IDSConstraint'), value: ref('IDSConstraint') }, [
    'type',
    'name',
  ]),
  IDSPropertyFacet: obj(
    {
      type: { const: 'property' },
      propertySet: ref('IDSConstraint'),
      baseName: ref('IDSConstraint'),
      dataType: ref('IDSConstraint'),
      value: ref('IDSConstraint'),
      uri,
    },
    ['type', 'propertySet', 'baseName'],
  ),
  IDSClassificationFacet: obj(
    { type: { const: 'classification' }, system: ref('IDSConstraint'), value: ref('IDSConstraint'), uri },
    ['type'],
  ),
  IDSMaterialFacet: obj({ type: { const: 'material' }, value: ref('IDSConstraint'), uri }, ['type']),
  IDSPartOfFacet: obj(
    { type: { const: 'partOf' }, relation: ref('PartOfRelation'), rawRelation: str, entity: ref('IDSEntityFacet') },
    ['type', 'relation'],
  ),
  IDSFacet: {
    oneOf: [
      ref('IDSEntityFacet'),
      ref('IDSAttributeFacet'),
      ref('IDSPropertyFacet'),
      ref('IDSClassificationFacet'),
      ref('IDSMaterialFacet'),
      ref('IDSPartOfFacet'),
    ],
  },
  IDSRequirement: obj(
    {
      id: str,
      facet: ref('IDSFacet'),
      optionality: ref('Optionality'),
      cardinalityRaw: str,
      description: str,
      instructions: str,
    },
    ['id', 'facet', 'optionality'],
  ),
  IDSSpecification: obj(
    {
      id: str,
      name: str,
      description: str,
      instructions: str,
      ifcVersions: { type: 'array', items: ref('IfcVersion') },
      ifcVersionRaw: str,
      identifier: str,
      applicability: obj({ facets: { type: 'array', items: ref('IDSFacet') }, cardinality: str }, ['facets']),
      requirements: { type: 'array', items: ref('IDSRequirement') },
      minOccurs: num,
      maxOccurs: { anyOf: [num, { const: 'unbounded' }] },
    },
    ['id', 'name', 'ifcVersions', 'applicability', 'requirements'],
  ),
  FacetNodes: obj(
    {
      id: ref('Uuid'),
      constraints: obj(Object.fromEntries(ALL_FACET_FIELDS.map((f) => [f, ref('Uuid')]))),
    },
    ['id', 'constraints'],
  ),
  SpecNodes: obj(
    {
      id: ref('Uuid'),
      applicability: { type: 'array', items: ref('FacetNodes') },
      requirements: { type: 'array', items: ref('FacetNodes') },
    },
    ['id', 'applicability', 'requirements'],
  ),
};

const vi = ref('ValueInput');

const FACET_DRAFTS: Record<string, JsonSchema> = {
  EntityDraft: obj({ type: { const: 'entity' }, name: vi, predefinedType: vi }, ['type', 'name']),
  AttributeDraft: obj({ type: { const: 'attribute' }, name: vi, value: vi }, ['type', 'name']),
  PropertyDraft: obj(
    { type: { const: 'property' }, propertySet: vi, baseName: vi, dataType: vi, value: vi, uri },
    ['type', 'propertySet', 'baseName'],
  ),
  ClassificationDraft: obj({ type: { const: 'classification' }, system: vi, value: vi, uri }, ['type']),
  MaterialDraft: obj({ type: { const: 'material' }, value: vi, uri }, ['type']),
  PartOfDraft: obj(
    {
      type: { const: 'partOf' },
      relation: ref('PartOfRelation'),
      entity: obj({ name: vi, predefinedType: vi }, ['name']),
    },
    ['type', 'relation'],
  ),
};

export const VALUE_DEFS: Record<string, JsonSchema> = {
  Uuid: { type: 'string', pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' },
  Scalar: { type: ['string', 'number', 'boolean'] },
  XsdBase: {
    enum: [
      'xs:string',
      'xs:boolean',
      'xs:integer',
      'xs:double',
      'xs:decimal',
      'xs:float',
      'xs:date',
      'xs:dateTime',
      'xs:time',
      'xs:duration',
      'xs:anyURI',
    ],
  },
  IfcVersion: { enum: ['IFC2X3', 'IFC4', 'IFC4X3_ADD2', 'IFC4X3'] },
  PartOfRelation: {
    enum: [
      'IfcRelAggregates',
      'IfcRelAssignsToGroup',
      'IfcRelContainedInSpatialStructure',
      'IfcRelNests',
      'IfcRelVoidsElement',
      'IfcRelFillsElement',
      'IfcRelVoidsElement IfcRelFillsElement',
    ],
  },
  Optionality: { enum: ['required', 'optional', 'prohibited'] },
  Section: { enum: ['applicability', 'requirements'] },
  FacetField: { enum: [...ALL_FACET_FIELDS] },
  ...DRAFTS,
  ConstraintDraft: { oneOf: DRAFT_NAMES.map(ref) },
  ValueInput: { oneOf: [...DRAFT_NAMES.map(ref), ref('RawConstraint')] },
  ...FACET_DRAFTS,
  FacetDraft: { oneOf: Object.keys(FACET_DRAFTS).map(ref) },
  ...IDS_CONTENT,
  CustomPsetDecl: obj(
    {
      name: { type: 'string', minLength: 1 },
      properties: { type: 'array', items: obj({ name: { type: 'string', minLength: 1 }, dataType: str }, ['name']) },
    },
    ['name'],
  ),
};
