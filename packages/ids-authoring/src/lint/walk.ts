/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Read-only views of a Studio document for lint rules. */

import type { IDSSpecification } from '@ifc-lite/ids';
import type { FacetFieldName } from '../document/fields.js';
import type { SpecNodes, StudioDocument } from '../document/types.js';
import type { Uuid } from '../uuid.js';
import type { FacetView, SpecView } from './types.js';

export function specView(spec: IDSSpecification, nodes: SpecNodes, index: number): SpecView {
  return {
    spec,
    nodes,
    specId: nodes.id,
    index,
    versions: [...new Set(spec.ifcVersions)],
    applicability: spec.applicability.facets.map((facet, i) => ({
      facet,
      facetId: nodes.applicability[i].id,
      section: 'applicability',
      index: i,
      constraintIds: nodes.applicability[i].constraints,
    })),
    requirements: spec.requirements.map((requirement, i) => ({
      facet: requirement.facet,
      facetId: nodes.requirements[i].id,
      section: 'requirements',
      index: i,
      requirement,
      constraintIds: nodes.requirements[i].constraints,
    })),
  };
}

export function specViews(doc: StudioDocument): SpecView[] {
  return doc.ids.specifications.map((spec, i) => specView(spec, doc.nodes.specs[i], i));
}

/** Every facet of a spec, applicability first. */
export function allFacets(spec: SpecView): FacetView[] {
  return [...spec.applicability, ...spec.requirements];
}

/** The node a field-level finding should point at (constraint node, else the facet). */
export function fieldNode(view: FacetView, field: FacetFieldName): Uuid {
  return view.constraintIds[field] ?? view.facetId;
}

/** Field-level finding location. */
export function at(view: FacetView, field: FacetFieldName): { nodeId: Uuid; field: FacetFieldName } {
  return { nodeId: fieldNode(view, field), field };
}

/** Human label for a facet's position, e.g. `requirement 2`. */
export function where(view: FacetView): string {
  return view.section === 'applicability' ? `applicability facet ${view.index + 1}` : `requirement ${view.index + 1}`;
}
