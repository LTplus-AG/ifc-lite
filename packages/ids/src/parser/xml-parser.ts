/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * IDS XML Parser
 * Parses buildingSMART IDS 1.0 XML files
 */

import type {
  IDSDocument,
  IDSInfo,
  IDSSpecification,
  IDSApplicability,
  IDSRequirement,
  IDSFacet,
  IDSEntityFacet,
  IDSAttributeFacet,
  IDSPropertyFacet,
  IDSClassificationFacet,
  IDSMaterialFacet,
  IDSPartOfFacet,
  IDSConstraint,
  IDSSimpleValue,
  IDSPatternConstraint,
  IDSEnumerationConstraint,
  IDSBoundsConstraint,
  IFCVersion,
  RequirementOptionality,
  PartOfRelation,
} from '../types.js';

const IDS_NAMESPACE = 'http://standards.buildingsmart.org/IDS';
const XS_NAMESPACE = 'http://www.w3.org/2001/XMLSchema';

/** Error thrown when parsing invalid IDS XML */
export class IDSParseError extends Error {
  constructor(
    message: string,
    public details?: string
  ) {
    super(message);
    this.name = 'IDSParseError';
  }
}

// `DOMParser` exists in browsers and in test envs (happy-dom/jsdom). In plain
// Node it's undefined, so fall back to @xmldom/xmldom. The dynamic import is
// hidden behind a runtime-computed specifier so browser bundlers don't pull
// xmldom into the client bundle.
type DOMParserCtor = new () => { parseFromString(input: string, mime: string): Document };
let DOMParserImpl: DOMParserCtor | null =
  typeof globalThis !== 'undefined' && typeof (globalThis as { DOMParser?: DOMParserCtor }).DOMParser === 'function'
    ? ((globalThis as { DOMParser?: DOMParserCtor }).DOMParser as DOMParserCtor)
    : null;
if (!DOMParserImpl) {
  const moduleName = '@xmldom/xmldom';
  const xmldom = (await import(/* @vite-ignore */ moduleName)) as { DOMParser: DOMParserCtor };
  DOMParserImpl = xmldom.DOMParser;
}

/**
 * Parse IDS XML content into an IDSDocument
 */
export function parseIDS(xmlContent: string | ArrayBuffer): IDSDocument {
  let xmlString =
    typeof xmlContent === 'string'
      ? xmlContent
      : new TextDecoder().decode(xmlContent);
  // Strip a leading UTF-8 BOM if present — xmldom rejects it as
  // "unexpected content outside root element". Real-world IDS files
  // saved by Windows tooling commonly include the BOM.
  if (xmlString.charCodeAt(0) === 0xfeff) {
    xmlString = xmlString.slice(1);
  }

  if (!DOMParserImpl) {
    throw new IDSParseError(
      'No DOMParser implementation available',
      'Neither globalThis.DOMParser nor @xmldom/xmldom could be loaded.',
    );
  }
  const parser = new DOMParserImpl();

  // Browser DOMParser → returns a Document with a <parsererror> element on
  // malformed input. xmldom v0.9 → throws on fatalError (and may also leave
  // a partial Document with no documentElement). Normalise both paths to a
  // single IDSParseError so callers see consistent failures.
  let doc: Document;
  try {
    doc = parser.parseFromString(xmlString, 'text/xml');
  } catch (err) {
    throw new IDSParseError(
      'Failed to parse IDS XML',
      err instanceof Error ? err.message : String(err),
    );
  }

  const parseError =
    typeof (doc as { querySelector?: (s: string) => Element | null }).querySelector === 'function'
      ? (doc as { querySelector: (s: string) => Element | null }).querySelector('parsererror')
      : null;
  if (parseError) {
    throw new IDSParseError(
      'Invalid XML format',
      parseError.textContent || undefined
    );
  }

  const root = doc.documentElement;
  // xmldom can return a Document with no root on certain error modes —
  // surface that as a parse error rather than a confusing TypeError on
  // root.localName below.
  if (!root) {
    throw new IDSParseError(
      'Failed to parse IDS XML',
      'Parser returned a document with no root element.',
    );
  }

  // Validate root element
  if (root.localName !== 'ids') {
    throw new IDSParseError(
      `Invalid root element: expected "ids", got "${root.localName}"`
    );
  }

  return {
    info: parseInfo(root),
    specifications: parseSpecifications(root),
    schemaLocation:
      root.getAttribute('xsi:schemaLocation') ||
      root.getAttributeNS('http://www.w3.org/2001/XMLSchema-instance', 'schemaLocation') ||
      undefined,
  };
}

/**
 * Parse the <info> section
 */
function parseInfo(root: Element): IDSInfo {
  const info = getChildElement(root, 'info');
  if (!info) {
    return { title: 'Untitled IDS' };
  }

  return {
    title: getChildText(info, 'title') || 'Untitled IDS',
    copyright: getChildText(info, 'copyright'),
    version: getChildText(info, 'version'),
    author: getChildText(info, 'author'),
    date: getChildText(info, 'date'),
    purpose: getChildText(info, 'purpose'),
    milestone: getChildText(info, 'milestone'),
    description: getChildText(info, 'description'),
  };
}

/**
 * Parse the <specifications> section
 */
function parseSpecifications(root: Element): IDSSpecification[] {
  const specsContainer = getChildElement(root, 'specifications');
  if (!specsContainer) {
    return [];
  }

  const specElements = getChildElements(specsContainer, 'specification');
  return specElements.map((el, index) => parseSpecification(el, index));
}

/**
 * Parse a single <specification>
 */
function parseSpecification(el: Element, index: number): IDSSpecification {
  const name = el.getAttribute('name') || `Specification ${index + 1}`;
  const ifcVersionAttr = el.getAttribute('ifcVersion') || 'IFC4';

  // Parse IFC versions (can be space-separated)
  const ifcVersions = ifcVersionAttr
    .split(/\s+/)
    .map((v) => normalizeIfcVersion(v))
    .filter((v): v is IFCVersion => v !== null);

  // Parse applicability
  const applicabilityEl = getChildElement(el, 'applicability');
  const applicability: IDSApplicability = {
    facets: applicabilityEl ? parseFacets(applicabilityEl) : [],
    cardinality: applicabilityEl?.getAttribute('cardinality') ?? undefined,
  };

  // Parse minOccurs/maxOccurs with NaN validation
  // Per IDS 1.0 spec, these are on the <applicability> element,
  // but also check the <specification> element for backwards compatibility
  // Use nullish coalescing (??) instead of || because "0" is falsy in JS
  // but is a valid attribute value for minOccurs/maxOccurs
  const minOccursAttr =
    (applicabilityEl ? applicabilityEl.getAttribute('minOccurs') : null) ??
    el.getAttribute('minOccurs');
  const maxOccursAttr =
    (applicabilityEl ? applicabilityEl.getAttribute('maxOccurs') : null) ??
    el.getAttribute('maxOccurs');

  let minOccurs: number | undefined;
  if (minOccursAttr !== null) {
    const parsed = parseInt(minOccursAttr, 10);
    if (Number.isFinite(parsed)) {
      minOccurs = parsed;
    }
  }

  let maxOccurs: number | 'unbounded' | undefined;
  if (maxOccursAttr !== null) {
    const parsed = parseInt(maxOccursAttr, 10);
    if (maxOccursAttr === 'unbounded') {
      maxOccurs = 'unbounded';
    } else if (Number.isFinite(parsed)) {
      maxOccurs = parsed;
    }
  }

  // Parse requirements
  const requirementsEl = getChildElement(el, 'requirements');
  const requirements: IDSRequirement[] = requirementsEl
    ? parseRequirements(requirementsEl)
    : [];

  return {
    id: el.getAttribute('identifier') || `spec-${index}`,
    name,
    description: el.getAttribute('description') || undefined,
    instructions: el.getAttribute('instructions') || undefined,
    identifier: el.getAttribute('identifier') || undefined,
    ifcVersions: ifcVersions.length > 0 ? ifcVersions : ['IFC4'],
    ifcVersionRaw: el.getAttribute('ifcVersion') || undefined,
    applicability,
    requirements,
    minOccurs,
    maxOccurs,
  };
}

/**
 * Normalize IFC version string
 */
function normalizeIfcVersion(version: string): IFCVersion | null {
  const upper = version.toUpperCase().replace(/[^A-Z0-9]/g, '');
  switch (upper) {
    case 'IFC2X3':
      return 'IFC2X3';
    case 'IFC4':
      return 'IFC4';
    case 'IFC4X3':
    case 'IFC4X3ADD2':
      return 'IFC4X3';
    default:
      // Try to match common patterns
      if (upper.startsWith('IFC4X3')) return 'IFC4X3';
      if (upper.startsWith('IFC4')) return 'IFC4';
      if (upper.startsWith('IFC2X3')) return 'IFC2X3';
      return null;
  }
}

/**
 * Parse facets from an element (applicability or requirements)
 */
function parseFacets(parent: Element): IDSFacet[] {
  const facets: IDSFacet[] = [];

  for (const child of Array.from(parent.children)) {
    const facet = parseFacet(child);
    if (facet) {
      facets.push(facet);
    }
  }

  return facets;
}

/**
 * Parse a single facet element
 */
function parseFacet(el: Element): IDSFacet | null {
  const localName = el.localName.toLowerCase();

  switch (localName) {
    case 'entity':
      return parseEntityFacet(el);
    case 'attribute':
      return parseAttributeFacet(el);
    case 'property':
      return parsePropertyFacet(el);
    case 'classification':
      return parseClassificationFacet(el);
    case 'material':
      return parseMaterialFacet(el);
    case 'partof':
      return parsePartOfFacet(el);
    default:
      return null;
  }
}

/**
 * Parse entity facet
 */
function parseEntityFacet(el: Element): IDSEntityFacet {
  const nameEl = getChildElement(el, 'name');
  const predefinedTypeEl = getChildElement(el, 'predefinedType');

  if (!nameEl) {
    throw new IDSParseError('Entity facet must have a name element');
  }

  return {
    type: 'entity',
    name: parseConstraintElement(nameEl),
    predefinedType: predefinedTypeEl
      ? parseConstraintElement(predefinedTypeEl)
      : undefined,
  };
}

/**
 * Parse attribute facet
 */
function parseAttributeFacet(el: Element): IDSAttributeFacet {
  const nameEl = getChildElement(el, 'name');
  const valueEl = getChildElement(el, 'value');

  if (!nameEl) {
    throw new IDSParseError('Attribute facet must have a name element');
  }

  return {
    type: 'attribute',
    name: parseConstraintElement(nameEl),
    value: valueEl ? parseConstraintElement(valueEl) : undefined,
  };
}

/**
 * Parse property facet
 */
function parsePropertyFacet(el: Element): IDSPropertyFacet {
  const propertySetEl = getChildElement(el, 'propertySet');
  const baseNameEl = getChildElement(el, 'baseName');
  // IDS 1.0 puts dataType on the @dataType *attribute* (see upstream
  // IdsProperty.cs). Older 0.9.7 documents used a <dataType> *child*
  // element. Support both — attribute wins when present.
  const dataTypeAttr = el.getAttribute('dataType');
  const dataTypeEl = getChildElement(el, 'dataType');
  const valueEl = getChildElement(el, 'value');

  if (!propertySetEl) {
    throw new IDSParseError('Property facet must have a propertySet element');
  }
  if (!baseNameEl) {
    throw new IDSParseError('Property facet must have a baseName element');
  }

  let dataType: IDSConstraint | undefined;
  if (dataTypeAttr) {
    dataType = { type: 'simpleValue', value: dataTypeAttr };
  } else if (dataTypeEl) {
    dataType = parseConstraintElement(dataTypeEl);
  }

  return {
    type: 'property',
    propertySet: parseConstraintElement(propertySetEl),
    baseName: parseConstraintElement(baseNameEl),
    dataType,
    value: valueEl ? parseConstraintElement(valueEl) : undefined,
  };
}

/**
 * Parse classification facet
 */
function parseClassificationFacet(el: Element): IDSClassificationFacet {
  const systemEl = getChildElement(el, 'system');
  const valueEl = getChildElement(el, 'value');

  return {
    type: 'classification',
    system: systemEl ? parseConstraintElement(systemEl) : undefined,
    value: valueEl ? parseConstraintElement(valueEl) : undefined,
  };
}

/**
 * Parse material facet
 */
function parseMaterialFacet(el: Element): IDSMaterialFacet {
  const valueEl = getChildElement(el, 'value');

  return {
    type: 'material',
    value: valueEl ? parseConstraintElement(valueEl) : undefined,
  };
}

/**
 * Parse partOf facet
 */
function parsePartOfFacet(el: Element): IDSPartOfFacet {
  const relationAttrRaw = el.getAttribute('relation');
  const relationAttr = relationAttrRaw || 'IfcRelContainedInSpatialStructure';
  const entityEl = getChildElement(el, 'entity');

  const relation = normalizePartOfRelation(relationAttr);
  // When the source attribute didn't map cleanly onto one of the known
  // relations (or was missing), preserve the original string so the
  // auditor can flag the discrepancy without us breaking the existing
  // narrow `PartOfRelation` enum.
  const recognised = isRecognisedPartOfRelation(relationAttr);
  const facet: IDSPartOfFacet = {
    type: 'partOf',
    relation,
    entity: entityEl ? parseEntityFacet(entityEl) : undefined,
  };
  if (!recognised && relationAttrRaw) {
    facet.rawRelation = relationAttrRaw;
  }
  return facet;
}

function isRecognisedPartOfRelation(relation: string): boolean {
  switch (relation) {
    case 'IfcRelAggregates':
    case 'IfcRelContainedInSpatialStructure':
    case 'IfcRelNests':
    case 'IfcRelVoidsElement':
    case 'IfcRelFillsElement':
    case 'IfcRelAssignsToGroup':
      return true;
    default:
      return false;
  }
}

/**
 * Normalize partOf relation string
 */
function normalizePartOfRelation(relation: string): PartOfRelation {
  const upper = relation.toUpperCase();
  if (upper.includes('AGGREGATE')) return 'IfcRelAggregates';
  if (upper.includes('CONTAINED') || upper.includes('SPATIAL'))
    return 'IfcRelContainedInSpatialStructure';
  if (upper.includes('NEST')) return 'IfcRelNests';
  if (upper.includes('VOID')) return 'IfcRelVoidsElement';
  if (upper.includes('FILL')) return 'IfcRelFillsElement';
  return 'IfcRelContainedInSpatialStructure';
}

/**
 * Parse requirements section
 */
function parseRequirements(parent: Element): IDSRequirement[] {
  const requirements: IDSRequirement[] = [];
  let reqIndex = 0;

  for (const child of Array.from(parent.children)) {
    const facet = parseFacet(child);
    if (facet) {
      // IDS 1.0 uses `cardinality="required|optional|prohibited"` on the
      // requirement facet. 0.9.7 used minOccurs/maxOccurs. Honour both;
      // the cardinality attribute wins when present.
      const cardinalityAttr = child.getAttribute('cardinality');
      const minOccurs = child.getAttribute('minOccurs');
      const maxOccurs = child.getAttribute('maxOccurs');

      let optionality: RequirementOptionality = 'required';
      // The XSD enum values are case-sensitive lowercase; preserve any
      // non-canonical raw input so the auditor can flag it instead of
      // letting the parser silently default to `required`.
      let cardinalityRaw: string | undefined;
      if (cardinalityAttr !== null) {
        if (
          cardinalityAttr === 'required' ||
          cardinalityAttr === 'optional' ||
          cardinalityAttr === 'prohibited'
        ) {
          optionality = cardinalityAttr as RequirementOptionality;
        } else {
          // Tolerate case differences for the runtime mapping (so
          // `"Required"` still parses) but record the raw value so the
          // audit can flag it.
          const lower = cardinalityAttr.toLowerCase();
          if (
            lower === 'required' ||
            lower === 'optional' ||
            lower === 'prohibited'
          ) {
            optionality = lower as RequirementOptionality;
          }
          cardinalityRaw = cardinalityAttr;
        }
      } else if (minOccurs === '0' && maxOccurs === '0') {
        optionality = 'prohibited';
      } else if (minOccurs === '0') {
        optionality = 'optional';
      }

      requirements.push({
        id: `req-${reqIndex++}`,
        facet,
        optionality,
        cardinalityRaw,
        description: child.getAttribute('description') || undefined,
        instructions: child.getAttribute('instructions') || undefined,
      });
    }
  }

  return requirements;
}

/**
 * Parse a constraint element (can be simpleValue, restriction with pattern/enumeration/bounds)
 */
function parseConstraintElement(el: Element): IDSConstraint {
  // Check for simpleValue child
  const simpleValueEl = getChildElement(el, 'simpleValue');
  if (simpleValueEl) {
    return {
      type: 'simpleValue',
      value: simpleValueEl.textContent?.trim() || '',
    } satisfies IDSSimpleValue;
  }

  // Check for restriction child (XSD-style)
  const restrictionEl =
    getChildElementNS(el, 'restriction', XS_NAMESPACE) ||
    getChildElement(el, 'restriction');
  if (restrictionEl) {
    return parseRestriction(restrictionEl);
  }

  // Check direct text content (simple case)
  const textContent = el.textContent?.trim();
  if (textContent) {
    return {
      type: 'simpleValue',
      value: textContent,
    } satisfies IDSSimpleValue;
  }

  // Default to empty simple value
  return {
    type: 'simpleValue',
    value: '',
  };
}

/**
 * Parse XSD restriction element
 */
function parseRestriction(el: Element): IDSConstraint {
  // Capture the `@base` attribute so the auditor can compare against
  // an IFC dataType's backing XSD type without inferring from the
  // restriction shape (which is ambiguous for numeric enumerations).
  const base = el.getAttribute('base') || undefined;

  // Check for pattern
  const patternEl =
    getChildElementNS(el, 'pattern', XS_NAMESPACE) ||
    getChildElement(el, 'pattern');
  if (patternEl) {
    return {
      type: 'pattern',
      pattern: patternEl.getAttribute('value') || patternEl.textContent || '',
      base,
    } satisfies IDSPatternConstraint;
  }

  // Check for enumeration
  const enumEls = getChildElementsNS(el, 'enumeration', XS_NAMESPACE);
  if (enumEls.length === 0) {
    // Try without namespace
    const enumElsNoNS = getChildElements(el, 'enumeration');
    if (enumElsNoNS.length > 0) {
      return {
        type: 'enumeration',
        values: enumElsNoNS.map(
          (e) => e.getAttribute('value') || e.textContent || ''
        ),
        base,
      } satisfies IDSEnumerationConstraint;
    }
  } else {
    return {
      type: 'enumeration',
      values: enumEls.map(
        (e) => e.getAttribute('value') || e.textContent || ''
      ),
      base,
    } satisfies IDSEnumerationConstraint;
  }

  // Check for bounds (minInclusive, maxInclusive, minExclusive,
  // maxExclusive, length, minLength, maxLength).
  const facetEls: Record<string, Element | null> = {};
  for (const facet of [
    'minInclusive',
    'maxInclusive',
    'minExclusive',
    'maxExclusive',
    'length',
    'minLength',
    'maxLength',
  ]) {
    facetEls[facet] =
      getChildElementNS(el, facet, XS_NAMESPACE) ||
      getChildElement(el, facet);
  }

  if (Object.values(facetEls).some((e) => e !== null)) {
    const bounds: IDSBoundsConstraint = { type: 'bounds', base };
    const readNumber = (e: Element | null): number | undefined => {
      if (!e) return undefined;
      const v = parseFloat(e.getAttribute('value') || e.textContent || '');
      return Number.isFinite(v) ? v : undefined;
    };
    const readInt = (e: Element | null): number | undefined => {
      if (!e) return undefined;
      const v = parseInt(e.getAttribute('value') || e.textContent || '', 10);
      return Number.isFinite(v) && v >= 0 ? v : undefined;
    };
    bounds.minInclusive = readNumber(facetEls.minInclusive);
    bounds.maxInclusive = readNumber(facetEls.maxInclusive);
    bounds.minExclusive = readNumber(facetEls.minExclusive);
    bounds.maxExclusive = readNumber(facetEls.maxExclusive);
    bounds.length = readInt(facetEls.length);
    bounds.minLength = readInt(facetEls.minLength);
    bounds.maxLength = readInt(facetEls.maxLength);
    return bounds;
  }

  // No recognised pattern/enumeration/bounds child. If the element only
  // carries a `base` attribute (the common "empty restriction" authoring
  // mistake — e.g. `<xs:restriction base="xs:string"/>`), surface an
  // empty enumeration so the coherence auditor can flag it. Otherwise
  // fall through to text content.
  const text = el.textContent?.trim() || '';
  if (base && text === '') {
    return {
      type: 'enumeration',
      values: [],
      base,
    } satisfies IDSEnumerationConstraint;
  }
  if (text) {
    return { type: 'simpleValue', value: text };
  }
  return { type: 'enumeration', values: [], base } satisfies IDSEnumerationConstraint;
}

// ============================================================================
// DOM Helper Functions
// ============================================================================

function getChildElement(parent: Element, localName: string): Element | null {
  for (const child of Array.from(parent.children)) {
    if (child.localName.toLowerCase() === localName.toLowerCase()) {
      return child;
    }
  }
  return null;
}

function getChildElements(parent: Element, localName: string): Element[] {
  const elements: Element[] = [];
  for (const child of Array.from(parent.children)) {
    if (child.localName.toLowerCase() === localName.toLowerCase()) {
      elements.push(child);
    }
  }
  return elements;
}

function getChildElementNS(
  parent: Element,
  localName: string,
  namespace: string
): Element | null {
  for (const child of Array.from(parent.children)) {
    if (
      child.localName.toLowerCase() === localName.toLowerCase() &&
      child.namespaceURI === namespace
    ) {
      return child;
    }
  }
  return null;
}

function getChildElementsNS(
  parent: Element,
  localName: string,
  namespace: string
): Element[] {
  const elements: Element[] = [];
  for (const child of Array.from(parent.children)) {
    if (
      child.localName.toLowerCase() === localName.toLowerCase() &&
      child.namespaceURI === namespace
    ) {
      elements.push(child);
    }
  }
  return elements;
}

function getChildText(parent: Element, localName: string): string | undefined {
  const child = getChildElement(parent, localName);
  return child?.textContent?.trim() || undefined;
}
