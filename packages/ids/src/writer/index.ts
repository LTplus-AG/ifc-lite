/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Serialise an `IDSDocument` as IDS 1.0 XML (#5225). Covers entity,
 * attribute, property (with `dataType`), classification, material and
 * partOf facets, requirement `instructions`, and every `IDSConstraint`
 * shape: simple values, patterns, enumerations, numeric/length/digit bounds
 * and conjunctive (`and`) restrictions. Element order within a facet
 * follows `ids.xsd`, so `parseIDS` and `auditIDSDocument` read the result
 * back; applicability facets are written in the order given (the caller
 * owns the XSD's entity, partOf, classification, attribute, property,
 * material sequence there). `@ifc-lite/rules`' `ruleSetToIds` and the
 * viewer's reviewed IDS drafts (#6915) serialise through here (moved from
 * `@ifc-lite/rules` by ADR-005).
 */

import type {
  IDSDocument,
  IDSFacet,
  IDSRequirement,
  IDSSpecification,
} from '../types.js';
import { XmlLines } from './xml-lines.js';
import { writeConstraint } from './constraint.js';

const IDS_NS = 'http://standards.buildingsmart.org/IDS';
const XS_NS = 'http://www.w3.org/2001/XMLSchema';
const XSI_NS = 'http://www.w3.org/2001/XMLSchema-instance';
const SCHEMA_LOCATION = `${IDS_NS} http://standards.buildingsmart.org/IDS/1.0/ids.xsd`;

/** `IfcRelContainedInSpatialStructure` -> the XSD's upper-case `relations` token. */
function relationToken(relation: string): string {
  return relation.toUpperCase();
}

function writeEntity(xml: XmlLines, facet: Extract<IDSFacet, { type: 'entity' }>, attrs: Record<string, string | undefined> = {}): void {
  xml.open('entity', attrs);
  writeConstraint(xml, 'name', facet.name);
  if (facet.predefinedType) writeConstraint(xml, 'predefinedType', facet.predefinedType);
  xml.close('entity');
}

/** `dataType` is an XSD attribute holding one upper-case name, never a restriction. */
function dataTypeAttr(facet: Extract<IDSFacet, { type: 'property' }>): string | undefined {
  if (!facet.dataType) return undefined;
  if (facet.dataType.type !== 'simpleValue') throw new Error('writeIdsXml: a property dataType must be a simple value');
  return facet.dataType.value;
}

function writeFacet(xml: XmlLines, facet: IDSFacet, cardinality: string | undefined, instructions?: string): void {
  switch (facet.type) {
    case 'entity':
      writeEntity(xml, facet, { instructions });
      return;
    case 'attribute':
      xml.open('attribute', { cardinality, instructions });
      writeConstraint(xml, 'name', facet.name);
      if (facet.value) writeConstraint(xml, 'value', facet.value);
      xml.close('attribute');
      return;
    case 'property':
      xml.open('property', { dataType: dataTypeAttr(facet), cardinality, instructions });
      writeConstraint(xml, 'propertySet', facet.propertySet);
      writeConstraint(xml, 'baseName', facet.baseName);
      if (facet.value) writeConstraint(xml, 'value', facet.value);
      xml.close('property');
      return;
    case 'classification':
      xml.open('classification', { cardinality, instructions });
      if (facet.value) writeConstraint(xml, 'value', facet.value);
      if (facet.system) writeConstraint(xml, 'system', facet.system);
      xml.close('classification');
      return;
    case 'material':
      xml.open('material', { cardinality, instructions });
      if (facet.value) writeConstraint(xml, 'value', facet.value);
      xml.close('material');
      return;
    case 'partOf':
      // `ruleSetToIds` never produces one (a rule's `parent` subject matches
      // an ancestor's Name, not its class). The XSD requires the related
      // entity, so a partOf without one is refused rather than written invalid.
      if (!facet.entity) throw new Error('writeIdsXml: a partOf facet needs its related entity');
      xml.open('partOf', { relation: relationToken(facet.relation), cardinality, instructions });
      writeEntity(xml, facet.entity);
      xml.close('partOf');
      return;
  }
}

function writeRequirement(xml: XmlLines, requirement: IDSRequirement): void {
  // IDS 1.0 has no cardinality on an entity facet inside requirements.
  const cardinality = requirement.facet.type === 'entity' ? undefined : requirement.optionality;
  writeFacet(xml, requirement.facet, cardinality, requirement.instructions);
}

function writeSpecification(xml: XmlLines, spec: IDSSpecification): void {
  xml.open('specification', {
    name: spec.name,
    ifcVersion: spec.ifcVersions.join(' '),
    identifier: spec.identifier,
    description: spec.description,
    instructions: spec.instructions,
  });
  const maxOccurs = spec.maxOccurs === undefined ? 'unbounded' : String(spec.maxOccurs);
  xml.open('applicability', { minOccurs: String(spec.minOccurs ?? 0), maxOccurs });
  for (const facet of spec.applicability.facets) writeFacet(xml, facet, undefined);
  xml.close('applicability');
  if (spec.requirements.length > 0) {
    xml.open('requirements');
    for (const requirement of spec.requirements) writeRequirement(xml, requirement);
    xml.close('requirements');
  }
  xml.close('specification');
}

/** `doc` as an IDS 1.0 XML string. */
export function writeIdsXml(doc: IDSDocument): string {
  const xml = new XmlLines();
  xml.open('ids', {
    xmlns: IDS_NS,
    'xmlns:xs': XS_NS,
    'xmlns:xsi': XSI_NS,
    'xsi:schemaLocation': SCHEMA_LOCATION,
  });
  xml.open('info');
  xml.leaf('title', doc.info.title);
  if (doc.info.description) xml.leaf('description', doc.info.description);
  xml.close('info');
  xml.open('specifications');
  for (const spec of doc.specifications) writeSpecification(xml, spec);
  xml.close('specifications');
  xml.close('ids');
  return `<?xml version="1.0" encoding="UTF-8"?>\n${xml.lines.join('\n')}\n`;
}
