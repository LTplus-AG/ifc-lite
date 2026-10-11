/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `Uuid → NodeLocation` lookups over a `NodeIndex`, plus the invariant
 * check behind "every node in `doc.ids` has exactly one Uuid" (§2 inv. 3).
 *
 * The lookup map is derived lazily and cached per `NodeIndex` object. The
 * reducer never mutates a `NodeIndex` (structural sharing), so the cache
 * can never go stale.
 */

import type { IDSFacet } from '@ifc-lite/ids';
import type { Uuid } from '../uuid.js';
import { presentFields, type FacetFieldName } from './fields.js';
import type { FacetNodes, NodeIndex, NodeLocation, Section, StudioDocument } from './types.js';

const LOOKUP_CACHE = new WeakMap<NodeIndex, Map<Uuid, NodeLocation>>();

function buildLookup(nodes: NodeIndex): Map<Uuid, NodeLocation> {
  const map = new Map<Uuid, NodeLocation>();
  map.set(nodes.document, { kind: 'document' });
  nodes.specs.forEach((spec, specIndex) => {
    map.set(spec.id, { kind: 'spec', specIndex, specId: spec.id });
    const sections: [Section, readonly FacetNodes[]][] = [
      ['applicability', spec.applicability],
      ['requirements', spec.requirements],
    ];
    for (const [section, facets] of sections) {
      facets.forEach((facet, facetIndex) => {
        const kind = section === 'applicability' ? 'applicabilityFacet' : 'requirement';
        map.set(facet.id, { kind, specIndex, specId: spec.id, section, facetIndex });
        for (const [field, cid] of Object.entries(facet.constraints)) {
          if (!cid) continue;
          map.set(cid, {
            kind: 'constraint',
            specIndex,
            specId: spec.id,
            section,
            facetIndex,
            facetId: facet.id,
            field: field as FacetFieldName,
          });
        }
      });
    }
  });
  return map;
}

function lookup(nodes: NodeIndex): Map<Uuid, NodeLocation> {
  let map = LOOKUP_CACHE.get(nodes);
  if (!map) {
    map = buildLookup(nodes);
    LOOKUP_CACHE.set(nodes, map);
  }
  return map;
}

/** Where node `id` currently lives, or `undefined` for an unknown id. */
export function locateNode(doc: StudioDocument, id: Uuid): NodeLocation | undefined {
  return lookup(doc.nodes).get(id);
}

/** Every node id of the document, in document order. */
export function allNodeIds(doc: StudioDocument): Uuid[] {
  return [...lookup(doc.nodes).keys()];
}

export interface FacetLocation {
  specIndex: number;
  specId: Uuid;
  section: Section;
  facetIndex: number;
}

export function locateFacet(doc: StudioDocument, facetId: Uuid): FacetLocation | undefined {
  const loc = locateNode(doc, facetId);
  if (!loc || (loc.kind !== 'applicabilityFacet' && loc.kind !== 'requirement')) return undefined;
  return { specIndex: loc.specIndex, specId: loc.specId, section: loc.section, facetIndex: loc.facetIndex };
}

export function locateSpec(doc: StudioDocument, specId: Uuid): number | undefined {
  const loc = locateNode(doc, specId);
  return loc?.kind === 'spec' ? loc.specIndex : undefined;
}

/** The IDS facet a `FacetLocation` points at. */
export function facetAt(doc: StudioDocument, loc: FacetLocation): IDSFacet {
  const spec = doc.ids.specifications[loc.specIndex];
  return loc.section === 'applicability'
    ? spec.applicability.facets[loc.facetIndex]
    : spec.requirements[loc.facetIndex].facet;
}

export function facetNodesAt(doc: StudioDocument, loc: FacetLocation): FacetNodes {
  const spec = doc.nodes.specs[loc.specIndex];
  return loc.section === 'applicability' ? spec.applicability[loc.facetIndex] : spec.requirements[loc.facetIndex];
}

/**
 * Check that `nodes` mirrors `ids` exactly and that every id is unique.
 * Returns human-readable problems; an empty list means the invariants hold.
 */
export function verifyNodeIndex(doc: StudioDocument): string[] {
  const problems: string[] = [];
  const seen = new Set<Uuid>();
  const claim = (id: Uuid, what: string): void => {
    if (seen.has(id)) problems.push(`duplicate node id ${id} (${what})`);
    seen.add(id);
  };
  claim(doc.nodes.document, 'document');
  const specs = doc.ids.specifications;
  if (specs.length !== doc.nodes.specs.length) {
    problems.push(`spec count ${specs.length} != node count ${doc.nodes.specs.length}`);
    return problems;
  }
  specs.forEach((spec, i) => {
    const sn = doc.nodes.specs[i];
    claim(sn.id, `spec ${i}`);
    if (spec.id !== sn.id) problems.push(`spec ${i}: ids.id ${spec.id} != node ${sn.id}`);
    const check = (facets: readonly IDSFacet[], nodes: readonly FacetNodes[], label: string): void => {
      if (facets.length !== nodes.length) {
        problems.push(`spec ${i} ${label}: ${facets.length} facets != ${nodes.length} nodes`);
        return;
      }
      facets.forEach((facet, j) => {
        const fn = nodes[j];
        claim(fn.id, `spec ${i} ${label} ${j}`);
        const present = presentFields(facet);
        const indexed = Object.keys(fn.constraints).filter((k) => fn.constraints[k as FacetFieldName]);
        if (present.length !== indexed.length || present.some((f) => !fn.constraints[f])) {
          problems.push(`spec ${i} ${label} ${j}: constraint ids [${indexed}] != fields [${present}]`);
        }
        for (const f of present) {
          const cid = fn.constraints[f];
          if (cid) claim(cid, `spec ${i} ${label} ${j} ${f}`);
        }
      });
    };
    check(spec.applicability.facets, sn.applicability, 'applicability');
    check(spec.requirements.map((r) => r.facet), sn.requirements, 'requirements');
    spec.requirements.forEach((req, j) => {
      const fn = sn.requirements[j];
      if (fn && req.id !== fn.id) problems.push(`spec ${i} requirement ${j}: ids.id ${req.id} != node ${fn.id}`);
    });
  });
  return problems;
}
