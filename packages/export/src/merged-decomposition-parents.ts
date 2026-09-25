/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * One-parent-per-object bookkeeping for the decomposition relationships of a
 * merge (#5471, #5726).
 *
 * Split out of {@link ../merged-exporter.ts} (kept under its module-size
 * budget) rather than duplicated: `findEntitiesByType`/`extractStepAttribute`
 * stay the single source of truth in `MergedExporter` and are passed in here,
 * so this file has no data-model logic of its own to drift from it.
 */

import type { IfcDataStore } from '@ifc-lite/parser';
import { filterHiddenRefsFromRelationshipLine } from './reference-collector.js';
import type { IfcSchemaVersion } from './schema-converter.js';

/**
 * Each decomposition relationship → the `SET [0:1]` inverse on
 * `IfcObjectDefinition` its RelatedObjects fill, in the OUTPUT schema. Both
 * relationships carry RelatingObject at attr 4 and RelatedObjects at attr 5 in
 * every schema.
 *
 * IFC2X3: `Decomposes : SET [0:1] OF IfcRelDecomposes`, and IfcRelAggregates
 * and IfcRelNests are both IfcRelDecomposes, so one nesting and one
 * aggregation parent together are already two (#5726). IFC4 and later split
 * `Nests : SET [0:1] OF IfcRelNests` off `Decomposes : SET [0:1] OF
 * IfcRelAggregates`: one parent of each kind, but still only one each.
 */
const IFC2X3_INVERSES: ReadonlyMap<string, string> = new Map([
  ['IFCRELAGGREGATES', 'Decomposes'],
  ['IFCRELNESTS', 'Decomposes'],
]);
const IFC4_INVERSES: ReadonlyMap<string, string> = new Map([
  ['IFCRELAGGREGATES', 'Decomposes'],
  ['IFCRELNESTS', 'Nests'],
]);

/**
 * The final ids already given a WRITTEN parent in the merge output, per
 * single-valued decomposition inverse of the output schema. One instance per
 * merge, grown model by model in merge order.
 */
export class DecompositionClaims {
  /** Relationship type (uppercase) → the inverse it fills; see {@link IFC4_INVERSES}. */
  readonly inverseOf: ReadonlyMap<string, string>;
  private readonly parented = new Map<string, Set<number>>();

  /** `only` narrows the claimed relationship types (the #5725 drop planner's view). */
  constructor(outputSchema: IfcSchemaVersion, only: (relType: string) => boolean = () => true) {
    const inverses = outputSchema === 'IFC2X3' ? IFC2X3_INVERSES : IFC4_INVERSES;
    this.inverseOf = new Map([...inverses].filter(([relType]) => only(relType)));
  }

  /** The final ids that already fill `inverse` in the output. */
  parentedVia(inverse: string): Set<number> {
    let ids = this.parented.get(inverse);
    if (ids === undefined) this.parented.set(inverse, (ids = new Set()));
    return ids;
  }
}

/** What {@link claimDecompositionParents} needs to know about one model's plan. */
export interface DecompositionClaimInput {
  dataStore: IfcDataStore;
  /** Local id → final id for every unified entity (spatial, infrastructure, GlobalId). */
  sharedRemap: ReadonlyMap<number, number>;
  /** This model's id offset: an unremapped local id's final id is `id + idOffset`. */
  idOffset: number;
  /** Local ids not written; a skipped rel claims nothing, and a rel skipped here is added. */
  skipEntityIds: Set<number>;
  /** Local rel id → member ids to drop from its written RelatedObjects list. */
  relParentStrip: Map<number, Set<number>>;
  /**
   * Whether a local id survives into the output as a reference: false for a
   * hidden product under `visibleOnly` or a dropped empty container, which
   * `renderEntity` narrows out of (or, as a RelatingObject, withholds) the rel.
   */
  isEmitted: (localId: number) => boolean;
  /** Whether the rel line itself is in the written set at all (visibility closure). */
  isIncluded: (localId: number) => boolean;
  /** Strip already-parented members (a later, unified model); false just records claims. */
  dedupe: boolean;
}

/**
 * Keep one decomposition parent per object and inverse across a merge (#5471,
 * #5726).
 *
 * `IfcObjectDefinition.Decomposes` (and, from IFC4, `.Nests`) is `SET [0:1]`,
 * and `IfcSpatialStructureElement.WR41` requires exactly one for a building or
 * storey. Once a later model's Building unifies with the primary's, the
 * primary's own rel already gives it a parent, so a later rel naming the same
 * (remapped) Building gives it a second one, whether that rel's RelatingObject
 * remaps to the same parent (a duplicate edge, e.g. `(Project, (Site))` twice)
 * or a different one (model B aggregates its Building under its Project, model
 * A under a Site). Which relationships share an inverse is the output schema's
 * call, held by {@link DecompositionClaims}.
 *
 * `claims` holds the final ids that already have a parent WRITTEN to the
 * output. Called once per model in merge order, after all of that model's
 * unification and container drops: every rel the model will write adds its
 * written members. A rel that will not be written (skipped, outside the
 * visibility closure, or with a hidden or dropped RelatingObject) claims
 * nothing, and neither does a member narrowed out of it, so a later model's rel
 * stays the parent of an object whose primary parent is not in the output.
 *
 * With `dedupe`, a written member already claimed for the rel's inverse is
 * redundant: a rel whose written members are ALL redundant is skipped, one with
 * SOME is kept for its new members and the redundant ids go to
 * `relParentStrip` for {@link applyRelParentStrip}. A unified member with no
 * parent yet is kept, since that rel is then its only parentage statement
 * (#3550).
 */
export function claimDecompositionParents(
  input: DecompositionClaimInput,
  claims: DecompositionClaims,
  findEntitiesByType: (dataStore: IfcDataStore, typeUpper: string) => number[],
  extractStepAttribute: (expressId: number, dataStore: IfcDataStore, attrIndex: number) => string | null,
): void {
  const { dataStore, sharedRemap, idOffset, skipEntityIds, relParentStrip, isEmitted, isIncluded, dedupe } = input;
  const finalId = (ref: number) => sharedRemap.get(ref) ?? ref + idOffset;
  for (const [relType, inverse] of claims.inverseOf) {
    const parented = claims.parentedVia(inverse);
    for (const relId of findEntitiesByType(dataStore, relType)) {
      if (skipEntityIds.has(relId) || !isIncluded(relId)) continue;
      // RelatingObject is attr 4 — a single #ref; a hidden or dropped one withholds the line.
      const relating = extractStepAttribute(relId, dataStore, 4)?.match(/^#(\d+)$/);
      if (relating && !isEmitted(parseInt(relating[1], 10))) continue;
      // RelatedObjects is attr 5 — list of #refs like (#2,#3); hidden members are narrowed out.
      const refs = listRefs(extractStepAttribute(relId, dataStore, 5)).filter(isEmitted);
      if (refs.length === 0) continue;

      const redundantRefs = dedupe ? refs.filter(ref => parented.has(finalId(ref))) : [];
      if (redundantRefs.length === refs.length) {
        // Every written member already has a parent in the output — fully redundant.
        skipEntityIds.add(relId);
        continue;
      }
      if (redundantRefs.length > 0) relParentStrip.set(relId, new Set(redundantRefs));
      for (const ref of refs) parented.add(finalId(ref));
    }
  }
}

/** The `#id`s in one STEP list attribute, in order; `[]` for a missing one. */
function listRefs(attr: string | null): number[] {
  if (!attr) return [];
  const refs: number[] = [];
  const refRegex = /#(\d+)/g;
  let match: RegExpExecArray | null;
  while ((match = refRegex.exec(attr)) !== null) refs.push(parseInt(match[1], 10));
  return refs;
}

/**
 * Render-time counterpart of {@link claimDecompositionParents}: drop the
 * RelatedObjects members of a partially redundant IFCRELAGGREGATES or
 * IFCRELNESTS that already have a parent of that kind in the output.
 * Reuses the same list/scalar-aware ref filter the
 * `visibleOnly`/deletion dangling-ref path uses. Must run in LOCAL id
 * space, before any id offset/remap — `localId` and the ids inside
 * `relParentStrip` are both local to the model being rendered.
 *
 * Returns `entityText` unchanged when `localId` has no strip entry, and
 * `null` when the filter would withhold the whole line — a strip set built
 * by {@link claimDecompositionParents} is a strict subset of the
 * RelatedObjects list, so for well-formed input the filter only narrows,
 * but a degenerate file (a stripped member id that also appears as a
 * single-valued ref, e.g. self-aggregation) can null the line. The caller
 * must withhold it, like every other user of the filter: every edge the
 * line declared is already declared by the primary model, and emitting the
 * unfiltered bytes instead would reintroduce the duplicate membership this
 * module exists to remove.
 */
export function applyRelParentStrip(
  entityText: string,
  localId: number,
  relParentStrip: ReadonlyMap<number, ReadonlySet<number>>,
): string | null {
  const toStrip = relParentStrip.get(localId);
  if (toStrip === undefined) return entityText;
  return filterHiddenRefsFromRelationshipLine(entityText, id => toStrip.has(id));
}
