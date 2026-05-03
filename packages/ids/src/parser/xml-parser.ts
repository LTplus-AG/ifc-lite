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
  const xmlString =
    typeof xmlContent === 'string'
      ? xmlContent
      : new TextDecoder().decode(xmlContent);

  if (!DOMParserImpl) {
    throw new IDSParseError(
      'No DOMParser implementation available',
      'Neither globalThis.DOMParser nor @xmldom/xmldom could be loaded.',
    );
  }
  const parser = new DOMParserImpl();
  const doc = parser.parseFromString(xmlString, 'text/xml');

  // Browser DOMParser surfaces parse errors as a <parsererror> element. xmldom
  // does not emit one (it uses errorHandler), but it returns a usable Document
  // even for malformed input — we rely on root-element validation below to
  // catch obviously bad payloads.
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

  // Validate root element
  if (root.localName !== 'ids') {
    throw new IDSParseError(
      `Invalid root element: expected "ids", got "${root.localName}"`
    );
  }

  return {
    info: parseInfo(root),
    specifications: parseSpecifications(root),
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
  const dataTypeEl = getChildElement(el, 'dataType');
  const valueEl = getChildElement(el, 'value');

  if (!propertySetEl) {
    throw new IDSParseError('Property facet must have a propertySet element');
  }
  if (!baseNameEl) {
    throw new IDSParseError('Property facet must have a baseName element');
  }

  return {
    type: 'property',
    propertySet: parseConstraintElement(propertySetEl),
    baseName: parseConstraintElement(baseNameEl),
    dataType: dataTypeEl ? parseConstraintElement(dataTypeEl) : undefined,
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
  const relationAttr = el.getAttribute('relation') || 'IfcRelContainedInSpatialStructure';
  const entityEl = getChildElement(el, 'entity');

  const relation = normalizePartOfRelation(relationAttr);

  return {
    type: 'partOf',
    relation,
    entity: entityEl ? parseEntityFacet(entityEl) : undefined,
  };
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
      // Get optionality from the element
      const minOccurs = child.getAttribute('minOccurs');
      const maxOccurs = child.getAttribute('maxOccurs');

      let optionality: RequirementOptionality = 'required';
      if (minOccurs === '0' && maxOccurs === '0') {
        optionality = 'prohibited';
      } else if (minOccurs === '0') {
        optionality = 'optional';
      }

      requirements.push({
        id: `req-${reqIndex++}`,
        facet,
        optionality,
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
  // Check for pattern
  const patternEl =
    getChildElementNS(el, 'pattern', XS_NAMESPACE) ||
    getChildElement(el, 'pattern');
  if (patternEl) {
    return {
      type: 'pattern',
      pattern: patternEl.getAttribute('value') || patternEl.textContent || '',
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
      } satisfies IDSEnumerationConstraint;
    }
  } else {
    return {
      type: 'enumeration',
      values: enumEls.map(
        (e) => e.getAttribute('value') || e.textContent || ''
      ),
    } satisfies IDSEnumerationConstraint;
  }

  // Check for bounds (minInclusive, maxInclusive, minExclusive, maxExclusive)
  const minInclusiveEl =
    getChildElementNS(el, 'minInclusive', XS_NAMESPACE) ||
    getChildElement(el, 'minInclusive');
  const maxInclusiveEl =
    getChildElementNS(el, 'maxInclusive', XS_NAMESPACE) ||
    getChildElement(el, 'maxInclusive');
  const minExclusiveEl =
    getChildElementNS(el, 'minExclusive', XS_NAMESPACE) ||
    getChildElement(el, 'minExclusive');
  const maxExclusiveEl =
    getChildElementNS(el, 'maxExclusive', XS_NAMESPACE) ||
    getChildElement(el, 'maxExclusive');

  if (minInclusiveEl || maxInclusiveEl || minExclusiveEl || maxExclusiveEl) {
    const bounds: IDSBoundsConstraint = {
      type: 'bounds',
    };

    if (minInclusiveEl) {
      const val = parseFloat(
        minInclusiveEl.getAttribute('value') ||
          minInclusiveEl.textContent ||
          ''
      );
      if (!isNaN(val)) {
        bounds.minInclusive = val;
      }
    }
    if (maxInclusiveEl) {
      const val = parseFloat(
        maxInclusiveEl.getAttribute('value') ||
          maxInclusiveEl.textContent ||
          ''
      );
      if (!isNaN(val)) {
        bounds.maxInclusive = val;
      }
    }
    if (minExclusiveEl) {
      const val = parseFloat(
        minExclusiveEl.getAttribute('value') ||
          minExclusiveEl.textContent ||
          ''
      );
      if (!isNaN(val)) {
        bounds.minExclusive = val;
      }
    }
    if (maxExclusiveEl) {
      const val = parseFloat(
        maxExclusiveEl.getAttribute('value') ||
          maxExclusiveEl.textContent ||
          ''
      );
      if (!isNaN(val)) {
        bounds.maxExclusive = val;
      }
    }

    return bounds;
  }

  // Default: treat base attribute or text content as simple value
  const base = el.getAttribute('base');
  if (base) {
    return {
      type: 'simpleValue',
      value: base,
    };
  }

  return {
    type: 'simpleValue',
    value: el.textContent?.trim() || '',
  };
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
