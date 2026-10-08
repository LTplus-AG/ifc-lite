/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Re-identification (§2, §6): when an external IDS is imported over an
 * existing Studio document (a client sends v2), give each incoming node
 * the id of the node it continues, so comments, provenance and history
 * survive.
 *
 * Specifications match by, in order: the same non-empty `identifier`; the
 * same name and applicability signature; then the best similarity over
 * name tokens and facet signatures, above a threshold. Facets match within
 * a matched spec and section by: identical facet; same type and key (pset
 * + property, entity name, …); then key similarity. Every cascade step is
 * one-to-one and greedy by score. Unmatched incoming nodes get fresh ids;
 * unmatched previous nodes are reported as removed.
 */

import type { IDSDocument, IDSFacet, IDSSpecification } from '@ifc-lite/ids';
import { presentFields, type FacetFieldName } from '../document/fields.js';
import { mintFacetNodes } from '../document/from-ids.js';
import type { FacetNodes, SpecNodes, StudioDocument } from '../document/types.js';
import { uuidv7, type Uuid } from '../uuid.js';
import { DEFAULT_MATCH_THRESHOLD, matchFacetList, matchSpecs, type MatchStep } from './cascade.js';

export type { MatchStep };

export interface ReidentifyReport {
  specs: { matched: { index: number; id: Uuid; by: MatchStep }[]; added: number[]; removed: Uuid[] };
  facets: { matched: number; added: number; removed: number };
}

export interface ReidentifyOptions {
  newId?: () => Uuid;
  /** Minimum similarity for the last cascade step (0..1). */
  threshold?: number;
}

function matchFacets(
  prev: { facet: IDSFacet; nodes: FacetNodes }[],
  next: IDSFacet[],
  threshold: number,
  newId: () => Uuid,
  report: ReidentifyReport,
): FacetNodes[] {
  const { pairs, usedPrev } = matchFacetList(
    prev.map((p) => p.facet),
    next,
    { threshold },
  );
  report.facets.matched += pairs.size;
  report.facets.added += next.length - pairs.size;
  report.facets.removed += prev.length - usedPrev.size;
  return next.map((facet, n) => {
    const hit = pairs.get(n);
    if (!hit) return mintFacetNodes(facet, newId);
    const old = prev[hit.prev].nodes;
    const constraints: Partial<Record<FacetFieldName, Uuid>> = {};
    for (const field of presentFields(facet)) constraints[field] = old.constraints[field] ?? newId();
    return { id: old.id, constraints };
  });
}

/** Rebind `incoming` onto the node ids of `previous`. Meta and docId are kept. */
export function reidentify(
  previous: StudioDocument,
  incoming: IDSDocument,
  options: ReidentifyOptions = {},
): { doc: StudioDocument; report: ReidentifyReport } {
  const newId = options.newId ?? (() => uuidv7());
  const threshold = options.threshold ?? DEFAULT_MATCH_THRESHOLD;
  const prevSpecs = previous.ids.specifications;
  const report: ReidentifyReport = { specs: { matched: [], added: [], removed: [] }, facets: { matched: 0, added: 0, removed: 0 } };
  const { pairs, usedPrev } = matchSpecs(prevSpecs, incoming.specifications, { threshold });
  const specs: IDSSpecification[] = [];
  const nodes: SpecNodes[] = [];
  incoming.specifications.forEach((spec, n) => {
    const hit = pairs.get(n);
    const prevNodes = hit ? previous.nodes.specs[hit.prev] : undefined;
    const prevSpec = hit ? prevSpecs[hit.prev] : undefined;
    const specId = prevNodes?.id ?? newId();
    if (hit) report.specs.matched.push({ index: n, id: specId, by: hit.by });
    else report.specs.added.push(n);
    const items = (section: 'applicability' | 'requirements') =>
      prevSpec && prevNodes
        ? section === 'applicability'
          ? prevSpec.applicability.facets.map((facet, j) => ({ facet, nodes: prevNodes.applicability[j] }))
          : prevSpec.requirements.map((r, j) => ({ facet: r.facet, nodes: prevNodes.requirements[j] }))
        : [];
    const applicability = matchFacets(items('applicability'), spec.applicability.facets, threshold, newId, report);
    const requirements = matchFacets(items('requirements'), spec.requirements.map((r) => r.facet), threshold, newId, report);
    specs.push({ ...spec, id: specId, requirements: spec.requirements.map((r, j) => ({ ...r, id: requirements[j].id })) });
    nodes.push({ id: specId, applicability, requirements });
  });
  prevSpecs.forEach((s, p) => {
    if (usedPrev.has(p)) return;
    report.specs.removed.push(s.id);
    report.facets.removed += s.applicability.facets.length + s.requirements.length;
  });
  return {
    doc: {
      ...previous,
      ids: { ...incoming, specifications: specs },
      nodes: { document: previous.nodes.document, specs: nodes },
    },
    report,
  };
}
