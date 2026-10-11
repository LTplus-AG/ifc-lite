/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Element shapes of the IDS 1.0 XSD (`ids.xsd`) for the structural audit,
 * split out of `index.ts` so the walk and the tables can change apart.
 * `ids11ShapeFor` overlays the IDS 1.1 PREVIEW candidates on top.
 */

/**
 * Element shape — the union of attributes and child-element local-names
 * the IDS XSD permits at this position. `attrs` lists the unprefixed
 * names; presence of any other (non-tolerated) attribute is an error.
 */
export interface ElementShape {
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

export const SHAPE_IDS: ElementShape = {
  attrs: [],
  children: ['info', 'specifications'],
};

export const SHAPE_INFO: ElementShape = {
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

export const SHAPE_SPECIFICATIONS: ElementShape = {
  attrs: [],
  children: ['specification'],
};

export const SHAPE_SPECIFICATION: ElementShape = {
  attrs: ['name', 'ifcVersion', 'identifier', 'description', 'instructions'],
  requiredAttrs: ['name', 'ifcVersion'],
  children: ['applicability', 'requirements'],
};

export const SHAPE_APPLICABILITY: ElementShape = {
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

export const SHAPE_REQUIREMENTS: ElementShape = {
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
export function shapeInRequirements(facetTag: string): ElementShape {
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

export function facetBaseShape(tag: string): ElementShape {
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
export const SHAPE_IDS_VALUE: ElementShape = {
  attrs: [],
  children: ['simpleValue'],
  xsChildren: ['restriction'],
};

export const SHAPE_SIMPLE_VALUE: ElementShape = {
  attrs: [],
  children: [],
  textOnly: true,
};

// xs:restriction child facets the IDS XSD admits.
export const XS_RESTRICTION_FACETS = [
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

export const SHAPE_XS_RESTRICTION: ElementShape = {
  attrs: ['base'],
  children: [],
  xsChildren: XS_RESTRICTION_FACETS,
};

// Each xs:enumeration/xs:pattern/etc carries a `value` attribute.
export const SHAPE_XS_FACET: ElementShape = {
  attrs: ['value'],
  children: [],
  textOnly: true,
};

/** Facets IDS 1.1 PREVIEW (#379, draft PR #380) allows inside `partOf` besides its entity. */
export const IDS11_PARTOF_NESTED = ['attribute', 'property', 'classification', 'material'] as const;

/** Where a facet element sits: IDS 1.0 contexts, or nested in partOf (1.1 PREVIEW). */
export type FacetContext = 'applicability' | 'requirement' | 'nested';

/**
 * A facet's shape with the IDS 1.1 PREVIEW candidates overlaid: `uri` on
 * property/classification/material outside requirements (#188, #251; PR #382
 * on the upstream `ver/1.1.x` branch), `instructions` on applicability
 * facets (#154 proposal) and the nested facets of partOf (#380 draft).
 */
export function ids11FacetShape(tag: string, context: FacetContext): ElementShape {
  const lower = tag.toLowerCase();
  const base = context === 'requirement' ? shapeInRequirements(lower) : facetBaseShape(lower);
  const attrs = [...base.attrs];
  const takesUri = lower === 'property' || lower === 'classification' || lower === 'material';
  if (context !== 'requirement' && takesUri) attrs.push('uri');
  if (context === 'applicability') attrs.push('instructions');
  const children = lower === 'partof' ? [...base.children, ...IDS11_PARTOF_NESTED] : base.children;
  return { ...base, attrs, children };
}
