/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The root classification for a `subsetEntityIds` STEP export (#2934, the
 * "anonymized isolated export" feature): which entities the caller's
 * `includedIds` selection may legally seed, and which entities must be
 * excluded outright regardless of whether the closure walk would otherwise
 * reach them.
 *
 * Mirrors `reference-collector.ts`'s `getVisibleEntityIds` in shape — both
 * produce a `{ roots, excludeIds }` pair `step-collection.ts` feeds to the
 * same `collectReferencedEntityIds` + `collectStyleEntities` tail — but the
 * classification rule is the opposite of `visibleOnly`'s. `visibleOnly`
 * starts from "everything is a root unless hidden"; a subset export starts
 * from "nothing is a root unless named", because the caller is picking a
 * handful of entities out of a whole model, not hiding a handful out of it.
 */

import {
  ENTITIES_IFC2X3,
  ENTITIES_IFC4,
  ENTITIES_IFC4X3,
} from '@ifc-lite/data';
import type { EffectiveEntityIndex } from './effective-index.js';
import { INFRASTRUCTURE_TYPES, collectDescendantNames } from './reference-collector.js';

/**
 * Every `IfcRoot` descendant across the three bundled schemas (IFC2X3, IFC4,
 * IFC4X3), UPPERCASE — the set of types a subset export ever needs to
 * classify as "included" or "excluded". `IfcRoot` itself is abstract and
 * never instantiated, so it is not a member (same convention as
 * `PRODUCT_TYPES` not containing `IFCPRODUCT`).
 *
 * Derived from the generated schema tables via `collectDescendantNames`
 * rather than hand-listed, for the same reason `PRODUCT_TYPES` is: a
 * hand-written list silently stops matching the schema the day it changes,
 * and a subset export that fails to classify a genuinely-rooted entity type
 * would either leak it (never excluded) or drop it (never includable) with
 * no error.
 */
export const IFC_ROOT_TYPES: ReadonlySet<string> = buildRootTypes();

function buildRootTypes(): Set<string> {
  const roots = new Set<string>();
  for (const table of [ENTITIES_IFC2X3, ENTITIES_IFC4, ENTITIES_IFC4X3]) {
    collectDescendantNames(table, 'IfcRoot', roots);
  }
  return roots;
}

/**
 * Entity types that identify the SOURCE model or its authoring context
 * rather than the geometry a bug reproduction needs — addresses and
 * georeferencing. None of these are `IfcRoot` descendants (they carry no
 * `GlobalId`), so `IFC_ROOT_TYPES` alone would never exclude them; a subset
 * export must name them separately or a caller's included wall still drags
 * its `IfcSite`'s `IfcPostalAddress` / `IfcMapConversion` chain along for the
 * ride purely because nothing else in the closure competes for that #id.
 *
 * `IFCACTORROLE` is here for the same reason, one level removed: it hangs
 * off `IfcPerson`/`IfcOrganization` (owner history), not off a spatial
 * entity, but it is exactly as identifying — a role like "Structural
 * Engineer, ACME Consulting" — and equally unreachable through
 * `IFC_ROOT_TYPES`.
 */
export const IDENTIFYING_TYPES: ReadonlySet<string> = new Set([
  'IFCPOSTALADDRESS',
  'IFCTELECOMADDRESS',
  'IFCMAPCONVERSION',
  'IFCMAPCONVERSIONSCALED',
  'IFCPROJECTEDCRS',
  'IFCGEOGRAPHICCRS',
  'IFCACTORROLE',
]);

/** The address half of `GEOREFERENCE_TYPES`. Every one of these is reached by
 *  a FORWARD attribute -- `IfcSite.SiteAddress`, `IfcBuilding.BuildingAddress`,
 *  `IfcPerson`/`IfcOrganization.Addresses` -- so "keep" means only "stop
 *  EXCLUDING them" and the closure walk from the included roots decides the
 *  rest. They must NOT be rooted: rooting is unconditional over the whole
 *  source model, so an address hanging off an EXCLUDED sibling site, or off
 *  owner history whose `Addresses` slot the scrub blanked, would be written
 *  verbatim into a file whose entire purpose is that it can be shared
 *  (#3351 review). */
const ADDRESS_TYPES: ReadonlySet<string> = new Set([
  'IFCPOSTALADDRESS',
  'IFCTELECOMADDRESS',
]);

/** The coordinate half of `GEOREFERENCE_TYPES`. Unlike the addresses above,
 *  nothing in the file forward-references these: `IfcCoordinateOperation`
 *  hangs off `IfcGeometricRepresentationContext` by an INVERSE attribute and
 *  the CRS records hang off it, so the closure cannot reach them and "keep"
 *  has to mean ROOT. They describe the model's placement on the earth rather
 *  than any one spatial entity, so rooting them is not the sibling-leak the
 *  addresses would be. */
const COORDINATE_REFERENCE_TYPES: ReadonlySet<string> = new Set([
  'IFCMAPCONVERSION',
  'IFCMAPCONVERSIONSCALED',
  'IFCPROJECTEDCRS',
  'IFCGEOGRAPHICCRS',
]);

/** The subset of `IDENTIFYING_TYPES` the "Georeferencing & addresses" option
 *  governs. Dropping these while `removeGeoreferencing` is false left an
 *  `IfcSite` pointing at a `SiteAddress` line that was not written -- an
 *  invalid STEP file, reported with no warning, because the dangling-ref repair
 *  only rewrites `IFCREL*` lines and never sees a direct attribute slot (#3351).
 *
 *  `IFCACTORROLE` is deliberately absent: it belongs to owner history, which
 *  this option does not govern, so it stays dropped unconditionally. */
export const GEOREFERENCE_TYPES: ReadonlySet<string> = new Set([
  ...ADDRESS_TYPES,
  ...COORDINATE_REFERENCE_TYPES,
]);

/** `IDENTIFYING_TYPES`, minus what the caller asked to keep. */
export function identifyingTypesFor(removeGeoreferencing: boolean): ReadonlySet<string> {
  if (removeGeoreferencing) return IDENTIFYING_TYPES;
  return new Set([...IDENTIFYING_TYPES].filter((t) => !GEOREFERENCE_TYPES.has(t)));
}

/** What a `subsetEntityIds` export needs from `step-collection.ts`'s closure tail. */
export interface SubsetEntityIds {
  /** Seed set for `collectReferencedEntityIds`: infrastructure plus every
   *  caller-included id that actually exists in `index`. */
  readonly roots: Set<number>;
  /** Every `IfcRoot`/`IDENTIFYING_TYPES` id NOT in `includedIds` — passed as
   *  `pass.hiddenProductIds` so the existing `visibleOnly` dangling-ref
   *  protection (`evaluateOmissionPredicates` +
   *  `filterHiddenRefsFromRelationshipLine`) covers a subset export too. */
  readonly excludedIds: Set<number>;
}

/**
 * Classify every entity in `index` for a `subsetEntityIds` export: a root
 * (infrastructure, always; or a caller-included id), an excluded id (an
 * `IfcRoot`/identifying-type id the caller did NOT include), or neither (left
 * to the forward closure walk to decide, same as `visibleOnly`'s "all other
 * entity types" fallthrough).
 *
 * Runs over the EFFECTIVE index — `pass.effective`, not `dataStore` — for the
 * same reason `getVisibleEntityIds` does: an overlay-created entity has no
 * source record for a dataStore-only scan to find, a retyped entity must be
 * classified by its new class, and a tombstoned one must not appear at all
 * (`EffectiveEntityIndex` iteration already skips it).
 */
export function getSubsetEntityIds(
  index: EffectiveEntityIndex,
  includedIds: ReadonlySet<number>,
  /** Which identifying classes to exclude. Defaults to all of them, so the
   *  general STEP-collection path is unchanged; the anonymize path narrows it
   *  with `identifyingTypesFor` when the caller asked to keep georeferencing
   *  and addresses (#3351). */
  identifying: ReadonlySet<string> = IDENTIFYING_TYPES,
): SubsetEntityIds {
  const roots = new Set<number>();
  const excludedIds = new Set<number>();

  for (const [expressId, entityRef] of index) {
    const typeUpper = index.effectiveType(expressId, entityRef.type);

    if (INFRASTRUCTURE_TYPES.has(typeUpper)) {
      roots.add(expressId);
      continue;
    }

    if (includedIds.has(expressId)) {
      roots.add(expressId);
      continue;
    }

    // A COORDINATE type the caller asked to KEEP has to be ROOTED, not merely
    // left out of the exclusion set. `IfcCoordinateOperation` hangs off
    // `IfcGeometricRepresentationContext` by an INVERSE attribute, so the
    // forward closure never reaches it: not excluding it only meant it was
    // dropped silently instead of deliberately, and the toggle named
    // "Map conversion, CRS, lat/long, addresses" kept the last two (#3351).
    //
    // The ADDRESS types are deliberately not rooted here -- see
    // `ADDRESS_TYPES`. They are forward-referenced, so dropping them out of
    // `identifying` is already enough for an INCLUDED site's or building's
    // address to survive the closure, while an excluded sibling site's stays
    // unreachable. Rooting them would emit every address in the source model.
    if (COORDINATE_REFERENCE_TYPES.has(typeUpper) && !identifying.has(typeUpper)) {
      roots.add(expressId);
      continue;
    }

    if (IFC_ROOT_TYPES.has(typeUpper) || identifying.has(typeUpper)) {
      excludedIds.add(expressId);
    }
    // Everything else (geometry, relationships, property atoms, materials,
    // …) is neither a root nor excluded here — the forward closure walk from
    // `roots` decides whether it survives, exactly as `visibleOnly`'s
    // fallthrough does.
  }

  return { roots, excludedIds };
}
