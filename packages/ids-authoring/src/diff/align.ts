/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Node pairing for the diff: which specification and facet of `b`
 * continues which of `a`. Uses the matcher shared with re-identification
 * (`match/cascade.ts`). Within one lineage a facet keeps its node id even
 * when it moves to another specification or section, so node-id pairs are
 * taken document-wide first; the cascade then pairs the rest within each
 * matched specification and section.
 */

import type { IDSFacet } from '@ifc-lite/ids';
import type { FacetNodes, Section, StudioDocument } from '../document/types.js';
import {
  matchFacetList,
  matchSpecs,
  type FacetMatchStep,
  type MatchStep,
  type Pairing,
} from '../match/cascade.js';
import type { Uuid } from '../uuid.js';

export const SECTIONS: readonly Section[] = ['applicability', 'requirements'];

/** A facet and where it sits. */
export interface FacetSite {
  specIndex: number;
  specId: Uuid;
  section: Section;
  index: number;
  facet: IDSFacet;
  nodes: FacetNodes;
}

export interface Alignment {
  /** `b` spec index → matched `a` spec index. */
  specs: Pairing<MatchStep>;
  /** `b` facet id → matched `a` facet site. */
  facets: Map<Uuid, { a: FacetSite; by: FacetMatchStep }>;
  /** `a` facet ids that were matched. */
  usedA: Set<Uuid>;
}

export function facetSites(doc: StudioDocument, specIndex: number, section: Section): FacetSite[] {
  const spec = doc.ids.specifications[specIndex];
  const nodes = doc.nodes.specs[specIndex];
  const facets = section === 'applicability' ? spec.applicability.facets : spec.requirements.map((r) => r.facet);
  const ids = section === 'applicability' ? nodes.applicability : nodes.requirements;
  return facets.map((facet, index) => ({ specIndex, specId: spec.id, section, index, facet, nodes: ids[index] }));
}

export function allFacetSites(doc: StudioDocument): FacetSite[] {
  return doc.ids.specifications.flatMap((_, i) => SECTIONS.flatMap((s) => facetSites(doc, i, s)));
}

export function align(a: StudioDocument, b: StudioDocument, byNodeId: boolean, threshold?: number): Alignment {
  const specs = matchSpecs(a.ids.specifications, b.ids.specifications, { byNodeId, threshold });
  const facets = new Map<Uuid, { a: FacetSite; by: FacetMatchStep }>();
  const usedA = new Set<Uuid>();
  if (byNodeId) {
    const byId = new Map(allFacetSites(a).map((s) => [s.nodes.id, s]));
    for (const site of allFacetSites(b)) {
      const hit = byId.get(site.nodes.id);
      if (!hit) continue;
      facets.set(site.nodes.id, { a: hit, by: 'nodeId' });
      usedA.add(hit.nodes.id);
    }
  }
  if (byNodeId) return { specs, facets, usedA };
  b.ids.specifications.forEach((_, n) => {
    const pair = specs.pairs.get(n);
    if (!pair) return;
    for (const section of SECTIONS) {
      const prev = facetSites(a, pair.prev, section).filter((s) => !usedA.has(s.nodes.id));
      const next = facetSites(b, n, section).filter((s) => !facets.has(s.nodes.id));
      const { pairs } = matchFacetList(
        prev.map((s) => s.facet),
        next.map((s) => s.facet),
        { threshold },
      );
      for (const [ni, hit] of pairs) {
        const aSite = prev[hit.prev];
        facets.set(next[ni].nodes.id, { a: aSite, by: hit.by });
        usedA.add(aSite.nodes.id);
      }
    }
  });
  return { specs, facets, usedA };
}

/**
 * Indices (into `seq`) of one longest strictly increasing subsequence. Items
 * on it keep their relative order; the others are reported as moved.
 */
export function longestIncreasing(seq: readonly number[]): Set<number> {
  const tails: number[] = [];
  const prevOf: number[] = new Array<number>(seq.length).fill(-1);
  for (let i = 0; i < seq.length; i++) {
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (seq[tails[mid]] < seq[i]) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0) prevOf[i] = tails[lo - 1];
    tails[lo] = i;
  }
  const keep = new Set<number>();
  let k = tails.length ? tails[tails.length - 1] : -1;
  while (k >= 0) {
    keep.add(k);
    k = prevOf[k];
  }
  return keep;
}
