/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Demesher prune: ONE global reverse-reference mark-and-sweep over the
 * replaced products' detached geometry subgraphs (see `demesh-writer.ts` for
 * the authoring side). An old geometry entity is tombstoned only when every
 * entity that references it is itself being tombstoned, so shared
 * representations (`IfcMappedItem` sources, an `IfcProductDefinitionShape`
 * shared by several products) and type-library geometry survive partial
 * selections by construction.
 *
 * The reverse index is built from the UNMODIFIED source bytes via the
 * string-literal-aware `#N` scanner in `reference-collector.ts`; overlay
 * entities added by the writer are invisible to it, which is why shared
 * infrastructure (`PROTECTED_TYPES`) must never fall even when orphaned.
 */

import { EntityExtractor, type IfcDataStore } from '@ifc-lite/parser';
import { collectReferencedEntityIds, collectRefsInByteRange } from './reference-collector.js';
import type { DemeshApplyReport, DemeshEditorLike } from './demesh-writer.js';

/**
 * Entity types the sweep must never tombstone even when they fall inside a
 * replaced subgraph's closure: shared model infrastructure that the NEW
 * overlay entities (invisible to the source-byte reverse index) or the rest
 * of the file may reference.
 */
const PROTECTED_TYPES = new Set([
  'IFCGEOMETRICREPRESENTATIONCONTEXT',
  'IFCGEOMETRICREPRESENTATIONSUBCONTEXT',
  'IFCUNITASSIGNMENT',
  'IFCSIUNIT',
  'IFCCONVERSIONBASEDUNIT',
  'IFCOWNERHISTORY',
  'IFCPERSON',
  'IFCORGANIZATION',
  'IFCPERSONANDORGANIZATION',
  'IFCAPPLICATION',
]);

/**
 * Global reverse-reference mark-and-sweep over the replaced products' old
 * geometry subgraphs (see the module doc). Also strips void relationships
 * for replaced hosts and filters `IfcPresentationLayerAssignment` item
 * lists that pointed at pruned geometry.
 */
export function pruneReplacedSubgraphs(
  store: IfcDataStore,
  editor: DemeshEditorLike,
  replacedOldRep: Map<number, number | null>,
  stripOpenings: boolean,
  report: DemeshApplyReport,
): void {
  const source = store.source!;
  const byId = store.entityIndex.byId;
  const extractor = new EntityExtractor(source);
  const indexAdapter = {
    get: (id: number) => byId.get(id),
    has: (id: number) => byId.has(id),
  };

  // -- Roots: the detached representation subgraphs.
  const roots = new Set<number>();
  for (const oldRep of replacedOldRep.values()) {
    if (oldRep !== null && byId.has(oldRep)) roots.add(oldRep);
  }

  // -- Openings of replaced hosts: the rel is deleted outright (its cut is
  // baked into the new mesh); the opening element and its geometry join the
  // candidate closure and fall to the ordinary sweep.
  const deleted = new Set<number>();
  if (stripOpenings) {
    for (const [id, ref] of byId) {
      if (ref.type.toUpperCase() !== 'IFCRELVOIDSELEMENT') continue;
      const rel = extractor.extractEntity(ref);
      const relating = rel?.attributes?.[4];
      const opening = rel?.attributes?.[5];
      if (typeof relating !== 'number' || !replacedOldRep.has(relating)) continue;
      deleted.add(id);
      if (typeof opening === 'number' && byId.has(opening)) {
        roots.add(opening);
      }
    }
  }

  if (roots.size === 0 && deleted.size === 0) return;

  // -- Candidate closure: everything transitively reachable from the roots.
  const closure = collectReferencedEntityIds(roots, source, indexAdapter);

  // Style/annotation entities hang OFF the geometry (IfcStyledItem.Item →
  // geometry item), so forward reachability misses them; pull in styled
  // items whose target is in the closure, plus what they reference (shared
  // surface styles survive via their other referrers).
  const styledItemRoots = new Set<number>();
  for (const [id, ref] of byId) {
    if (closure.has(id) || ref.type.toUpperCase() !== 'IFCSTYLEDITEM') continue;
    const refs = collectRefsInByteRange(source, ref.byteOffset, ref.byteLength);
    if (refs.some((target) => target !== id && closure.has(target))) {
      styledItemRoots.add(id);
    }
  }
  if (styledItemRoots.size > 0) {
    for (const id of collectReferencedEntityIds(styledItemRoots, source, indexAdapter)) {
      closure.add(id);
    }
  }

  // -- Reverse-reference index, restricted to edges INTO the closure.
  const referrers = new Map<number, Set<number>>();
  for (const [id, ref] of byId) {
    // Presentation layers ANNOTATE geometry, they don't own it: counting
    // their edges as referrers would keep replaced geometry alive forever
    // (the layer itself is outside the closure and never falls), defeating
    // the AssignedItems filtering below. Skip them so layer-only-referenced
    // geometry prunes and the filter then cleans the surviving layer's list.
    if (ref.type.toUpperCase() === 'IFCPRESENTATIONLAYERASSIGNMENT') continue;
    const refs = collectRefsInByteRange(source, ref.byteOffset, ref.byteLength);
    for (const target of refs) {
      if (target === id || !closure.has(target)) continue;
      let set = referrers.get(target);
      if (!set) {
        set = new Set();
        referrers.set(target, set);
      }
      set.add(id);
    }
  }

  // The representation swap detached product → old-PDS: remove those edges
  // (the reverse index was built from the unmodified source bytes).
  for (const [productId, oldRep] of replacedOldRep) {
    if (oldRep !== null) referrers.get(oldRep)?.delete(productId);
  }

  // -- Sweep to fixpoint: tombstone an entity once every referrer is
  // tombstoned. Protected infrastructure never falls, even if orphaned.
  let changed = true;
  while (changed) {
    changed = false;
    for (const id of closure) {
      if (deleted.has(id)) continue;
      const ref = byId.get(id);
      if (!ref || PROTECTED_TYPES.has(ref.type.toUpperCase())) continue;
      const incoming = referrers.get(id);
      let live = false;
      if (incoming) {
        for (const from of incoming) {
          if (!deleted.has(from)) {
            live = true;
            break;
          }
        }
      }
      if (!live) {
        deleted.add(id);
        changed = true;
      }
    }
  }

  // -- Apply tombstones.
  let openingCount = 0;
  for (const id of deleted) {
    const type = byId.get(id)?.type.toUpperCase();
    if (type === 'IFCRELVOIDSELEMENT' || type === 'IFCOPENINGELEMENT') openingCount++;
    if (editor.removeEntity(id)) report.prunedEntityCount++;
  }
  report.strippedOpeningCount = openingCount;

  // -- Presentation layers: filter tombstoned items out of AssignedItems;
  // a layer left empty is tombstoned too (an empty list is schema-invalid).
  for (const [id, ref] of byId) {
    if (deleted.has(id) || ref.type.toUpperCase() !== 'IFCPRESENTATIONLAYERASSIGNMENT') continue;
    const layer = extractor.extractEntity(ref);
    const items = layer?.attributes?.[2];
    if (!Array.isArray(items)) continue;
    const kept = items.filter((item) => typeof item === 'number' && !deleted.has(item));
    if (kept.length === items.length) continue;
    if (kept.length === 0) {
      if (editor.removeEntity(id)) report.prunedEntityCount++;
    } else {
      editor.setPositionalAttribute(id, 2, kept.map((item) => `#${item as number}`));
    }
  }
}
