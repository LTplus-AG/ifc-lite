/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Serialise an `IDSDocument` as IDS 1.0 XML (#5225). Covers entity,
 * attribute, property (with `dataType`), classification, material and
 * partOf facets, requirement `instructions`, and simple-value, pattern,
 * enumeration and numeric-bound constraints. Element order within a facet
 * follows `ids.xsd`, so `parseIDS` and `auditIDSDocument` read the result
 * back; applicability facets are written in the order given (the caller
 * owns the XSD's entity, partOf, classification, attribute, property,
 * material sequence there). The viewer's reviewed IDS drafts (#6915) also
 * serialise through here.
 */

import type {
  IDSConstraint,
  IDSDocument,
  IDSFacet,
  IDSRequirement,
  IDSSpecification,
} from '@ifc-lite/ids';

const IDS_NS = 'http://standards.buildingsmart.org/IDS';
const XS_NS = 'http://www.w3.org/2001/XMLSchema';
const XSI_NS = 'http://www.w3.org/2001/XMLSchema-instance';
const SCHEMA_LOCATION = `${IDS_NS} http://standards.buildingsmart.org/IDS/1.0/ids.xsd`;

/** Characters XML 1.0 cannot carry, even as character references. */
// Matching control characters is the point: they are refused, not allowed through.
// eslint-disable-next-line no-control-regex
const NOT_XML = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/;

/** `field` names the element or attribute, so a refusal says what to fix. */
function escapeXml(text: string, field: string): string {
  const bad = NOT_XML.exec(text);
  if (bad) {
    const code = bad[0].charCodeAt(0).toString(16).toUpperCase().padStart(4, '0');
    throw new Error(`writeIdsXml: ${field} contains control character U+${code}, which XML 1.0 cannot carry`);
  }
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
    // A raw CR is normalised away by every XML reader; a reference survives.
    .replace(/\r/g, '&#13;');
}

/** Attribute-value normalisation turns raw line breaks and tabs into spaces; references keep them. */
function escapeAttr(text: string, field: string): string {
  return escapeXml(text, field).replace(/\n/g, '&#10;').replace(/\t/g, '&#9;');
}

class XmlLines {
  readonly lines: string[] = [];
  private depth = 0;

  open(tag: string, attrs: Record<string, string | undefined> = {}): void {
    this.lines.push(`${this.indent()}<${tag}${renderAttrs(tag, attrs)}>`);
    this.depth++;
  }

  close(tag: string): void {
    this.depth--;
    this.lines.push(`${this.indent()}</${tag}>`);
  }

  leaf(tag: string, text: string, attrs: Record<string, string | undefined> = {}): void {
    this.lines.push(`${this.indent()}<${tag}${renderAttrs(tag, attrs)}>${escapeXml(text, tag)}</${tag}>`);
  }

  empty(tag: string, attrs: Record<string, string | undefined> = {}): void {
    this.lines.push(`${this.indent()}<${tag}${renderAttrs(tag, attrs)}/>`);
  }

  private indent(): string {
    return '  '.repeat(this.depth);
  }
}

function renderAttrs(tag: string, attrs: Record<string, string | undefined>): string {
  let out = '';
  for (const [key, value] of Object.entries(attrs)) {
    if (value !== undefined) out += ` ${key}="${escapeAttr(value, `${tag} "${key}"`)}"`;
  }
  return out;
}

type RestrictionFamily = Exclude<IDSConstraint, { type: 'simpleValue' }>;

function refuse(what: string): never {
  throw new Error(`writeIdsXml: ${what} are not supported by this writer`);
}

/**
 * The facet families of one `<xs:restriction>`: the primary constraint and
 * its conjunctive `and` siblings (see `constraint-types.ts`). One restriction
 * holds one base and at most one family of each kind, since XSD ORs sibling
 * patterns and enumerations; anything else has no single-restriction XML and
 * is refused, never written as a weaker or different check.
 */
function restrictionFamilies(constraint: RestrictionFamily): RestrictionFamily[] {
  const families: RestrictionFamily[] = [constraint];
  for (const sibling of constraint.and ?? []) {
    if (sibling.type === 'simpleValue') refuse('simple values inside a conjunctive restriction');
    if (sibling.and?.length) refuse('nested conjunctive restriction facets');
    if (families.some((family) => family.type === sibling.type)) refuse(`two ${sibling.type} families in one conjunctive restriction`);
    families.push(sibling);
  }
  const bases = new Set(families.map((family) => family.base).filter((base) => base !== undefined));
  if (bases.size > 1) refuse('conjunctive restriction facets with different bases');
  return families;
}

/** `xs:length`, `xs:minLength`, `xs:maxLength` and the digit counts are `xs:nonNegativeInteger`. */
function countLexical(facet: string, value: number): string {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`writeIdsXml: ${facet} must be a non-negative integer, got ${value}`);
  }
  return String(value);
}

/** Bases whose lexical space has an exponent: `xs:double` and `xs:float`. */
const EXPONENT_BASES = new Set(['xs:double', 'xs:float']);

/**
 * A bound in its base's lexical space. `String(1e-7)` is `"1e-7"`, which
 * `xs:decimal` and the integer types cannot read, so the exponent is expanded
 * into plain digits there; the digits are the same, so `parseFloat` reads
 * back the identical number.
 */
function boundLexical(facet: string, value: number, base: string): string {
  if (!Number.isFinite(value)) throw new Error(`writeIdsXml: ${facet} must be a finite number, got ${value}`);
  const text = String(value);
  if (EXPONENT_BASES.has(base) || !/e/i.test(text)) return text;
  return expandExponent(text);
}

function expandExponent(text: string): string {
  const match = /^(-?)(\d+)(?:\.(\d+))?e([+-]\d+)$/i.exec(text);
  if (!match) return text;
  const [, sign, whole, fraction = '', exponentText] = match;
  const digits = whole + fraction;
  const point = whole.length + Number(exponentText);
  if (point <= 0) return `${sign}0.${'0'.repeat(-point)}${digits}`;
  if (point >= digits.length) return `${sign}${digits}${'0'.repeat(point - digits.length)}`;
  return `${sign}${digits.slice(0, point)}.${digits.slice(point)}`;
}

function writeBounds(xml: XmlLines, constraint: Extract<IDSConstraint, { type: 'bounds' }>, base: string): void {
  if (constraint.unparseableFacets?.length) refuse('unparseable bound facets');
  const bounds: Array<[string, number | undefined]> = [
    ['xs:minInclusive', constraint.minInclusive],
    ['xs:minExclusive', constraint.minExclusive],
    ['xs:maxInclusive', constraint.maxInclusive],
    ['xs:maxExclusive', constraint.maxExclusive],
  ];
  const counts: Array<[string, number | undefined]> = [
    ['xs:length', constraint.length],
    ['xs:minLength', constraint.minLength],
    ['xs:maxLength', constraint.maxLength],
    ['xs:totalDigits', constraint.totalDigits],
    ['xs:fractionDigits', constraint.fractionDigits],
  ];
  // With no facet the restriction would be empty, which reads back as an empty enumeration.
  if ([...bounds, ...counts].every(([, value]) => value === undefined)) refuse('bounds restrictions without any facet');
  for (const [facet, value] of bounds) {
    if (value !== undefined) xml.empty(facet, { value: boundLexical(facet, value, base) });
  }
  for (const [facet, value] of counts) {
    if (value !== undefined) xml.empty(facet, { value: countLexical(facet, value) });
  }
}

/** The base written when the model carries none: `xs:double` for a numeric bounds restriction, else `xs:string`. */
function defaultBase(families: readonly RestrictionFamily[]): string {
  const primary = families[0];
  if (primary.type !== 'bounds') return 'xs:string';
  const numeric = [primary.minInclusive, primary.minExclusive, primary.maxInclusive, primary.maxExclusive, primary.totalDigits, primary.fractionDigits];
  return numeric.some((value) => value !== undefined) ? 'xs:double' : 'xs:string';
}

function writeRestriction(xml: XmlLines, constraint: RestrictionFamily): void {
  const families = restrictionFamilies(constraint);
  const base = families.find((family) => family.base !== undefined)?.base ?? defaultBase(families);
  xml.open('xs:restriction', { base });
  for (const family of families) {
    switch (family.type) {
      case 'pattern':
        xml.empty('xs:pattern', { value: family.pattern });
        break;
      case 'enumeration':
        for (const value of family.values) xml.empty('xs:enumeration', { value });
        break;
      case 'bounds':
        writeBounds(xml, family, base);
        break;
    }
  }
  xml.close('xs:restriction');
}

function writeConstraint(xml: XmlLines, tag: string, constraint: IDSConstraint): void {
  xml.open(tag);
  if (constraint.type === 'simpleValue') xml.leaf('simpleValue', constraint.value);
  else writeRestriction(xml, constraint);
  xml.close(tag);
}

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
