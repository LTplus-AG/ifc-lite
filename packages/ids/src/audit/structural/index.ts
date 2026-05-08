/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Structural shape audit — walks the raw IDS XML DOM and verifies every
 * element/attribute against the IDS 1.0 XSD's element shapes.
 *
 * This is the precise contract upstream IDS-Audit-tool encodes in
 * `IdsXmlNode.cs` / `IdsRootElement.cs`: rather than running a generic
 * XSD validator, the auditor walks each known element and rejects
 * attributes/children that aren't part of that element's signature.
 *
 * The shapes encoded here mirror `Resources/XsdSchemas/ids.xsd`. When
 * upstream evolves the IDS schema, regenerate this table from the XSD.
 */

import type { IDSAuditIssue } from '../types.js';

const XS_NS = 'http://www.w3.org/2001/XMLSchema';

// `xmlns`, `xmlns:*`, `xsi:*`, `xml:*` are tolerated as global hooks —
// they're not specific to any IDS element but XML allows them anywhere.
const TOLERATED_GLOBAL_ATTR_PREFIXES = new Set(['xmlns', 'xsi', 'xml']);

/**
 * Element shape — the union of attributes and child-element local-names
 * the IDS XSD permits at this position. `attrs` lists the unprefixed
 * names; presence of any other (non-tolerated) attribute is an error.
 */
interface ElementShape {
  /** Allowed attribute local-names. */
  attrs: readonly string[];
  /** Required attribute local-names (subset of `attrs`). */
  requiredAttrs?: readonly string[];
  /** Allowed child element local-names. */
  children: readonly string[];
  /** Children allowed only as bare text content (no nested elements). */
  textOnly?: boolean;
  /** Allowed XSD-namespaced child local-names (e.g. `xs:restriction`). */
  xsChildren?: readonly string[];
}

const SHAPE_IDS: ElementShape = {
  attrs: [],
  children: ['info', 'specifications'],
};

const SHAPE_INFO: ElementShape = {
  attrs: [],
  children: [
    'title',
    'copyright',
    'version',
    'description',
    'author',
    'date',
    'purpose',
    'milestone',
  ],
};

const SHAPE_SPECIFICATIONS: ElementShape = {
  attrs: [],
  children: ['specification'],
};

const SHAPE_SPECIFICATION: ElementShape = {
  attrs: ['name', 'ifcVersion', 'identifier', 'description', 'instructions'],
  requiredAttrs: ['name', 'ifcVersion'],
  children: ['applicability', 'requirements'],
};

const SHAPE_APPLICABILITY: ElementShape = {
  // The XSD attaches the xs:occurs attribute group → minOccurs, maxOccurs.
  attrs: ['minOccurs', 'maxOccurs'],
  children: [
    'entity',
    'partOf',
    'classification',
    'attribute',
    'property',
    'material',
  ],
};

const SHAPE_REQUIREMENTS: ElementShape = {
  attrs: ['description'],
  children: [
    'entity',
    'partOf',
    'classification',
    'attribute',
    'property',
    'material',
  ],
};

// Per-facet shapes in *applicability* context (no cardinality / uri /
// instructions) vs *requirements* context (extension types per XSD).

const SHAPE_ENTITY_BODY: ElementShape = {
  attrs: [],
  children: ['name', 'predefinedType'],
};
const SHAPE_ATTRIBUTE_BODY: ElementShape = {
  attrs: [],
  children: ['name', 'value'],
};
const SHAPE_CLASSIFICATION_BODY: ElementShape = {
  attrs: [],
  children: ['value', 'system'],
};
const SHAPE_PARTOF_BODY: ElementShape = {
  attrs: ['relation'],
  children: ['entity'],
};
const SHAPE_PROPERTY_BODY: ElementShape = {
  attrs: ['dataType'],
  children: ['propertySet', 'baseName', 'value'],
};
const SHAPE_MATERIAL_BODY: ElementShape = {
  attrs: [],
  children: ['value'],
};

// In *requirements* context, the schema extends each facet with
// cardinality / instructions / uri (and entity gets just instructions).
function shapeInRequirements(facetTag: string): ElementShape {
  const base = facetBaseShape(facetTag);
  switch (facetTag.toLowerCase()) {
    case 'entity':
      return { ...base, attrs: [...base.attrs, 'instructions'] };
    case 'partof':
      return {
        ...base,
        attrs: [...base.attrs, 'cardinality', 'instructions'],
      };
    case 'attribute':
      return {
        ...base,
        attrs: [...base.attrs, 'cardinality', 'instructions'],
      };
    case 'classification':
    case 'property':
    case 'material':
      return {
        ...base,
        attrs: [...base.attrs, 'cardinality', 'instructions', 'uri'],
      };
    default:
      return base;
  }
}

function facetBaseShape(tag: string): ElementShape {
  // Tags arrive lowercased from `localName.toLowerCase()`. Match
  // case-insensitively so `partof` resolves to the partOf shape.
  switch (tag.toLowerCase()) {
    case 'entity':
      return SHAPE_ENTITY_BODY;
    case 'attribute':
      return SHAPE_ATTRIBUTE_BODY;
    case 'classification':
      return SHAPE_CLASSIFICATION_BODY;
    case 'partof':
      return SHAPE_PARTOF_BODY;
    case 'property':
      return SHAPE_PROPERTY_BODY;
    case 'material':
      return SHAPE_MATERIAL_BODY;
    default:
      return { attrs: [], children: [] };
  }
}

// idsValue (used for <name>, <value>, <baseName>, <propertySet>,
// <system>, <predefinedType>): choice of simpleValue OR xs:restriction.
const SHAPE_IDS_VALUE: ElementShape = {
  attrs: [],
  children: ['simpleValue'],
  xsChildren: ['restriction'],
};

const SHAPE_SIMPLE_VALUE: ElementShape = {
  attrs: [],
  children: [],
  textOnly: true,
};

// xs:restriction child facets the IDS XSD admits.
const XS_RESTRICTION_FACETS = [
  'enumeration',
  'pattern',
  'minInclusive',
  'maxInclusive',
  'minExclusive',
  'maxExclusive',
  'length',
  'minLength',
  'maxLength',
  'totalDigits',
  'fractionDigits',
  'whiteSpace',
];

const SHAPE_XS_RESTRICTION: ElementShape = {
  attrs: ['base'],
  children: [],
  xsChildren: XS_RESTRICTION_FACETS,
};

// Each xs:enumeration/xs:pattern/etc carries a `value` attribute.
const SHAPE_XS_FACET: ElementShape = {
  attrs: ['value'],
  children: [],
  textOnly: true,
};

/**
 * Walks the parsed XML root and emits issues for any element/attribute
 * outside the IDS XSD's shape. Re-uses xmldom/native DOMParser for the
 * walk so we have access to the original element tree (the high-level
 * `IDSDocument` shape can't tell us about extra attributes/elements
 * stripped during parsing).
 */
export async function runStructuralAudit(
  xml: string | ArrayBuffer
): Promise<IDSAuditIssue[]> {
  const issues: IDSAuditIssue[] = [];
  const xmlString =
    typeof xml === 'string' ? xml : new TextDecoder().decode(xml);
  // BOM strip — same fix as parser.
  const bomStripped =
    xmlString.charCodeAt(0) === 0xfeff ? xmlString.slice(1) : xmlString;
  const parser = await getParser();
  let doc: Document;
  try {
    doc = parser.parseFromString(bomStripped, 'text/xml');
  } catch {
    // Parse failure already surfaced by the permissive parser.
    return issues;
  }
  const root = doc.documentElement;
  if (!root || (root.localName ?? '').toLowerCase() !== 'ids') return issues;

  walkIds(root, issues);
  return issues;
}

type DOMParserCtor = new () => {
  parseFromString(input: string, mime: string): Document;
};
let parserPromise:
  | Promise<{
      parseFromString: (input: string, mime: string) => Document;
    }>
  | undefined;
function getParser(): Promise<{
  parseFromString: (input: string, mime: string) => Document;
}> {
  if (parserPromise) return parserPromise;
  parserPromise = (async () => {
    const browserCtor = (
      globalThis as { DOMParser?: DOMParserCtor }
    ).DOMParser;
    if (typeof browserCtor === 'function') return new browserCtor();
    // Hide the dynamic import behind a runtime-computed specifier so
    // browser bundlers don't pull xmldom into the client bundle.
    const moduleName = '@xmldom/xmldom';
    const xmldom = (await import(/* @vite-ignore */ moduleName)) as {
      DOMParser: DOMParserCtor;
    };
    return new xmldom.DOMParser();
  })();
  return parserPromise;
}

function walkIds(el: Element, issues: IDSAuditIssue[]): void {
  checkShape(el, SHAPE_IDS, 'ids', issues);
  for (const child of childElements(el)) {
    const ln = (child.localName ?? '').toLowerCase();
    if (ln === 'info') walkInfo(child, 'ids.info', issues);
    else if (ln === 'specifications')
      walkSpecifications(child, 'ids.specifications', issues);
  }
}

function walkInfo(
  el: Element,
  path: string,
  issues: IDSAuditIssue[]
): void {
  checkShape(el, SHAPE_INFO, path, issues);
  // Info children are leaf text nodes; don't recurse.
}

function walkSpecifications(
  el: Element,
  path: string,
  issues: IDSAuditIssue[]
): void {
  checkShape(el, SHAPE_SPECIFICATIONS, path, issues);
  let i = 0;
  for (const child of childElements(el)) {
    const ln = (child.localName ?? '').toLowerCase();
    if (ln === 'specification')
      walkSpecification(child, `${path}.specification[${i++}]`, issues);
  }
}

function walkSpecification(
  el: Element,
  path: string,
  issues: IDSAuditIssue[]
): void {
  checkShape(el, SHAPE_SPECIFICATION, path, issues);
  for (const child of childElements(el)) {
    const ln = (child.localName ?? '').toLowerCase();
    if (ln === 'applicability')
      walkFacetContainer(child, `${path}.applicability`, false, issues);
    else if (ln === 'requirements')
      walkFacetContainer(child, `${path}.requirements`, true, issues);
  }
}

function walkFacetContainer(
  el: Element,
  path: string,
  isRequirements: boolean,
  issues: IDSAuditIssue[]
): void {
  checkShape(
    el,
    isRequirements ? SHAPE_REQUIREMENTS : SHAPE_APPLICABILITY,
    path,
    issues
  );
  let i = 0;
  for (const child of childElements(el)) {
    const ln = (child.localName ?? '').toLowerCase();
    walkFacet(child, ln, `${path}.facets[${i++}]`, isRequirements, issues);
  }
}

function walkFacet(
  el: Element,
  tag: string,
  path: string,
  inRequirements: boolean,
  issues: IDSAuditIssue[]
): void {
  const shape = inRequirements
    ? shapeInRequirements(tag)
    : facetBaseShape(tag);
  checkShape(el, shape, path, issues);
  for (const child of childElements(el)) {
    const ln = (child.localName ?? '').toLowerCase();
    walkIdsValueOrFacet(child, ln, `${path}.${ln}`, inRequirements, issues);
  }
}

function walkIdsValueOrFacet(
  el: Element,
  tag: string,
  path: string,
  inRequirements: boolean,
  issues: IDSAuditIssue[]
): void {
  switch (tag) {
    case 'entity':
      // `partOf > entity` is a nested entity facet (applicability shape).
      walkFacet(el, 'entity', path, false, issues);
      return;
    case 'name':
    case 'value':
    case 'baseName':
    case 'propertySet':
    case 'system':
    case 'predefinedType':
      walkIdsValue(el, path, issues);
      return;
    default:
      // Unknown child of a facet — already flagged by the parent's checkShape.
      return;
  }
}

function walkIdsValue(
  el: Element,
  path: string,
  issues: IDSAuditIssue[]
): void {
  checkShape(el, SHAPE_IDS_VALUE, path, issues);
  for (const child of childElements(el)) {
    const ln = (child.localName ?? '').toLowerCase();
    if (ln === 'simpleValue') {
      checkShape(child, SHAPE_SIMPLE_VALUE, `${path}.simpleValue`, issues);
    } else if (
      ln === 'restriction' &&
      (child.namespaceURI === XS_NS || child.namespaceURI === null)
    ) {
      walkXsRestriction(child, `${path}.restriction`, issues);
    }
  }
}

function walkXsRestriction(
  el: Element,
  path: string,
  issues: IDSAuditIssue[]
): void {
  checkShape(el, SHAPE_XS_RESTRICTION, path, issues);
  for (const child of childElements(el)) {
    const ln = (child.localName ?? '').toLowerCase();
    if (XS_RESTRICTION_FACETS.includes(ln)) {
      checkShape(child, SHAPE_XS_FACET, `${path}.${ln}`, issues);
    }
  }
}

// ---------------------------------------------------------------------------
// Shape enforcement primitives
// ---------------------------------------------------------------------------

function checkShape(
  el: Element,
  shape: ElementShape,
  path: string,
  issues: IDSAuditIssue[]
): void {
  // Attributes
  const allowedAttrs = new Set(shape.attrs.map((a) => a.toLowerCase()));
  for (const attr of Array.from(el.attributes ?? [])) {
    if (isNamespaceAttribute(attr)) continue;
    const name = attr.nodeName ?? '';
    if (isToleratedGlobalAttr(name)) continue;
    const rawLocalName = attr.localName ?? attr.nodeName ?? '';
    // happy-dom sometimes keeps the prefix (e.g. `xsi:schemaLocation`)
    // in localName with namespaceURI=null. Strip the prefix before
    // matching shape rules.
    const colonIdx = rawLocalName.indexOf(':');
    const localName =
      colonIdx === -1
        ? rawLocalName.toLowerCase()
        : rawLocalName.slice(colonIdx + 1).toLowerCase();
    const prefix =
      colonIdx === -1 ? '' : rawLocalName.slice(0, colonIdx).toLowerCase();
    // `xmlns="..."` and `xmlns:*` declarations.
    if (!localName || localName === 'xmlns' || prefix === 'xmlns') continue;
    // Globally tolerated XML/XSI attributes (e.g. xsi:schemaLocation,
    // xml:lang) when the prefix is known.
    if (TOLERATED_GLOBAL_ATTR_PREFIXES.has(prefix)) continue;
    if (!allowedAttrs.has(localName)) {
      issues.push({
        severity: 'error',
        code: 'E_XSD_STRUCTURE',
        message: `unexpected attribute "${rawLocalName}" on <${el.localName}>`,
        path,
        detail: {
          attribute: rawLocalName,
          element: el.localName ?? '',
        },
      });
    }
  }
  // Required attributes
  if (shape.requiredAttrs) {
    for (const req of shape.requiredAttrs) {
      if (!hasAttribute(el, req)) {
        issues.push({
          severity: 'error',
          code: 'E_XSD_REQUIRED_ATTR',
          message: `<${el.localName}> is missing required @${req}`,
          path,
          detail: { attribute: req, element: el.localName ?? '' },
        });
      }
    }
  }
  // Children
  const allowedChildren = new Set(shape.children.map((c) => c.toLowerCase()));
  const allowedXsChildren = new Set(
    (shape.xsChildren ?? []).map((c) => c.toLowerCase())
  );
  for (const child of childElements(el)) {
    const ln = (child.localName ?? '').toLowerCase();
    const isXs = child.namespaceURI === XS_NS;
    if (isXs) {
      if (!allowedXsChildren.has(ln)) {
        issues.push({
          severity: 'error',
          code: 'E_XSD_STRUCTURE',
          message: `unexpected XSD child <xs:${ln}> in <${el.localName}>`,
          path,
          detail: { child: `xs:${ln}`, parent: el.localName ?? '' },
        });
      }
      continue;
    }
    if (!allowedChildren.has(ln)) {
      issues.push({
        severity: 'error',
        code: 'E_XSD_STRUCTURE',
        message: `unexpected child <${child.localName}> in <${el.localName}>`,
        path,
        detail: { child: child.localName ?? '', parent: el.localName ?? '' },
      });
    }
  }
  if (shape.textOnly) {
    // Element should have no element children — text already checked
    // implicitly by children loop above.
  }
}

function hasAttribute(el: Element, name: string): boolean {
  if (typeof el.hasAttribute === 'function' && el.hasAttribute(name))
    return true;
  // xmldom returns attribute objects under `attributes`; iterate.
  for (const attr of Array.from(el.attributes ?? [])) {
    const ln = (attr.localName ?? attr.nodeName ?? '').toLowerCase();
    if (ln === name.toLowerCase()) return true;
  }
  return false;
}

function isToleratedGlobalAttr(name: string): boolean {
  if (!name) return false;
  if (name === 'xmlns') return true;
  const colon = name.indexOf(':');
  if (colon === -1) return false;
  return TOLERATED_GLOBAL_ATTR_PREFIXES.has(name.slice(0, colon));
}

/**
 * XML and XML-derived namespaces whose attributes are tolerated on any
 * IDS element regardless of the element's shape — `xmlns`, `xml:lang`,
 * `xsi:schemaLocation`, etc.
 */
const TOLERATED_ATTR_NAMESPACES = new Set([
  'http://www.w3.org/2000/xmlns/',
  'http://www.w3.org/XML/1998/namespace',
  'http://www.w3.org/2001/XMLSchema-instance',
]);

function isNamespaceAttribute(attr: Attr): boolean {
  return (
    attr.namespaceURI !== null &&
    TOLERATED_ATTR_NAMESPACES.has(attr.namespaceURI)
  );
}

function childElements(el: Element): Element[] {
  // Some xmldom versions populate `children`; others only `childNodes`.
  if (el.children && el.children.length !== undefined) {
    return Array.from(el.children) as Element[];
  }
  const out: Element[] = [];
  const nodes = el.childNodes ?? [];
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i] as Node;
    if (n && n.nodeType === 1) out.push(n as Element);
  }
  return out;
}
