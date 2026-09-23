/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Serialise an `IDSDocument` as IDS 1.0 XML (#5225). Covers the subset of
 * the model `ruleSetToIds` produces: entity, attribute, property,
 * classification and material facets, with simple-value, pattern,
 * enumeration and numeric-bound constraints. Element order follows
 * `ids.xsd`, so `parseIDS` and `auditIDSDocument` read the result back.
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

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

class XmlLines {
  readonly lines: string[] = [];
  private depth = 0;

  open(tag: string, attrs: Record<string, string | undefined> = {}): void {
    this.lines.push(`${this.indent()}<${tag}${renderAttrs(attrs)}>`);
    this.depth++;
  }

  close(tag: string): void {
    this.depth--;
    this.lines.push(`${this.indent()}</${tag}>`);
  }

  leaf(tag: string, text: string, attrs: Record<string, string | undefined> = {}): void {
    this.lines.push(`${this.indent()}<${tag}${renderAttrs(attrs)}>${escapeXml(text)}</${tag}>`);
  }

  empty(tag: string, attrs: Record<string, string | undefined> = {}): void {
    this.lines.push(`${this.indent()}<${tag}${renderAttrs(attrs)}/>`);
  }

  private indent(): string {
    return '  '.repeat(this.depth);
  }
}

function renderAttrs(attrs: Record<string, string | undefined>): string {
  let out = '';
  for (const [key, value] of Object.entries(attrs)) {
    if (value !== undefined) out += ` ${key}="${escapeXml(value)}"`;
  }
  return out;
}

function writeConstraint(xml: XmlLines, tag: string, constraint: IDSConstraint): void {
  xml.open(tag);
  switch (constraint.type) {
    case 'simpleValue':
      xml.leaf('simpleValue', constraint.value);
      break;
    case 'pattern':
      xml.open('xs:restriction', { base: constraint.base ?? 'xs:string' });
      xml.empty('xs:pattern', { value: constraint.pattern });
      xml.close('xs:restriction');
      break;
    case 'enumeration':
      xml.open('xs:restriction', { base: constraint.base ?? 'xs:string' });
      for (const value of constraint.values) xml.empty('xs:enumeration', { value });
      xml.close('xs:restriction');
      break;
    case 'bounds': {
      xml.open('xs:restriction', { base: constraint.base ?? 'xs:double' });
      const bounds: Array<[string, number | undefined]> = [
        ['xs:minInclusive', constraint.minInclusive],
        ['xs:minExclusive', constraint.minExclusive],
        ['xs:maxInclusive', constraint.maxInclusive],
        ['xs:maxExclusive', constraint.maxExclusive],
      ];
      for (const [facet, value] of bounds) {
        if (value !== undefined) xml.empty(facet, { value: String(value) });
      }
      xml.close('xs:restriction');
      break;
    }
  }
  xml.close(tag);
}

function writeFacet(xml: XmlLines, facet: IDSFacet, cardinality: string | undefined): void {
  switch (facet.type) {
    case 'entity':
      xml.open('entity');
      writeConstraint(xml, 'name', facet.name);
      if (facet.predefinedType) writeConstraint(xml, 'predefinedType', facet.predefinedType);
      xml.close('entity');
      return;
    case 'attribute':
      xml.open('attribute', { cardinality });
      writeConstraint(xml, 'name', facet.name);
      if (facet.value) writeConstraint(xml, 'value', facet.value);
      xml.close('attribute');
      return;
    case 'property':
      xml.open('property', { cardinality });
      writeConstraint(xml, 'propertySet', facet.propertySet);
      writeConstraint(xml, 'baseName', facet.baseName);
      if (facet.value) writeConstraint(xml, 'value', facet.value);
      xml.close('property');
      return;
    case 'classification':
      xml.open('classification', { cardinality });
      if (facet.value) writeConstraint(xml, 'value', facet.value);
      if (facet.system) writeConstraint(xml, 'system', facet.system);
      xml.close('classification');
      return;
    case 'material':
      xml.open('material', { cardinality });
      if (facet.value) writeConstraint(xml, 'value', facet.value);
      xml.close('material');
      return;
    case 'partOf':
      // `ruleSetToIds` never produces one (a rule's `parent` subject matches
      // an ancestor's Name, not its class); refusing here keeps the writer
      // honest if a caller hands it a document from elsewhere.
      throw new Error('writeIdsXml: partOf facets are not supported by this writer');
  }
}

function writeRequirement(xml: XmlLines, requirement: IDSRequirement): void {
  // IDS 1.0 has no cardinality on an entity facet inside requirements.
  const cardinality = requirement.facet.type === 'entity' ? undefined : requirement.optionality;
  writeFacet(xml, requirement.facet, cardinality);
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
