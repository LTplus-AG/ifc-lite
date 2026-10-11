/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Build a `StudioDocument` from a parsed `IDSDocument`, minting a stable id
 * for every node (document, specification, applicability facet,
 * requirement, constraint).
 */

import type { IDSDocument, IDSFacet, IDSSpecification } from '@ifc-lite/ids';
import { uuidv7, type Uuid } from '../uuid.js';
import { presentFields, type FacetFieldName } from './fields.js';
import {
  emptyMeta,
  STUDIO_SCHEMA_VERSION,
  type FacetNodes,
  type SpecNodes,
  type StudioDocument,
  type StudioMeta,
} from './types.js';

export interface FromIdsOptions {
  /** Reuse an existing document id (e.g. when re-importing a revision). */
  docId?: Uuid;
  /** Id source; defaults to `uuidv7()`. Inject for deterministic tests. */
  newId?: () => Uuid;
  meta?: StudioMeta;
}

/** Fresh node ids for one facet: the facet itself and each present field. */
export function mintFacetNodes(facet: IDSFacet, newId: () => Uuid, facetId: Uuid = newId()): FacetNodes {
  const constraints: Partial<Record<FacetFieldName, Uuid>> = {};
  for (const field of presentFields(facet)) constraints[field] = newId();
  return { id: facetId, constraints };
}

/** Fresh node ids for one specification, plus the spec with its ids stamped. */
export function mintSpecNodes(
  spec: IDSSpecification,
  newId: () => Uuid,
  specId: Uuid = newId(),
): { spec: IDSSpecification; nodes: SpecNodes } {
  const applicability = spec.applicability.facets.map((f) => mintFacetNodes(f, newId));
  const requirementNodes = spec.requirements.map((r) => mintFacetNodes(r.facet, newId));
  return {
    spec: {
      ...spec,
      id: specId,
      requirements: spec.requirements.map((r, i) => ({ ...r, id: requirementNodes[i].id })),
    },
    nodes: { id: specId, applicability, requirements: requirementNodes },
  };
}

/**
 * Wrap `ids` in a Studio document. The input is not mutated; specification
 * and requirement `id`s in the result are replaced by their node UUIDs.
 */
export function fromIdsDocument(ids: IDSDocument, options: FromIdsOptions = {}): StudioDocument {
  const newId = options.newId ?? (() => uuidv7());
  const docId = options.docId ?? newId();
  const minted = ids.specifications.map((s) => mintSpecNodes(s, newId));
  return {
    docId,
    schemaVersion: STUDIO_SCHEMA_VERSION,
    ids: { ...ids, info: { ...ids.info }, specifications: minted.map((m) => m.spec) },
    nodes: { document: newId(), specs: minted.map((m) => m.nodes) },
    meta: options.meta ?? emptyMeta(),
  };
}

/** An empty Studio document (no specifications). */
export function createStudioDocument(options: FromIdsOptions & { title?: string } = {}): StudioDocument {
  return fromIdsDocument({ info: { title: options.title ?? '' }, specifications: [] }, options);
}
