/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Viewer comparison includes every meshed entity plus products and type objects
 * with a GlobalId, whether or not they produced geometry (#8040).
 *
 * Geometry-less products include assemblies whose parts carry the meshes,
 * spatial containers and survey markers. Type objects often have no
 * RepresentationMaps: their own Name, Tag and HasPropertySets must still be
 * compared. A mesh is evidence about geometry, not a requirement for data diff.
 *
 * Relationships and property definitions stay out: their content belongs to
 * their owners. Non-product objects (tasks, groups, actors) and contexts remain
 * outside this viewer scope; the CLI deliberately compares the wider
 * IfcObjectDefinition population. Authored-key collision ownership uses that
 * wider population too, so sidecars agree across consumers.
 *
 * Membership uses every bundled schema (IFC2X3, IFC4, IFC4X3), including style-
 * named type objects and infrastructure classes absent from the IFC4 codegen.
 */

import {
  EntityExtractor,
  extractRootAttributesFromEntity,
  getInheritanceChainAcrossSchemas,
  type IfcDataStore,
} from '@ifc-lite/parser';
import { isTypeObjectClass } from './typeObjectTag.js';

/** class name → is it an `IfcProduct`. A property of the CLASS, and of the
 *  merged cross-schema registry rather than of any one model, so a
 *  process-lifetime cache keyed by uppercase name is sound. It is what keeps
 *  the WALK below cheap — a file's geometry buckets are dismissed without
 *  touching a single row — but note that the walk is not where the cost of this
 *  widening lands; see the module note. */
const productByClass = new Map<string, boolean>();

/**
 * Every entity that can own an authored comparison key under the CLI/MCP
 * `IfcObjectDefinition` scope. The viewer fingerprints products and type objects,
 * but collision ownership must use the wider shared scope or a sidecar can
 * assign a product a `prop:` key that another consumer correctly refuses.
 */
export function* authoredKeyOwnerIds(store: IfcDataStore): Generator<number> {
  const seen = new Set<number>();
  const extractor = new EntityExtractor(store.source);
  // @raw-entity-enumeration-ok Compare hands this the EFFECTIVE store (effectiveCompareStore bakes unsaved edits in), so the source index is the edited model
  for (const [typeKey, ids] of store.entityIndex.byType) {
    const upper = typeKey.toUpperCase();
    const chain = getInheritanceChainAcrossSchemas(upper);
    const knownOwner = chain.includes('IfcObjectDefinition');
    const unknownRoot = chain.length === 0 && !upper.startsWith('IFCREL');
    if (!knownOwner && !unknownRoot) continue;
    for (const expressId of ids) {
      if (seen.has(expressId)) continue;
      let globalId = store.entities.getGlobalId(expressId);
      if (!globalId && knownOwner) {
        // @raw-entity-enumeration-ok point lookup of one record in the effective store Compare passes in
        const ref = store.entityIndex.byId.get(expressId);
        const entity = ref ? extractor.extractEntity(ref) : undefined;
        globalId = entity ? (extractRootAttributesFromEntity(entity).globalId ?? '') : '';
      }
      if (!globalId) continue;
      seen.add(expressId);
      yield expressId;
    }
  }
}

/**
 * Is this IFC class an `IfcProduct` subtype?
 *
 * Answered from the cross-schema chain (see the module note). A class no
 * bundled schema declares — a vendor extension — answers `false`: it keeps
 * exactly the reach the geometry pass gives it, and is not guessed into the
 * comparison on the strength of its name.
 */
export function isProductClass(ifcType: string): boolean {
  const upper = ifcType.toUpperCase();
  const cached = productByClass.get(upper);
  if (cached !== undefined) return cached;
  const isProduct = getInheritanceChainAcrossSchemas(upper).includes('IfcProduct');
  productByClass.set(upper, isProduct);
  return isProduct;
}

/**
 * Every product or type object in a store that carries a `GlobalId`, as model-local express
 * ids. Lazy so the caller can fold it into an existing map without
 * materialising a second array per model.
 *
 * **An object with no resolvable `GlobalId` is skipped rather than keyed
 * synthetically.** A synthetic key is per-model by construction, so it can
 * never match across A and B: taking one in would manufacture an add on one
 * side and a delete on the other for an entity that did not change. The meshed
 * population accepts that trade (a mesh with no GlobalId is at least a visible
 * thing the user can be shown); a widening does not get to.
 *
 * May yield the same express id twice if a store's `byType` lists it under two
 * keys — the CLI's equivalent walk carries a `seen` set for that reason. The
 * one caller folds these into a Map it already checks with `has`, so a repeat
 * is absorbed; a second caller must de-duplicate for itself.
 */
export function* comparableObjectIds(store: IfcDataStore): Generator<number> {
  // @raw-entity-enumeration-ok Compare hands this the EFFECTIVE store (effectiveCompareStore bakes unsaved edits in), so the source index is the edited model
  for (const [typeKey, ids] of store.entityIndex.byType) {
    if (!isProductClass(typeKey) && !isTypeObjectClass(typeKey)) continue;
    for (const expressId of ids) {
      if (!store.entities.getGlobalId(expressId)) continue;
      yield expressId;
    }
  }
}
