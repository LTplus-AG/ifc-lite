/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The context an element needs to be re-meshed on its own (#6232 WP1).
 *
 * `serializeEntitySubgraph` walks FORWARD from its roots, and a forward walk
 * from a wall never reaches what the mesher reads about it through INVERSE
 * relationships: the openings that void it (`IfcRelVoidsElement`), the
 * fillings in those openings (`IfcRelFillsElement`), and its layered material
 * (`IfcRelAssociatesMaterial`, which the wasm material-layer index scans the
 * buffer for). Nor does it reach the project, whose unit assignment and
 * representation contexts the pre-pass reads. This module names those roots.
 *
 * Cost is O(targets + their relationship edges): the parsed relationship
 * graph answers the source relationships by CSR lookup, and the overlay's
 * reference buckets answer the created ones. Nothing here enumerates the
 * model or the session (#8452).
 *
 * Known gap: a SOURCE relationship retargeted onto a target by a queued
 * attribute mutation is invisible to the parsed graph, which still names the
 * original endpoint. No authoring command does that today; the overlay
 * creates new relationships instead, and those are found below.
 */

import type { IfcDataStore } from '@ifc-lite/parser';
import type { MutablePropertyView } from '@ifc-lite/mutations';
import { RelationshipType, type Edge } from '@ifc-lite/data';
import { getEffectiveEntityIndex, type EffectiveEntityIndex } from './effective-index.js';

const VOIDS = 'IFCRELVOIDSELEMENT';
const FILLS = 'IFCRELFILLSELEMENT';
const MATERIAL = 'IFCRELASSOCIATESMATERIAL';

/**
 * Roots, besides the targets themselves, that a subgraph must carry for the
 * targets to mesh exactly as they do on load: every live `IfcProject`, each
 * target's openings and host (with the voiding relationship), the fillings of
 * those openings (with the filling relationship), and each target's
 * `IfcRelAssociatesMaterial`. Relationships the overlay created this session
 * are included by the same rules. Tombstoned ids are never returned.
 */
export function remeshContextRoots(
  store: IfcDataStore,
  view: MutablePropertyView | null,
  targets: ReadonlySet<number>,
): Set<number> {
  const index = getEffectiveEntityIndex(store, view, true);
  return contextRootsFor(store, index, view, targets);
}

/** {@link remeshContextRoots} over an already-built effective index. */
export function contextRootsFor(
  store: IfcDataStore,
  index: EffectiveEntityIndex,
  view: MutablePropertyView | null,
  targets: ReadonlySet<number>,
): Set<number> {
  const out = new Set<number>();
  // @raw-entity-enumeration-ok one bucket lookup (IFCPROJECT), each id re-checked against the effective index; overlay-created projects are added below
  for (const id of store.entityIndex.byType.get('IFCPROJECT') ?? []) {
    if (index.has(id)) out.add(id);
  }

  const graph = store.relationships;
  const liveRelationships = (edge: Edge): number[] => {
    const ids = [edge.relationshipId, ...(edge.shadowedRelationshipIds ?? [])];
    return ids.filter((id) => index.has(id));
  };
  /** Add each edge's live relationship ids and, unless `relOnly`, its live
   *  other endpoint (collected into `into` when given). */
  const follow = (edges: readonly Edge[], into?: Set<number>, relOnly = false): void => {
    for (const edge of edges) {
      const rels = liveRelationships(edge);
      if (rels.length === 0) continue;
      for (const rel of rels) out.add(rel);
      if (relOnly || !index.has(edge.target)) continue;
      out.add(edge.target);
      into?.add(edge.target);
    }
  };

  const openings = new Set<number>();
  const live = [...targets].filter((id) => index.has(id));
  for (const id of live) {
    // id as host: IfcRelVoidsElement runs host → opening.
    follow(graph.forward.getEdges(id, RelationshipType.VoidsElement), openings);
    // id as opening: its host.
    follow(graph.inverse.getEdges(id, RelationshipType.VoidsElement));
    // id as opening: its fillings. IfcRelFillsElement runs opening → filling.
    follow(graph.forward.getEdges(id, RelationshipType.FillsElement));
    // id as filling: the opening it fills.
    follow(graph.inverse.getEdges(id, RelationshipType.FillsElement));
    // Material runs material → element; the walk reaches the material through
    // the relationship's own RelatingMaterial reference.
    follow(graph.inverse.getEdges(id, RelationshipType.AssociatesMaterial), undefined, true);
  }
  for (const opening of openings) {
    follow(graph.forward.getEdges(opening, RelationshipType.FillsElement));
  }

  if (view) addOverlayRelationships(index, view, live, openings, out);
  return out;
}

/**
 * Overlay-created relationships are absent from the parsed graph, so they are
 * matched by their effective endpoints. Voids first, so an opening a created
 * `IfcRelVoidsElement` attaches is known before its fillings are looked up.
 */
function addOverlayRelationships(
  index: EffectiveEntityIndex,
  view: MutablePropertyView,
  targets: readonly number[],
  openings: Set<number>,
  out: Set<number>,
): void {
  // Candidates come from the overlay's reference buckets: created records
  // that name a target in their authored attributes or in a queued override,
  // plus records retyped into one of these classes. The effective endpoint
  // checks below decide. A view without those buckets scans every creation.
  const indexed = typeof view.getNewEntitiesReferencing === 'function'
    && typeof view.getAttributeOverrideReferenceCandidates === 'function'
    && typeof view.getAttributeOverrideEntityIds === 'function'
    && typeof view.readNewEntitiesOfType === 'function';
  const everything = indexed ? null : Array.from(view.readNewEntities?.() ?? view.getNewEntities(), entity => entity.expressId);
  const retyped = indexed
    ? view.getAttributeOverrideEntityIds([VOIDS, FILLS, MATERIAL, 'IFCPROJECT']).filter(id => index.isOverlayCreated(id))
    : [];
  const ascending = (ids: Iterable<number>) => [...new Set(ids)].sort((a, b) => a - b);
  const naming = (ids: Iterable<number>): number[] => {
    if (everything) return everything;
    const found = [...retyped];
    for (const id of ids) {
      for (const row of view.getNewEntitiesReferencing(id)) found.push(row.expressId);
      found.push(...view.getAttributeOverrideReferenceCandidates(id));
    }
    return ascending(found);
  };
  const ofType = (ids: readonly number[], type: string) => ids.filter(id => index.typeOf(id) === type);
  const projects = everything
    ?? ascending([...Array.from(view.readNewEntitiesOfType('IFCPROJECT'), row => row.expressId), ...retyped]);
  for (const id of ofType(projects, 'IFCPROJECT')) out.add(id);
  const targetSet = new Set(targets);
  const ref = (rel: number, name: string): number | undefined => {
    const id = index.effectiveAttributeRef(rel, name);
    return id !== undefined && index.has(id) ? id : undefined;
  };
  const nearTargets = naming(targets);

  for (const rel of ofType(nearTargets, VOIDS)) {
    const host = ref(rel, 'RelatingBuildingElement');
    const opening = ref(rel, 'RelatedOpeningElement');
    if (host === undefined || opening === undefined) continue;
    if (!targetSet.has(host) && !targetSet.has(opening)) continue;
    out.add(rel);
    out.add(host);
    out.add(opening);
    if (targetSet.has(host)) openings.add(opening);
  }
  for (const rel of ofType(everything ?? naming([...targets, ...openings]), FILLS)) {
    const opening = ref(rel, 'RelatingOpeningElement');
    const filling = ref(rel, 'RelatedBuildingElement');
    if (opening === undefined || filling === undefined) continue;
    if (!targetSet.has(opening) && !targetSet.has(filling) && !openings.has(opening)) continue;
    out.add(rel);
    out.add(opening);
    out.add(filling);
  }
  for (const rel of ofType(nearTargets, MATERIAL)) {
    if ((index.refsOf(rel) ?? []).some((id) => targetSet.has(id))) out.add(rel);
  }
}
