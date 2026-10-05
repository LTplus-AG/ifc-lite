/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Facets of a reviewed IDS draft (#6915), parsed 1:1 onto the native
 * `IDSFacet` model of `@ifc-lite/ids`: same facet types, same field names,
 * native constraint shapes. Only measure units are an addition, converted to
 * the SI values IDS stores.
 */

import type { IDSEntityFacet, IDSFacet, PartOfRelation, RequirementOptionality } from '@ifc-lite/ids';
import { isRecord, onlyKeys, type JsonRecord } from './proposal-json';
import { dataTypeBase, parseConstraint, unitFactor } from './ids-constraint';

const RELATIONS: readonly PartOfRelation[] = ['IfcRelAggregates', 'IfcRelAssignsToGroup', 'IfcRelContainedInSpatialStructure',
  'IfcRelNests', 'IfcRelVoidsElement IfcRelFillsElement'];
const FACET_TYPES = ['entity', 'attribute', 'property', 'classification', 'material', 'partOf'] as const;
/** `ids.xsd` applicability sequence; requirements may come in any order. */
const XSD_ORDER: Record<IDSFacet['type'], number> = { entity: 0, partOf: 1, classification: 2, attribute: 3, property: 4, material: 5 };

/** IDS entity names are upper case (`IFCWALL`); `IfcWall` is accepted and upper-cased. */
function entityName(value: unknown, at: string): IDSEntityFacet['name'] {
  if (typeof value === 'string') {
    if (!/^Ifc[A-Za-z0-9]+$/i.test(value)) throw new Error(`${at} must be an IFC class name such as IFCWALL`);
    return { type: 'simpleValue', value: value.toUpperCase() };
  }
  return parseConstraint(value, { at });
}

function entityFacet(value: JsonRecord, at: string, extra: readonly string[]): IDSEntityFacet {
  onlyKeys(value, ['type', 'name', 'predefinedType', ...extra], at);
  if (value.name === undefined) throw new Error(`${at}.name is required (an IFC class such as IFCWALL)`);
  return { type: 'entity', name: entityName(value.name, `${at}.name`),
    ...(value.predefinedType !== undefined ? { predefinedType: parseConstraint(value.predefinedType, { at: `${at}.predefinedType` }) } : {}) };
}

/** One facet; `extra` are the requirement-only keys (`cardinality`, `instructions`). */
export function parseFacet(value: unknown, at: string, extra: readonly string[] = []): IDSFacet {
  if (!isRecord(value)) throw new Error(`${at} must be a facet object with "type"`);
  const required = (key: string, hint: string) => {
    if (value[key] === undefined) throw new Error(`${at}.${key} is required (${hint})`);
    return parseConstraint(value[key], { at: `${at}.${key}` });
  };
  switch (value.type) {
    case 'entity':
      return entityFacet(value, at, extra);
    case 'attribute': {
      onlyKeys(value, ['type', 'name', 'value', ...extra], at);
      const name = required('name', 'an IFC attribute such as Name or ObjectType');
      return { type: 'attribute', name, ...(value.value !== undefined ? { value: parseConstraint(value.value, { at: `${at}.value` }) } : {}) };
    }
    case 'property': {
      onlyKeys(value, ['type', 'propertySet', 'baseName', 'dataType', 'value', 'unit', ...extra], at);
      const propertySet = required('propertySet', 'a property or quantity set such as Pset_WallCommon');
      const baseName = required('baseName', 'the property name as stored in IFC, such as FireRating');
      let dataType: string | undefined;
      if (value.dataType !== undefined) {
        if (typeof value.dataType !== 'string' || dataTypeBase(value.dataType) === null) {
          throw new Error(`${at}.dataType must be an upper-case IFC data type such as IFCLABEL, IFCBOOLEAN or IFCLENGTHMEASURE`);
        }
        dataType = value.dataType;
      }
      const factor = unitFactor(value.unit, dataType, at);
      if (factor !== undefined && value.value === undefined) throw new Error(`${at}.unit needs a value`);
      return { type: 'property', propertySet, baseName,
        ...(dataType ? { dataType: { type: 'simpleValue', value: dataType } } : {}),
        ...(value.value !== undefined ? { value: parseConstraint(value.value, { at: `${at}.value`, base: dataType ? dataTypeBase(dataType) : null, factor }) } : {}) };
    }
    case 'classification': {
      onlyKeys(value, ['type', 'system', 'value', ...extra], at);
      const system = required('system', 'the classification system name; IDS 1.0 requires it');
      return { type: 'classification', system, ...(value.value !== undefined ? { value: parseConstraint(value.value, { at: `${at}.value` }) } : {}) };
    }
    case 'material':
      onlyKeys(value, ['type', 'value', ...extra], at);
      return { type: 'material', ...(value.value !== undefined ? { value: parseConstraint(value.value, { at: `${at}.value` }) } : {}) };
    case 'partOf': {
      onlyKeys(value, ['type', 'relation', 'entity', ...extra], at);
      const relation = RELATIONS.find(candidate => typeof value.relation === 'string' && candidate.toUpperCase() === value.relation.toUpperCase());
      if (!relation) throw new Error(`${at}.relation must be one of ${RELATIONS.join(', ')}`);
      if (!isRecord(value.entity)) throw new Error(`${at}.entity is required: the related whole, such as {"name":"IFCBUILDINGSTOREY"}`);
      return { type: 'partOf', relation, entity: entityFacet({ type: 'entity', ...value.entity }, `${at}.entity`, []) };
    }
    default:
      throw new Error(`${at}.type must be one of ${FACET_TYPES.join(', ')}`);
  }
}

/** Applicability: AND of facets, at most one entity, written in `ids.xsd` order. */
export function parseApplicability(value: unknown, at: string): IDSFacet[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 20) {
    throw new Error(`${at} must list 1 to 20 facets that select the checked elements (usually an entity facet first)`);
  }
  const facets = value.map((facet, index) => parseFacet(facet, `${at}[${index}]`));
  if (facets.filter(facet => facet.type === 'entity').length > 1) throw new Error(`${at} may have only one entity facet; use an enumeration or pattern for several classes`);
  return facets.map((facet, index) => ({ facet, index }))
    .sort((a, b) => XSD_ORDER[a.facet.type] - XSD_ORDER[b.facet.type] || a.index - b.index).map(entry => entry.facet);
}

const CARDINALITIES: readonly RequirementOptionality[] = ['required', 'optional', 'prohibited'];

/** The XSD allows `optional` neither on entity nor on partOf requirements. */
export function parseOptionality(value: unknown, facet: IDSFacet, at: string): RequirementOptionality {
  if (value === undefined) return 'required';
  if (typeof value !== 'string' || !CARDINALITIES.includes(value as RequirementOptionality)) throw new Error(`${at}.cardinality must be required, optional or prohibited`);
  if (facet.type === 'entity' && value !== 'required') throw new Error(`${at}: an entity requirement is always required in IDS 1.0`);
  if (facet.type === 'partOf' && value === 'optional') throw new Error(`${at}: a partOf requirement is required or prohibited in IDS 1.0`);
  return value as RequirementOptionality;
}
