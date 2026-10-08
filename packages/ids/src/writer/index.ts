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
  IFCVersion,
  PartOfRelation,
} from '../types.js';
import { XmlLines } from './xml-lines.js';
import { writeConstraint } from './constraint.js';

const IDS_NS = 'http://standards.buildingsmart.org/IDS';
const XS_NS = 'http://www.w3.org/2001/XMLSchema';
const XSI_NS = 'http://www.w3.org/2001/XMLSchema-instance';
const SCHEMA_LOCATION = `${IDS_NS} http://standards.buildingsmart.org/IDS/1.0/ids.xsd`;

/**
 * `IfcRelContainedInSpatialStructure` -> the XSD's upper-case `relations`
 * token. Voids and fills exist in IDS 1.0 only as the combined token, so
 * either alone has no valid XML and is refused.
 */
function relationToken(relation: PartOfRelation): string {
  if (relation === 'IfcRelVoidsElement' || relation === 'IfcRelFillsElement') {
    throw new Error(`writeIdsXml: partOf relation ${relation} on its own is not supported by this writer (IDS 1.0 has only "IFCRELVOIDSELEMENT IFCRELFILLSELEMENT")`);
  }
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

/** Formatting of `writeIdsXml`'s output. Every option changes layout or order only, never meaning. */
export interface IdsXmlFormat {
  /** Indentation of one nesting level: a number of spaces (0–8) or `'\t'`. Default `2`. */
  indent?: number | '\t';
  /** Line ending. Default `'\n'`. */
  newline?: '\n' | '\r\n';
  /**
   * Canonical order, so two documents with the same checks write the same
   * bytes: applicability facets in the `ids.xsd` sequence (entity, partOf,
   * classification, attribute, property, material; stable within a kind)
   * and `ifcVersion` tokens in schema order without duplicates. Both are
   * order-insensitive in IDS. Requirements keep their authored order, which
   * reports show. Default `false`: everything is written in the order given.
   */
  canonical?: boolean;
}

/** The `ids.xsd` applicability sequence; an applicability in another order is not schema-valid. */
const FACET_ORDER: Readonly<Record<IDSFacet['type'], number>> = {
  entity: 0, partOf: 1, classification: 2, attribute: 3, property: 4, material: 5,
};
/** `ids.xsd`'s `ifcVersion` tokens, in schema order. The parser reads `IFC4X3_ADD2` as `IFC4X3`. */
const VERSION_TOKENS = ['IFC2X3', 'IFC4', 'IFC4X3_ADD2'] as const;

/** `IFC4X3` has no token of its own in IDS 1.0: it is written as `IFC4X3_ADD2`, which reads back as `IFC4X3`. */
function versionToken(version: IFCVersion): string {
  return version === 'IFC4X3' ? 'IFC4X3_ADD2' : version;
}

function versionTokens(versions: readonly IFCVersion[], canonical: boolean): string[] {
  const tokens = versions.map(versionToken);
  if (!canonical) return tokens;
  return VERSION_TOKENS.filter((token) => tokens.includes(token));
}

function indentUnit(indent: IdsXmlFormat['indent']): string {
  if (indent === undefined) return '  ';
  if (indent === '\t') return '\t';
  if (!Number.isInteger(indent) || indent < 0 || indent > 8) {
    throw new Error(`writeIdsXml: indent must be '\\t' or an integer from 0 to 8, got ${indent}`);
  }
  return ' '.repeat(indent);
}

function writeSpecification(xml: XmlLines, spec: IDSSpecification, canonical: boolean): void {
  const versions = versionTokens(spec.ifcVersions, canonical);
  const facets = canonical
    ? [...spec.applicability.facets].sort((a, b) => FACET_ORDER[a.type] - FACET_ORDER[b.type])
    : spec.applicability.facets;
  xml.open('specification', {
    name: spec.name,
    ifcVersion: versions.join(' '),
    identifier: spec.identifier,
    description: spec.description,
    instructions: spec.instructions,
  });
  const maxOccurs = spec.maxOccurs === undefined ? 'unbounded' : String(spec.maxOccurs);
  xml.open('applicability', { minOccurs: String(spec.minOccurs ?? 0), maxOccurs });
  for (const facet of facets) writeFacet(xml, facet, undefined);
  xml.close('applicability');
  if (spec.requirements.length > 0) {
    xml.open('requirements');
    for (const requirement of spec.requirements) writeRequirement(xml, requirement);
    xml.close('requirements');
  }
  xml.close('specification');
}

/** `doc` as an IDS 1.0 XML string, laid out per `fmt` (two-space indent, `\n`, authored order by default). */
export function writeIdsXml(doc: IDSDocument, fmt: IdsXmlFormat = {}): string {
  const xml = new XmlLines(indentUnit(fmt.indent));
  const newline = fmt.newline ?? '\n';
  const canonical = fmt.canonical ?? false;
  xml.open('ids', {
    xmlns: IDS_NS,
    'xmlns:xs': XS_NS,
    'xmlns:xsi': XSI_NS,
    'xsi:schemaLocation': SCHEMA_LOCATION,
  });
  xml.open('info');
  // The `ids.xsd` info sequence. `date` (xs:date) and `author` (an e-mail
  // pattern) are written as given; `auditIDSDocument` reports malformed ones.
  const { title, copyright, version, description, author, date, purpose, milestone } = doc.info;
  xml.leaf('title', title);
  const optional: Array<[string, string | undefined]> = [
    ['copyright', copyright], ['version', version], ['description', description], ['author', author],
    ['date', date], ['purpose', purpose], ['milestone', milestone],
  ];
  for (const [tag, text] of optional) {
    if (text) xml.leaf(tag, text);
  }
  xml.close('info');
  xml.open('specifications');
  for (const spec of doc.specifications) writeSpecification(xml, spec, canonical);
  xml.close('specifications');
  xml.close('ids');
  return ['<?xml version="1.0" encoding="UTF-8"?>', ...xml.lines, ''].join(newline);
}
