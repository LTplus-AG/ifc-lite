/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Which entities of a loaded model take part in a viewer comparison, beyond the
 * ones the geometry pass produced a mesh for.
 *
 * Compare used to enumerate its entities from the tessellated meshes alone (see
 * `buildFingerprints.ts`), which silently made "did it change?" mean "did a
 * *renderable* thing change?". Every object whose Representation is `$` was
 * therefore invisible to it, in both directions:
 *
 * - an `IfcElementAssembly` whose meshes all live on its `IfcRelAggregates`
 *   parts — its own attributes and property sets could change freely and the
 *   panel reported nothing;
 * - an `IfcSite`, or a placeholder `IfcBuildingElementProxy` marking a survey
 *   origin — deleted between two revisions and never listed as deleted.
 *
 * Nothing was ever *falsely* reported, so the omission reads as a clean, short
 * answer rather than a broken one, which is what makes it worth a named rule.
 * Same root cause as the framing / By-Class / By-Type fix for geometry-less
 * assemblies (#1133), which resolved an assembly to its parts; a comparison
 * cannot do that, because the assembly's *own* data is the thing being
 * compared — so it widens the population instead.
 *
 * **The rule: every `IfcProduct` with a resolvable `GlobalId`.**
 *
 * `IfcProduct` is the "objects the user thinks of as objects" line. It covers
 * physical elements, the spatial structure (`IfcSite`/`IfcBuilding`/
 * `IfcBuildingStorey`/`IfcSpace`), assemblies, annotations, grids and ports —
 * exactly the population the compare rows, the 3D overlay and the exported CSV
 * are about.
 *
 * **What this actually adds is larger than the three examples above.** The
 * meshing gate already permits any `IfcProduct` except the abstract spatial
 * containers (`rust/core/src/schema_helpers.rs`, `is_non_geometric_spatial`),
 * so `IfcOpeningElement`, `IfcSpace`, `IfcAnnotation` and `IfcVirtualElement`
 * were already compared whenever they carried a representation. What arrives
 * new is every product WITHOUT one, and on an MEP model that is dominated by
 * `IfcDistributionPort` (the hierarchy builder's own note puts ports at
 * roughly two thirds of an `IfcDistributionSystem`'s members), plus
 * `IfcBuildingStorey` and the `IfcFacility`/`IfcFacilityPart` families, which
 * the gate blocks outright. Those are real, rooted, individually-named objects
 * and a rename or a re-status on one is a real change — but they only produce
 * a ROW when they actually differ, while the per-entity extraction in
 * `buildFingerprints.ts` (`buildDataInput` reparses from the source buffer)
 * costs the same whether they changed or not. A user who does not want them
 * has the existing ignore-classes blacklist (#1470).
 *
 * Everything below `IfcProduct` in IFC's dependency direction stays out, which
 * is what keeps a widened enumeration from becoming a churn flood:
 *
 * - `IfcRepresentationItem` (`IfcCartesianPoint`, `IfcPolyline`, …) — geometry
 *   resources, not `IfcRoot`, no cross-file identity at all.
 * - `IfcRelationship` (`IfcRelAggregates`, `IfcRelContainedInSpatialStructure`,
 *   …) — identity is its endpoints, so a re-GUID with both ends untouched is
 *   pure noise; on a re-export it is most of the churn. Same exclusion the CLI
 *   diff scope makes (`packages/cli/src/commands/diff-scope.ts`).
 * - `IfcPropertyDefinition` — a pset's content already travels with its owner,
 *   so comparing it again double-reports every edited property.
 * - `IfcContext` (`IfcProject`) and the non-product `IfcObject`s (`IfcTask`,
 *   `IfcActor`, `IfcGroup`, …) — rooted and comparable in principle, but not
 *   *elements*; taking them in is a scope decision for the panel to offer, not
 *   a side effect of a defect fix.
 * - `IfcTypeObject` — deliberately NOT added here. Type objects already reach
 *   compare through the geometry pass (#957/#994 emit type geometry), and this
 *   module only ever *adds* to that set, so nothing that compares today stops
 *   comparing. See the note on {@link comparableProductIds} about telling the
 *   two populations apart in the panel.
 *
 * Membership is decided from the inheritance chain of **every bundled schema**
 * (IFC2X3 + IFC4 + IFC4X3), never from the parser's IFC4 codegen pin: the pin
 * answers an empty chain for the IFC4X3 infrastructure classes
 * (`IfcTrackElement`, `IfcSignal`, `IfcBearing`, …) that are precisely what an
 * infrastructure model is made of, and an empty chain would read as "not a
 * product". Same lesson as `typeObjectTag.ts`.
 */

import { getInheritanceChainAcrossSchemas, type IfcDataStore } from '@ifc-lite/parser';

/** class name → is it an `IfcProduct`. A property of the CLASS, and of the
 *  merged cross-schema registry rather than of any one model, so a
 *  process-lifetime cache keyed by uppercase name is sound. It is what keeps
 *  the WALK below cheap — a file's geometry buckets are dismissed without
 *  touching a single row — but note that the walk is not where the cost of this
 *  widening lands; see the module note. */
const productByClass = new Map<string, boolean>();

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
 * Every product in a store that carries a `GlobalId`, as model-local express
 * ids. Lazy so the caller can fold it into an existing map without
 * materialising a second array per model.
 *
 * **A product with no resolvable `GlobalId` is skipped rather than keyed
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
export function* comparableProductIds(store: IfcDataStore): Generator<number> {
  for (const [typeKey, ids] of store.entityIndex.byType) {
    if (!isProductClass(typeKey)) continue;
    for (const expressId of ids) {
      if (!store.entities.getGlobalId(expressId)) continue;
      yield expressId;
    }
  }
}
