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
import { assertIds11Allowed } from '../preview/features.js';
import type { IDSPreviewFlags } from '../preview/types.js';

const IDS_NS = 'http://standards.buildingsmart.org/IDS';
const XS_NS = 'http://www.w3.org/2001/XMLSchema';
const XSI_NS = 'http://www.w3.org/2001/XMLSchema-instance';
const SCHEMA_LOCATION = `${IDS_NS} http://standards.buildingsmart.org/IDS/1.0/ids.xsd`;
/**
 * IDS 1.1 PREVIEW. buildingSMART has not published a 1.1 schema URL; this
 * follows the 1.0 pattern and the `version="1.1.0"` of the upstream
 * `ver/1.1.x` branch's `ids.xsd`. An assumption, recorded in the P-12 worklog.
 */
const SCHEMA_LOCATION_11_PREVIEW = `${IDS_NS} http://standards.buildingsmart.org/IDS/1.1/ids.xsd`;
const IDS11_PREVIEW_NOTE = 'IDS 1.1 PREVIEW: uses unreleased candidate features; not valid IDS 1.0.';

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

/**
 * Where a facet is written. IDS 1.0 knows applicability and requirements;
 * `nested` is a facet inside `partOf` (IDS 1.1 PREVIEW, #379/#380).
 */
type FacetContext = 'applicability' | 'requirement' | 'nested';

/**
 * The facet's `instructions` attribute. A requirement's comes from
 * `IDSRequirement.instructions` (IDS 1.0); an applicability facet's from the
 * facet itself (IDS 1.1 PREVIEW, #154). The facet-level field anywhere else
 * has no XML home and is refused rather than dropped.
 */
function instructionsFor(facet: IDSFacet, context: FacetContext, requirementInstructions?: string): string | undefined {
  if (context === 'applicability') return facet.instructions;
  if (facet.instructions !== undefined) {
    throw new Error(`writeIdsXml: a ${context} ${facet.type} facet cannot carry facet-level instructions${context === 'requirement' ? '; use IDSRequirement.instructions' : ''}`);
  }
  return requirementInstructions;
}

function writeFacet(xml: XmlLines, facet: IDSFacet, cardinality: string | undefined, context: FacetContext, requirementInstructions?: string): void {
  const instructions = instructionsFor(facet, context, requirementInstructions);
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
      xml.open('property', { dataType: dataTypeAttr(facet), cardinality, instructions, uri: facet.uri });
      writeConstraint(xml, 'propertySet', facet.propertySet);
      writeConstraint(xml, 'baseName', facet.baseName);
      if (facet.value) writeConstraint(xml, 'value', facet.value);
      xml.close('property');
      return;
    case 'classification':
      xml.open('classification', { cardinality, instructions, uri: facet.uri });
      if (facet.value) writeConstraint(xml, 'value', facet.value);
      if (facet.system) writeConstraint(xml, 'system', facet.system);
      xml.close('classification');
      return;
    case 'material':
      xml.open('material', { cardinality, instructions, uri: facet.uri });
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
      // IDS 1.1 PREVIEW (#379/#380): conditions on the related parent.
      for (const nested of facet.facets ?? []) writeFacet(xml, nested, undefined, 'nested');
      xml.close('partOf');
      return;
  }
}

function writeRequirement(xml: XmlLines, requirement: IDSRequirement): void {
  // IDS 1.0 has no cardinality on an entity facet inside requirements.
  const cardinality = requirement.facet.type === 'entity' ? undefined : requirement.optionality;
  writeFacet(xml, requirement.facet, cardinality, 'requirement', requirement.instructions);
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
  for (const facet of facets) writeFacet(xml, facet, undefined, 'applicability');
  xml.close('applicability');
  if (spec.requirements.length > 0) {
    xml.open('requirements');
    for (const requirement of spec.requirements) writeRequirement(xml, requirement);
    xml.close('requirements');
  }
  xml.close('specification');
}

/** What `writeIdsXml` may write, as opposed to how (`IdsXmlFormat`). */
export interface IdsXmlWriteOptions {
  /**
   * IDS 1.1 PREVIEW (unstable). Without `ids11`, a document using a 1.1
   * candidate feature is refused with `IDS11PreviewRequiredError`; with it,
   * such a document is written against the 1.1 schema location. A document
   * using no 1.1 feature is written as IDS 1.0 either way, byte for byte.
   */
  preview?: IDSPreviewFlags;
}

/**
 * `doc` as an IDS 1.0 XML string, laid out per `fmt` (two-space indent,
 * `\n`, authored order by default). IDS 1.1 PREVIEW output needs
 * `options.preview.ids11`.
 */
export function writeIdsXml(doc: IDSDocument, fmt: IdsXmlFormat = {}, options: IdsXmlWriteOptions = {}): string {
  const ids11 = assertIds11Allowed(doc, options.preview, 'writeIdsXml', true).length > 0;
  const xml = new XmlLines(indentUnit(fmt.indent));
  const newline = fmt.newline ?? '\n';
  const canonical = fmt.canonical ?? false;
  xml.open('ids', {
    xmlns: IDS_NS,
    'xmlns:xs': XS_NS,
    'xmlns:xsi': XSI_NS,
    'xsi:schemaLocation': ids11 ? SCHEMA_LOCATION_11_PREVIEW : SCHEMA_LOCATION,
  });
  if (ids11) xml.comment(IDS11_PREVIEW_NOTE);
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
