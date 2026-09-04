/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Entity names the bundled schema tables do not state, and the names they
 * mean.
 *
 * Two different relations live here, and they are NOT interchangeable — one is
 * a narrowing, the other is an equality, and the descendant direction reads
 * them differently:
 *
 * - {@link ENTITY_NAME_ALIASES} maps a leaf that appears in NO bundled table to
 *   its nearest schema-known SUPERTYPE. Walking up, the leaf resolves to that
 *   supertype. Walking down, the supertype gains the leaf — but the leaf must
 *   not gain its siblings.
 * - {@link CROSS_SCHEMA_RENAMES} pairs two names that are the SAME class under
 *   two schema versions. Both directions hold: either spelling has to reach the
 *   other's subtree, or a file's `FILE_SCHEMA` header decides whether a
 *   caller's own spelling works.
 *
 * `rust/core/src/legacy_entities.rs` is the third home for this knowledge and
 * carries both relations mixed together, because the Rust side only ever needs
 * "what modern type do I treat this record as". Its rows that name a leaf
 * present in some bundled table (`IFCWALLSTANDARDCASE`, `IFCPROXY`,
 * `IFCELECTRICALELEMENT`, …) need no row here: the union of the three tables
 * already states their parent. Pinned by
 * `packages/parser/test/query-backend-maps.test.ts`.
 */

/**
 * Leaf (UPPERCASE) → nearest schema-known supertype, for leaves absent from
 * ALL THREE bundled tables.
 *
 * IFC4.3 stratum subtypes (issue #860) — the schema only has the abstract
 * `IfcGeotechnicalStratum`, real models emit one of these three leaves with a
 * PredefinedType pinned (SOLID / VOID / WATER).
 *
 * There was a fourth row here, `IFCELECTRICALDISTRIBUTIONPOINT`. The IFC2X3
 * entity is `IfcElectricDistributionPoint` — no "AL" — so the key named nothing
 * and the row could never fire. Removed rather than respelled (#3172): the
 * correctly spelled name IS in `ENTITIES_IFC2X3`, so the union already resolves
 * it and an alias would be a second, shadowing answer. This table's mandate is
 * narrower than `legacy_entities.rs`'s: only names absent from all three
 * bundled tables belong here, which is why the five IFC2X3 products that fix
 * added on the Rust side have no row here either.
 */
export const ENTITY_NAME_ALIASES: Record<string, string> = {
  IFCSOLIDSTRATUM: 'IfcGeotechnicalStratum',
  IFCVOIDSTRATUM: 'IfcGeotechnicalStratum',
  IFCWATERSTRATUM: 'IfcGeotechnicalStratum',
};

/**
 * Pairs of names that are one class under two schema versions, `[older,
 * newer]`, both spellings UPPERCASE.
 *
 * IFC4X3 renamed `IfcBuildingElement` to `IfcBuiltElement` (and the type object
 * with it). Neither name is in the other version's table, so the union of the
 * tables alone leaves `byType('IfcBuildingElement')` blind to every IFC4X3-only
 * leaf (`IfcCourse`, `IfcKerb`, …) and `byType('IfcBuiltElement')` blind to
 * every IFC4 one — on the very same bytes, decided by the header.
 */
export const CROSS_SCHEMA_RENAMES: readonly (readonly [string, string])[] = [
  ['IFCBUILDINGELEMENT', 'IFCBUILTELEMENT'],
  ['IFCBUILDINGELEMENTTYPE', 'IFCBUILTELEMENTTYPE'],
];
