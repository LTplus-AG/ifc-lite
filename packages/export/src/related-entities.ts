/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `collectRelatedEntities` (#2934, "anonymized isolated export"): given a
 * caller-picked seed selection, walks `store.relationships`
 * (`RelationshipGraph`, `@ifc-lite/data`) outward by relationship kind to
 * find the context a bug reproduction needs — host walls, openings/fillers,
 * aggregate parents/children, type objects, materials, the spatial
 * containment chain up to `IfcProject`, and (bounded) structurally-connected
 * neighbours — without pulling in the rest of the model.
 *
 * The result feeds `StepExportOptions.subsetEntityIds` (`step-export-types.ts`)
 * via `RelatedEntities.all`; `subset-roots.ts`'s `getSubsetEntityIds` then
 * decides which of those ids may seed the export closure and which
 * `IfcRoot`/identifying-type ids elsewhere in the model must be excluded.
 *
 * Iterative BFS with a single shared work budget and a global visited set —
 * per AGENTS.md "Bounding walks over file-supplied references", membership
 * in `all` is a pure function of "was this id reached", so a global/
 * memoising visited set is correct (not path-scoped): the same id reached
 * two different ways is still one entity, not two pieces of accumulated
 * output. The budget bounds legitimate acyclic fan-out (a long
 * `IfcRelAggregates` chain, or a model with fan-out no depth cap would
 * catch); the visited set alone stops cycles (a self-referential
 * `IfcRelAggregates`) and revisits. Iterative, not recursive: there is no
 * call stack for a pathological chain to overflow.
 */

import { RelationshipType } from '@ifc-lite/data';
import type { IfcDataStore } from '@ifc-lite/parser';
import type { RelatedEntities, RelatedEntityGroup, RelatedEntityOptions } from './anonymize-types.js';

/**
 * Total entity expansions (BFS node visits, across every phase of one
 * `collectRelatedEntities` call) before the walk gives up and reports
 * `truncated: true`. Generous for the handful-to-low-hundreds of entities a
 * real "reproduce this bug" selection touches, while still bounding a
 * pathological or adversarial chain (#2866-class input) to a fixed, finite
 * amount of work instead of walking an entire multi-million-entity file.
 */
const WORK_BUDGET = 5000;

/**
 * Spatial-structure types the unconditional "climb to `IfcProject`" step
 * (triggered by `IfcRelContainedInSpatialStructure`) is allowed to walk
 * `IfcRelAggregates`-inverse FROM. Mirrors `reference-collector.ts`'s
 * (module-private) `SPATIAL_STRUCTURE_TYPES` minus `IfcProject` (the climb's
 * destination, not a step of it) and `IfcSpace` (a container's CONTENTS, not
 * an ancestor to climb through) — kept local rather than imported because
 * gating a `IfcRelAggregates`-inverse walk to "spatial types only" is a
 * concern specific to this climb, not a general product/spatial
 * classification the rest of the package would also need.
 */
const SPATIAL_ANCESTOR_TYPES = new Set([
  'IFCSITE', 'IFCBUILDING', 'IFCBUILDINGSTOREY',
  'IFCFACILITY', 'IFCFACILITYPART', 'IFCFACILITYPARTCOMMON',
  'IFCBRIDGE', 'IFCBRIDGEPART',
  'IFCMARINEFACILITY', 'IFCMARINEPART',
  'IFCRAILWAY', 'IFCRAILWAYPART',
  'IFCROAD', 'IFCROADPART',
]);

function withDefaults(options: RelatedEntityOptions): Required<RelatedEntityOptions> {
  return {
    IfcRelVoidsElement: options.IfcRelVoidsElement ?? true,
    IfcRelFillsElement: options.IfcRelFillsElement ?? true,
    IfcRelAggregates: options.IfcRelAggregates ?? 'both',
    IfcRelNests: options.IfcRelNests ?? 'down',
    IfcRelDefinesByType: options.IfcRelDefinesByType ?? true,
    IfcRelAssociatesMaterial: options.IfcRelAssociatesMaterial ?? true,
    IfcRelContainedInSpatialStructure: options.IfcRelContainedInSpatialStructure ?? true,
    IfcRelDefinesByProperties: options.IfcRelDefinesByProperties ?? false,
    IfcRelConnectsPathElementsDepth: options.IfcRelConnectsPathElementsDepth ?? 0,
  };
}

/** One (relationship, role) walk rule: which typed graph edges to follow
 *  from a frontier id, how to report them, and whether the target end is
 *  itself an object to expand further (or, for materials, just a rel id to
 *  keep — see the `includeTargets: false` case at its call site). */
interface EdgeRule {
  relType: RelationshipType;
  direction: 'forward' | 'inverse';
  relationship: string;
  role: string;
  /** `RelationshipType.Aggregates` covers both `IfcRelAggregates` and
   *  `IfcRelNests` edges (the parser folds them into one graph edge kind);
   *  set to split by the REL ENTITY's own type name so the two EXPRESS
   *  relationships stay independently toggleable. */
  relEntityTypeFilter?: string;
  includeTargets: boolean;
  typeGate?: (id: number) => boolean;
}

interface MutableGroup {
  relationship: string;
  role: string;
  expressIds: Set<number>;
  relationshipIds: Set<number>;
}

/**
 * Expand a caller-picked seed selection into the related entities a bug
 * reproduction needs, per `options` (unset fields default to the value
 * documented on `RelatedEntityOptions`). See the module doc for the
 * termination guarantees.
 */
export function collectRelatedEntities(
  store: IfcDataStore,
  seeds: Iterable<number>,
  options: RelatedEntityOptions = {},
): RelatedEntities {
  const opts = withDefaults(options);
  const seedArr = Array.from(new Set(seeds));
  const all = new Set<number>(seedArr);
  const expanded = new Set<number>();
  const groups = new Map<string, MutableGroup>();
  let budget = WORK_BUDGET;
  let truncated = false;

  const groupFor = (relationship: string, role: string): MutableGroup => {
    const key = `${relationship}|${role}`;
    let group = groups.get(key);
    if (!group) {
      group = { relationship, role, expressIds: new Set(), relationshipIds: new Set() };
      groups.set(key, group);
    }
    return group;
  };

  // IfcProject is always in the result regardless of every other toggle — a
  // STEP file with no project is not a valid reproduction of anything.
  for (const id of store.entityIndex.byType.get('IFCPROJECT') ?? []) all.add(id);

  const pending: number[] = [];
  const enqueue = (id: number): void => {
    if (!all.has(id)) {
      all.add(id);
      pending.push(id);
    }
  };

  const consumeBudget = (): boolean => {
    if (budget <= 0) {
      truncated = true;
      return false;
    }
    budget--;
    return true;
  };

  const rules: EdgeRule[] = [];
  if (opts.IfcRelVoidsElement) {
    rules.push({ relType: RelationshipType.VoidsElement, direction: 'forward', relationship: 'IfcRelVoidsElement', role: 'opening', includeTargets: true });
    rules.push({ relType: RelationshipType.VoidsElement, direction: 'inverse', relationship: 'IfcRelVoidsElement', role: 'host', includeTargets: true });
  }
  if (opts.IfcRelFillsElement) {
    rules.push({ relType: RelationshipType.FillsElement, direction: 'forward', relationship: 'IfcRelFillsElement', role: 'filler', includeTargets: true });
    rules.push({ relType: RelationshipType.FillsElement, direction: 'inverse', relationship: 'IfcRelFillsElement', role: 'opening', includeTargets: true });
  }
  if (opts.IfcRelAggregates === 'down' || opts.IfcRelAggregates === 'both') {
    rules.push({ relType: RelationshipType.Aggregates, direction: 'forward', relationship: 'IfcRelAggregates', role: 'child', relEntityTypeFilter: 'IFCRELAGGREGATES', includeTargets: true });
  }
  if (opts.IfcRelAggregates === 'up' || opts.IfcRelAggregates === 'both') {
    rules.push({ relType: RelationshipType.Aggregates, direction: 'inverse', relationship: 'IfcRelAggregates', role: 'parent', relEntityTypeFilter: 'IFCRELAGGREGATES', includeTargets: true });
  }
  if (opts.IfcRelNests === 'down' || opts.IfcRelNests === 'both') {
    rules.push({ relType: RelationshipType.Aggregates, direction: 'forward', relationship: 'IfcRelNests', role: 'child', relEntityTypeFilter: 'IFCRELNESTS', includeTargets: true });
  }
  if (opts.IfcRelNests === 'up' || opts.IfcRelNests === 'both') {
    rules.push({ relType: RelationshipType.Aggregates, direction: 'inverse', relationship: 'IfcRelNests', role: 'parent', relEntityTypeFilter: 'IFCRELNESTS', includeTargets: true });
  }
  if (opts.IfcRelDefinesByType) {
    rules.push({ relType: RelationshipType.DefinesByType, direction: 'inverse', relationship: 'IfcRelDefinesByType', role: 'type', includeTargets: true });
  }
  if (opts.IfcRelDefinesByProperties) {
    rules.push({ relType: RelationshipType.DefinesByProperties, direction: 'inverse', relationship: 'IfcRelDefinesByProperties', role: 'propertySet', includeTargets: true });
  }
  if (opts.IfcRelAssociatesMaterial) {
    // Target NOT included: `IfcMaterial*` is not an `IfcRoot` descendant, so
    // `subset-roots.ts` never excludes it — once the rel entity id below is
    // in `all` (a root of the subset export), `collectReferencedEntityIds`'s
    // forward closure reaches the material through the rel's own
    // `RelatingMaterial` reference. Listing it here too would just be a
    // second, redundant path to the same id.
    rules.push({ relType: RelationshipType.AssociatesMaterial, direction: 'inverse', relationship: 'IfcRelAssociatesMaterial', role: 'material', includeTargets: false });
  }
  if (opts.IfcRelContainedInSpatialStructure) {
    rules.push({ relType: RelationshipType.ContainsElements, direction: 'inverse', relationship: 'IfcRelContainedInSpatialStructure', role: 'container', includeTargets: true });
    // Spatial ancestor climb (storey -> building -> site -> project): typed
    // separately from the general `IfcRelAggregates` parent/child toggle
    // above (same graph edge kind, different role) and gated to spatial
    // types only, so it climbs the containment chain without also chasing
    // an unrelated `IfcRelAggregates` parent of every non-spatial entity
    // this walk happens to reach.
    rules.push({
      relType: RelationshipType.Aggregates,
      direction: 'inverse',
      relationship: 'IfcRelAggregates',
      role: 'spatial ancestor',
      relEntityTypeFilter: 'IFCRELAGGREGATES',
      includeTargets: true,
      typeGate: (id) => SPATIAL_ANCESTOR_TYPES.has(store.entities.getTypeName(id).toUpperCase()),
    });
  }

  const seedSet = new Set(seedArr);
  const isSpatial = (id: number): boolean =>
    SPATIAL_ANCESTOR_TYPES.has(store.entities.getTypeName(id).toUpperCase());

  const applyRules = (id: number): void => {
    for (const rule of rules) {
      if (rule.typeGate && !rule.typeGate(id)) continue;
      // A spatial container reached by the ancestor climb (the seed's storey,
      // its building, the site) is context, not a seed: descending its
      // decomposition would pull in EVERY sibling storey of the building and
      // every building on the site — the whole model's skeleton, with all
      // its storey names. Only a spatial element the caller seeded directly
      // expands downward.
      if (rule.role === 'child' && !seedSet.has(id) && isSpatial(id)) continue;
      const edges = rule.direction === 'forward'
        ? store.relationships.forward.getEdges(id, rule.relType)
        : store.relationships.inverse.getEdges(id, rule.relType);
      for (const edge of edges) {
        if (rule.relEntityTypeFilter
          && store.entities.getTypeName(edge.relationshipId).toUpperCase() !== rule.relEntityTypeFilter) {
          continue;
        }
        const group = groupFor(rule.relationship, rule.role);
        group.relationshipIds.add(edge.relationshipId);
        all.add(edge.relationshipId);
        if (rule.includeTargets) {
          group.expressIds.add(edge.target);
          enqueue(edge.target);
        }
      }
    }
  };

  // Connected-path BFS, seeded from the caller's ORIGINAL selection only, to
  // a fixed hop count both directions — bounded by depth rather than walked
  // to a fixpoint like every other group, because `IfcRelConnectsPathElements`
  // can span a whole building's structural network and "the wall's context"
  // does not mean "the entire frame". Anything it finds still feeds the main
  // walk below (a connected wall's own openings/storey/etc. are still
  // wanted), via the same `enqueue`.
  if (opts.IfcRelConnectsPathElementsDepth > 0) {
    let frontier = seedArr.slice();
    const seen = new Set(seedArr);
    outer: for (let hop = 0; hop < opts.IfcRelConnectsPathElementsDepth; hop++) {
      const next: number[] = [];
      for (const id of frontier) {
        if (!consumeBudget()) break outer;
        for (const direction of ['forward', 'inverse'] as const) {
          const edges = direction === 'forward'
            ? store.relationships.forward.getEdges(id, RelationshipType.ConnectsPathElements)
            : store.relationships.inverse.getEdges(id, RelationshipType.ConnectsPathElements);
          for (const edge of edges) {
            const group = groupFor('IfcRelConnectsPathElements', 'connected');
            group.relationshipIds.add(edge.relationshipId);
            group.expressIds.add(edge.target);
            all.add(edge.relationshipId);
            enqueue(edge.target);
            if (!seen.has(edge.target)) {
              seen.add(edge.target);
              next.push(edge.target);
            }
          }
        }
      }
      frontier = next;
    }
  }

  // Main fixpoint BFS: every other enabled relationship kind, walked until
  // nothing new is found or the shared budget runs out.
  let frontier = seedArr.concat(pending.splice(0, pending.length));
  while (frontier.length > 0 && !truncated) {
    for (const id of frontier) {
      if (expanded.has(id)) continue;
      if (!consumeBudget()) break;
      expanded.add(id);
      applyRules(id);
    }
    frontier = pending.splice(0, pending.length);
  }

  const finalizedGroups: RelatedEntityGroup[] = [];
  for (const group of groups.values()) {
    finalizedGroups.push({
      relationship: group.relationship,
      role: group.role,
      expressIds: [...group.expressIds].sort((a, b) => a - b),
      relationshipIds: [...group.relationshipIds].sort((a, b) => a - b),
    });
  }

  return { seeds: seedArr, groups: finalizedGroups, all, truncated };
}
