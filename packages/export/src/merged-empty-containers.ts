/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Empty-spatial-container analysis for the merged exporter (issue #3643) — the
 * step of IfcOpenShell/BlenderBIM's "Merge Projects" recipe that container
 * *matching* (`mergeSites` / `mergeBuildings` / `mergeStoreys`) leaves behind.
 *
 * An `IfcSite` / `IfcBuilding` / `IfcBuildingStorey` / `IfcSpace` (or an IFC4X3
 * facility or facility part) is empty when
 * it contains no surviving element (`IfcRelContainedInSpatialStructure`),
 * directly aggregates no surviving non-spatial object, and transitively
 * aggregates no non-empty spatial child. `IfcProject` is never a candidate.
 *
 * Emptiness is a fact about the MERGED model, not about one input: a site that
 * is empty in its own file is not empty once a later model's storeys are unified
 * onto it. So this runs across every model — after visibility filtering and
 * after spatial unification, the two things that make a container empty in the
 * first place — and yields the express ids the emit loop then never writes.
 * Nothing is emitted referencing them, so no dangling-reference clean-up pass
 * has to follow; that is why this belongs inside the merge rather than after it.
 *
 * The Rust twin is `rust/export/src/merged/empty.rs`, which the native merged
 * export (`export_merged_models`) drives from the same rules.
 */

import type { IfcSourceBytes } from '@ifc-lite/parser';
import { asSourceBytes } from '@ifc-lite/parser';
import { argRefs, classifyRefs, leadingGuid, refList, singleRef, topLevelAttrs } from './merged-empty-containers-refs.js';
import type { CompleteEntityIndex } from './entity-iteration.js';

/**
 * Spatial container types dropped when they end up empty: every instantiable
 * IfcSpatialStructureElement, including the IFC4X3 facilities and facility
 * parts (#5937). `IfcProject` is deliberately absent: it is the file's root,
 * never a candidate. Twin of `CONTAINER_TYPES` in `rust/export/src/merged/empty.rs`.
 */
const CONTAINER_TYPES = new Set([
  'IFCSITE',
  'IFCBUILDING',
  'IFCBUILDINGSTOREY',
  'IFCSPACE',
  'IFCFACILITY', 'IFCBRIDGE', 'IFCMARINEFACILITY', 'IFCRAILWAY', 'IFCROAD',
  'IFCBRIDGEPART', 'IFCFACILITYPARTCOMMON', 'IFCMARINEPART', 'IFCRAILWAYPART', 'IFCROADPART',
]);

/**
 * Relationships that express spatial structure, as
 * `[relatingAttributeIndex, relatedAttributeIndex]` — `IfcRelAggregates` names
 * the whole first, the containment relationships name the parts first.
 */
const STRUCTURE_RELATIONS: Record<string, [number, number]> = {
  IFCRELAGGREGATES: [4, 5],
  IFCRELCONTAINEDINSPATIALSTRUCTURE: [5, 4],
  IFCRELREFERENCEDINSPATIALSTRUCTURE: [5, 4],
};

/** One model as the analysis sees it, in the merge's own terms. */
export interface EmptyContainerModelView {
  /** Complete entity index (primary + deferred atoms). */
  entities: CompleteEntityIndex;
  /** The model's source bytes. */
  source: IfcSourceBytes;
  /** Visible express ids, or `null` when the whole model is exported. */
  included: ReadonlySet<number> | null;
  /** Local express id → final express id, for containers unified onto an
   *  earlier model's (the spatial-unification remap). */
  sharedRemap: ReadonlyMap<number, number>;
  /** Express-id offset applied to this model in the merged file. */
  offset: number;
  /** True when the model unifies into the first model's project / unit space. */
  compatible: boolean;
  /**
   * Run this model's one-parent claim pass (#5471) and return the aggregation
   * edges it withholds. Called once per model in merge order, on a claim set
   * of the plan's own. Omitted: every edge counts.
   *
   * The drops must be known before emission, yet the emit-time claim pass
   * withholds aggregation edges, and a container that loses its only edge is
   * empty (#5725). This pass runs with no drops applied, and that is already
   * the fixed point: a claim that would differ once drops are known needs a
   * dropped parent, but a parent whose kept edge reaches a kept child is kept
   * itself. That holds only if this pass never withholds an edge the emit pass
   * writes, or a still-full child loses its only parent. So it may see LESS
   * than the emit pass, never more. It claims only through
   * {@link isStructureRelation} types, and resolves ids through `sharedRemap`
   * (spatial unification, which the emit pass repeats exactly) plus the
   * GlobalId unifications the emit pass is sure to make (#5937,
   * `merged-planner-guids.ts`), not through this module's own GlobalId
   * canonicalisation, which the emit pass does not always repeat (a GlobalId
   * duplicated within one model, or an `assume-shared` emitter in another
   * unit). What it misses is an edge the emit pass withholds and this one
   * counts, which only keeps a container (#3643's behaviour before #5725).
   */
  claimParents?: () => WithheldParents;
}

/** Aggregation edges the one-parent pass keeps out of the output (#5725). */
export interface WithheldParents {
  /** Rels skipped outright: every member already had a parent. */
  skipEntityIds: ReadonlySet<number>;
  /** Rel → members stripped from its RelatedObjects list. */
  relMemberStrip: ReadonlyMap<number, ReadonlySet<number>>;
}

/** Which containers the emit loop must not write. */
export interface EmptyContainerPlan {
  /** Per input model (same order): local express ids never emitted. */
  droppedByModel: Set<number>[];
  /** Containers dropped, counted in the MERGED model (a container unified
   *  across three inputs counts once). */
  droppedCount: number;
}

/** True when `typeUpper` is a relationship the analysis counts as spatial structure. */
export function isStructureRelation(typeUpper: string): boolean {
  return typeUpper in STRUCTURE_RELATIONS;
}

/** True when `typeUpper` is a droppable spatial container type. */
export function isSpatialContainerType(typeUpper: string): boolean {
  return CONTAINER_TYPES.has(typeUpper);
}

/**
 * A model with nothing to analyse — the placeholder for an input whose source
 * bytes are missing (a cache-restored, metadata-only store), which the emit loop
 * skips too. Keeps the caller's per-model arrays aligned with its inputs.
 */
export const EMPTY_MODEL_VIEW: EmptyContainerModelView = {
  entities: new Map(),
  source: asSourceBytes(new Uint8Array()),
  included: null,
  sharedRemap: new Map(),
  offset: 0,
  compatible: false,
};

/**
 * Plan which spatial containers the merge leaves holding nothing.
 *
 * The returned local ids are what the caller withholds from the output; every
 * surviving line that named one is narrowed (or withheld with it) by
 * `filterHiddenRefsFromRelationshipLine`, which is what keeps the result free of
 * dangling references.
 */
export function planEmptyContainerDrops(models: EmptyContainerModelView[]): EmptyContainerPlan {
  const nodes = new Set<number>();
  const hasContent = new Set<number>();
  const blocked = new Set<number>();
  /** Spatial child node → its container nodes (upward edges for the sweep). */
  const parents = new Map<number, number[]>();
  const guidNode = new Map<string, number>();
  const containersByModel: Array<Map<number, number>> = [];

  for (const view of models) {
    const canon = canonicalContainers(view, guidNode);
    containersByModel.push(canon);
    for (const node of canon.values()) nodes.add(node);
    recordEdges(view, canon, hasContent, parents, view.claimParents?.());
    recordBlocks(view, canon, blocked);
  }

  // A container is non-empty when it holds something, is blocked, or has a
  // non-empty spatial child — the last propagated upward from the first two.
  // The visited check also makes a self-referential aggregation terminate.
  const nonEmpty = new Set<number>([...hasContent, ...blocked]);
  const stack = [...nonEmpty];
  while (stack.length > 0) {
    const node = stack.pop()!;
    for (const parent of parents.get(node) ?? []) {
      if (!nonEmpty.has(parent)) {
        nonEmpty.add(parent);
        stack.push(parent);
      }
    }
  }

  const dropped = new Set([...nodes].filter(node => !nonEmpty.has(node)));
  return {
    droppedByModel: containersByModel.map(canon => {
      const ids = new Set<number>();
      for (const [localId, node] of canon) {
        if (dropped.has(node)) ids.add(localId);
      }
      return ids;
    }),
    droppedCount: dropped.size,
  };
}

/**
 * Map each of this model's visible containers to its node in the merged model:
 * the container it was unified onto, the earlier instance that already carries
 * its GlobalId, or its own final express id. Mirrors the emit loop's
 * unification order (iteration order, first occurrence wins).
 */
function canonicalContainers(
  view: EmptyContainerModelView,
  guidNode: Map<string, number>,
): Map<number, number> {
  const canon = new Map<number, number>();
  for (const [localId, ref] of view.entities) {
    if (view.included !== null && !view.included.has(localId)) continue;
    if (!isSpatialContainerType(ref.type.toUpperCase())) continue;
    const unified = view.sharedRemap.get(localId);
    if (unified !== undefined) {
      canon.set(localId, unified);
      continue;
    }
    const finalId = localId + view.offset;
    if (!view.compatible) {
      canon.set(localId, finalId);
      continue;
    }
    const guid = leadingGuid(lineOf(view, localId));
    if (guid === null) {
      canon.set(localId, finalId);
      continue;
    }
    const known = guidNode.get(guid);
    if (known === undefined) guidNode.set(guid, finalId);
    canon.set(localId, known ?? finalId);
  }
  return canon;
}

/**
 * Record what this model contributes to each container: contained elements and
 * aggregated objects become content; aggregated spatial children become upward
 * edges, so a non-empty storey keeps its building and its site. An aggregation
 * edge the one-parent pass withholds is never written, so it counts for nothing.
 */
function recordEdges(
  view: EmptyContainerModelView,
  canon: Map<number, number>,
  hasContent: Set<number>,
  parents: Map<number, number[]>,
  withheld: WithheldParents | undefined,
): void {
  if (canon.size === 0) return;
  for (const [localId, ref] of view.entities) {
    if (view.included !== null && !view.included.has(localId)) continue;
    if (withheld?.skipEntityIds.has(localId)) continue;
    const slots = STRUCTURE_RELATIONS[ref.type.toUpperCase()];
    if (slots === undefined) continue;
    const attrs = topLevelAttrs(lineOf(view, localId));
    if (attrs === null) continue;
    const [relatingIndex, relatedIndex] = slots;
    const relating = singleRef(attrs[relatingIndex] ?? '');
    // Not a container (an IfcProject aggregating its sites, say) — its children
    // are roots of the spatial tree, with nothing above them to keep.
    if (relating === null) continue;
    const parent = canon.get(relating);
    if (parent === undefined) continue;
    const stripped = withheld?.relMemberStrip.get(localId);
    for (const child of refList(attrs[relatedIndex] ?? '')) {
      if (view.included !== null && !view.included.has(child)) continue;
      if (stripped?.has(child)) continue;
      const childNode = canon.get(child);
      if (childNode === undefined) {
        hasContent.add(parent);
        continue;
      }
      const edges = parents.get(childNode);
      if (edges === undefined) parents.set(childNode, [parent]);
      else edges.push(parent);
    }
  }
}

/**
 * Block every container this model names in a way the emit loop could not
 * rewrite. Dropping such a container would leave a dangling `#ref`, so it stays
 * (counting as non-empty, which keeps its ancestors too) instead.
 *
 * Rewritable is: a reference from an objectified relationship (`IfcRel*`) that
 * nothing else references, since `filterHiddenRefsFromRelationshipLine` can
 * strip it from a list or withhold the whole line. Everything else — a
 * non-relationship referrer, a reference nested inside a typed value, or a
 * relationship that is itself referenced (withholding it would dangle in turn) —
 * blocks.
 */
function recordBlocks(
  view: EmptyContainerModelView,
  canon: Map<number, number>,
  blocked: Set<number>,
): void {
  if (canon.size === 0) return;
  const referrers: number[] = [];
  const referencedRelationships = new Set<number>();
  for (const [localId, ref] of view.entities) {
    if (view.included !== null && !view.included.has(localId)) continue;
    let namesContainer = false;
    for (const target of argRefs(view.source.slice(ref.byteOffset, ref.byteOffset + ref.byteLength))) {
      if (canon.has(target)) namesContainer = true;
      const targetType = view.entities.get(target)?.type.toUpperCase();
      if (targetType?.startsWith('IFCREL')) referencedRelationships.add(target);
    }
    if (namesContainer) referrers.push(localId);
  }

  for (const localId of referrers) {
    const typeUpper = view.entities.get(localId)!.type.toUpperCase();
    const rewritable = typeUpper.startsWith('IFCREL') && !referencedRelationships.has(localId);
    const line = lineOf(view, localId);
    const slots = classifyRefs(line);
    if (slots === null) {
      // The argument list could not be parsed, so no rewrite can narrow this
      // line: every container it names has to stay.
      for (const target of argRefs(line)) {
        const node = canon.get(target);
        if (node !== undefined) blocked.add(node);
      }
      continue;
    }
    for (const [target, nested] of slots) {
      const node = canon.get(target);
      if (node === undefined) continue;
      if (nested || !rewritable) blocked.add(node);
    }
  }
}

/** The entity's STEP line text. */
function lineOf(view: EmptyContainerModelView, localId: number): string {
  const ref = view.entities.get(localId);
  if (ref === undefined) return '';
  return view.source.decodeUtf8(ref.byteOffset, ref.byteOffset + ref.byteLength);
}
