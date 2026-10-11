/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * IDS 1.1 PREVIEW parsing pass (IDS-124).
 *
 * Runs only under `parseIDS(xml, { preview: { ids11: true } })`, AFTER the
 * IDS 1.0 parse, over the same DOM. It walks specifications and facets in
 * the order the 1.0 parser produced them and adds the 1.1 candidate fields.
 * Keeping it a separate pass is what makes the default parse provably
 * unchanged: the 1.0 code path does not know this module exists.
 */

import type { IDSConstraint } from '../constraint-types.js';
import type { IDSDocument, IDSFacet, IDSPartOfFacet } from '../types.js';
import { getChildElement, getChildElements } from '../parser/dom.js';

/** Facet element names the 1.0 parser turns into facets (lower case). */
const FACET_TAGS = new Set(['entity', 'attribute', 'property', 'classification', 'material', 'partof']);
/** Facets #380 allows inside partOf besides its entity. */
const NESTED_TAGS = new Set(['attribute', 'property', 'classification', 'material']);

type NestedFacet = NonNullable<IDSPartOfFacet['facets']>[number];
type FacetParser = (el: Element) => IDSFacet | null;

function facetElements(parent: Element): Element[] {
  return Array.from(parent.children).filter((c) => FACET_TAGS.has(c.localName.toLowerCase()));
}

/** Stamp the #418 rule on a value constraint (and its conjunctive siblings). */
function stampTolerance(constraint: IDSConstraint | undefined): void {
  if (!constraint) return;
  if (constraint.type === 'simpleValue' || constraint.type === 'enumeration') {
    constraint.toleranceRule = 'ids11-418';
  }
  if (constraint.type !== 'simpleValue') for (const sibling of constraint.and ?? []) stampTolerance(sibling);
}

function readAttr(el: Element, name: string): string | undefined {
  const value = el.getAttribute(name);
  return value === null || value === '' ? undefined : value;
}

function isNested(facet: IDSFacet): facet is NestedFacet {
  return facet.type === 'attribute' || facet.type === 'property' || facet.type === 'classification' || facet.type === 'material';
}

type Context = 'applicability' | 'requirement' | 'nested';

function enrichFacet(facet: IDSFacet, el: Element, context: Context, parseFacet: FacetParser): void {
  // A requirement facet's uri is IDS 1.0 and stays with the 1.0 parser,
  // which ignores it today; reading it here would make a preview parse of a
  // 1.0 file write differently from a default parse.
  if (context !== 'requirement' && (facet.type === 'property' || facet.type === 'classification' || facet.type === 'material')) {
    const uri = readAttr(el, 'uri');
    if (uri !== undefined) facet.uri = uri;
  }
  if (context === 'applicability') {
    const instructions = readAttr(el, 'instructions');
    if (instructions !== undefined) facet.instructions = instructions;
  }
  if (facet.type !== 'entity' && facet.type !== 'partOf') stampTolerance(facet.value);
  if (facet.type === 'partOf') {
    const nested: NestedFacet[] = [];
    for (const child of Array.from(el.children)) {
      if (!NESTED_TAGS.has(child.localName.toLowerCase())) continue;
      const parsed = parseFacet(child);
      if (parsed && isNested(parsed)) {
        enrichFacet(parsed, child, 'nested', parseFacet);
        nested.push(parsed);
      }
    }
    if (nested.length > 0) facet.facets = nested;
  }
}

/**
 * Add the IDS 1.1 PREVIEW fields to a document the 1.0 parser built from
 * `root`. `parseFacet` is the 1.0 facet parser, reused for nested facets.
 */
export function applyIds11Preview(root: Element, doc: IDSDocument, parseFacet: FacetParser): void {
  const specsEl = getChildElement(root, 'specifications');
  if (!specsEl) return;
  getChildElements(specsEl, 'specification').forEach((specEl, s) => {
    const spec = doc.specifications[s];
    if (!spec) return;
    const applicabilityEl = getChildElement(specEl, 'applicability');
    if (applicabilityEl) {
      facetElements(applicabilityEl).forEach((el, i) => {
        const facet = spec.applicability.facets[i];
        if (facet) enrichFacet(facet, el, 'applicability', parseFacet);
      });
    }
    const requirementsEl = getChildElement(specEl, 'requirements');
    if (requirementsEl) {
      facetElements(requirementsEl).forEach((el, i) => {
        const requirement = spec.requirements[i];
        if (requirement) enrichFacet(requirement.facet, el, 'requirement', parseFacet);
      });
    }
  });
}
