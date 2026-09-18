/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * IFC class families (issue #4955): groups of classes an authoring tool may
 * swap between while publishing the SAME material.
 *
 * The split/merge detector and the successor stage generate candidates per
 * bucket, and the bucket used to be the exact `ifcType`. That made every
 * cross-class split invisible: an `IfcWall` republished as three
 * `IfcWallStandardCase`s, or as `IfcBuildingElementPart` layers (the IFC4 way
 * to publish a wall's buildup as parts), was never seen — the pieces sat in a
 * different bucket from the whole. The volume and containment evidence for
 * those cases is exactly the same as for a same-class split, so the bucket
 * becomes the class FAMILY.
 *
 * A family is deliberately narrow: only the `StandardCase` / `ElementedCase`
 * subtypes the schema itself relates, plus the part class that publishes a
 * host's layers. It does not say that an `IfcWall` and an `IfcCovering` are
 * the same kind of thing, because they are not, and a family that broad would
 * let a covering traced over a demolished wall fake a volume-conserving split.
 *
 * Matching is case-insensitive: `ifcType` is compared verbatim elsewhere in
 * the engine, but the adapters in this repo emit mixed casings (`IfcWall` from
 * the viewer, `IFCWALL` from the columnar parser), and a family table that
 * only matched one of them would be a table with a hole in it.
 *
 * An unlisted class is its own family, so a caller that supplies no table and
 * a model with no listed classes see byte-identical behaviour to before.
 */

/** One family per row. The first entry is the family's canonical name. */
export const DEFAULT_CLASS_FAMILIES: readonly (readonly string[])[] = [
  ['IfcWall', 'IfcWallStandardCase', 'IfcWallElementedCase', 'IfcBuildingElementPart'],
  ['IfcSlab', 'IfcSlabStandardCase', 'IfcSlabElementedCase'],
  ['IfcBeam', 'IfcBeamStandardCase'],
  ['IfcColumn', 'IfcColumnStandardCase'],
  ['IfcMember', 'IfcMemberStandardCase'],
  ['IfcPlate', 'IfcPlateStandardCase'],
  ['IfcDoor', 'IfcDoorStandardCase'],
  ['IfcWindow', 'IfcWindowStandardCase'],
  ['IfcOpeningElement', 'IfcOpeningStandardCase'],
  ['IfcFurniture', 'IfcFurnishingElement', 'IfcSystemFurnitureElement'],
];

/** Resolves an `ifcType` to its family key. */
export type ClassFamilyResolver = (ifcType: string) => string;

function normalize(ifcType: string): string {
  return ifcType.trim().toUpperCase();
}

/**
 * Build a resolver from a family table. Every member maps to the family's
 * canonical name (the row's first entry, normalized); an unlisted class maps to
 * itself, normalized. A class listed in two rows belongs to the row that
 * appears first — a table is a reviewed artifact and a duplicate in it is a
 * mistake, not a request for a union.
 *
 * Rows that are empty, or whose entries are not non-empty strings, are
 * skipped, and a table that is not an array at all falls back to the default,
 * because the table can arrive from an untyped JS caller and `diffModels` has
 * no error channel for its options.
 */
export function classFamilyResolver(
  families: readonly (readonly string[])[] = DEFAULT_CLASS_FAMILIES,
): ClassFamilyResolver {
  const byClass = new Map<string, string>();
  for (const row of Array.isArray(families) ? families : DEFAULT_CLASS_FAMILIES) {
    if (!Array.isArray(row)) continue;
    const members = row.filter((name) => typeof name === 'string' && name.trim().length > 0);
    if (members.length === 0) continue;
    const canonical = normalize(members[0]);
    for (const member of members) {
      const key = normalize(member);
      if (!byClass.has(key)) byClass.set(key, canonical);
    }
  }
  return (ifcType: string): string => {
    const key = normalize(ifcType);
    return byClass.get(key) ?? key;
  };
}

/** The resolver over {@link DEFAULT_CLASS_FAMILIES}. */
export const familyOf: ClassFamilyResolver = classFamilyResolver();

/** Case-insensitive class equality, for a `crossClass` flag that must not fire
 *  on `IFCWALL` versus `IfcWall` from two adapters' spellings. */
export function sameIfcClass(a: string, b: string): boolean {
  return normalize(a) === normalize(b);
}
