/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Handles the entity types `schema-converter.ts`'s hand-listed
 * {@link shouldSkipEntity} does not cover: an entity whose type is entirely
 * absent from the target schema's generated attribute table (not merely a
 * renamed or attribute-count-adjusted counterpart — see
 * `convertStepLine`'s `srcAttrs`/`tgtAttrs` lookup), where the type is not
 * one of `shouldSkipEntity`'s hand-listed alignment entities either.
 *
 * Split out of `schema-converter.ts` to stay under its line budget
 * (`scripts/module-size-allowlist.txt`).
 */

import { generateIfcGuid, type RandomSource } from '@ifc-lite/encoding';
import { deterministicGlobalId, getInheritanceChainAcrossSchemas, type IfcDataStore } from '@ifc-lite/parser';
import type { IfcSchemaVersion } from './schema-converter.js';

/**
 * Whether `type` is an IfcRoot subtype (has a GlobalId as its first
 * attribute), mirroring `merged-exporter.ts`'s `isRootedType`. Not imported
 * from there: `merged-exporter.ts` imports `schema-converter.ts`, and this
 * module is a dependency of `schema-converter.ts`, so importing back from
 * `merged-exporter.ts` would cycle.
 */
export function isRootedEntityType(type: string): boolean {
  return getInheritanceChainAcrossSchemas(type).includes('IfcRoot');
}

/**
 * Resolve an entity whose type has NO representation at all in `toSchema`
 * (distinct from a renamed or attribute-count-adjusted one).
 *
 * A rooted (IfcRoot) entity can safely become an IFCPROXY placeholder — the
 * same substitution `schema-converter.ts`'s `shouldSkipEntity` already
 * performs for its hand-listed alignment types, extended here to every other
 * unmapped rooted type instead of silently copying the source line's type and
 * IFC4-shaped attributes under the target schema's header (e.g. an
 * `IFCTRIANGULATEDFACESET` surviving unchanged into a file whose header
 * declares IFC2X3, which IFC2X3 never defined).
 *
 * A non-rooted entity (a representation item or resource type referenced
 * POSITIONALLY — e.g. from an `IfcShapeRepresentation.Items` list, or an
 * `IfcGeometricRepresentationContext`'s coordinate-operation attribute)
 * cannot take the same fallback: IFCPROXY is an IfcProduct, not an
 * IfcRepresentationItem or resource type, so substituting one there swaps one
 * illegal file for a differently-illegal one, and dropping the line would
 * leave the referencing entity's `#N` dangling — UNLESS the caller can prove
 * no surviving line still names it, which is exactly what
 * {@link WITHHOLDABLE_UNROOTED_TYPES} plus `schema-converter.ts`'s
 * `withheldRefIds` check together establish for one type (#4206). Every
 * other non-rooted type still throws instead of guessing.
 *
 * @param allowOmit - True only from a caller that ALSO redirects every
 *   referrer of a withheld id through this same function
 *   (`schema-converter.ts`'s `convertRecord`, when its caller supplied
 *   `withheldRefIds`). `merged-exporter.ts`'s federated path does not yet
 *   compute that set in its own (offset, remapped) id space, so it omits
 *   this argument and keeps the unconditional throw — proving the omission
 *   is safe there is future work, not assumed.
 */
export function resolveUnrepresentedEntity(
  prefix: string,
  entityType: string,
  attrsRaw: string,
  toSchema: IfcSchemaVersion,
  random?: RandomSource,
  allowOmit = false,
): string | null {
  if (isRootedEntityType(entityType)) {
    const guid = random
      ? generateIfcGuid(random)
      : deterministicGlobalId(`ifcproxy:${prefix}${entityType}(${attrsRaw})`);
    return `${prefix}IFCPROXY('${guid}',$,'${entityType}',$,$,$,$,.NOTDEFINED.,$);`;
  }
  if (allowOmit && WITHHOLDABLE_UNROOTED_TYPES.has(entityType)) return null;
  throw new Error(
    `Cannot convert ${prefix}${entityType}(${attrsRaw}) to ${toSchema}: ${entityType} has no ` +
    `representation in ${toSchema} and is not an IfcRoot subtype, so it can be neither dropped ` +
    `(the referencing entity would dangle) nor replaced with IFCPROXY (an IfcProduct, not a valid ` +
    `substitute for a representation item or resource type). Remove or pre-convert this entity ` +
    `before targeting ${toSchema}.`,
  );
}

/**
 * Non-rooted types whose OWN record — not merely a value referencing it —
 * is safe to OMIT from an IFC2X3 export instead of throwing (#4206).
 *
 * The default above (throw) exists because dropping an arbitrary non-rooted
 * line risks leaving some OTHER record's reference to it dangling, and this
 * function sees one line at a time — it has no way to know. Adding a type
 * here is only safe when EVERY legal reference to it is provably re-routed
 * through this same function too, so no surviving record can end up naming
 * an id this export omitted.
 *
 * `IfcStructuralLoadConfiguration` qualifies: the EXPRESS schema restricts
 * every legal reference to it to exactly one slot family —
 * `IfcStructuralActivity.AppliedLoad` on the structural action/reaction
 * types — and `schema-converter.ts`'s `convertRecord` forces every one of
 * those through this same "no representation" resolution whenever its
 * `AppliedLoad` names a withheld id (`withheldRefIds`, computed once per
 * export from every `IfcStructuralLoadConfiguration` id the source store
 * holds — see `computeWithheldRefIds`). A rooted referrer becomes an
 * IFCPROXY the same way any other unrepresented rooted type does; nothing
 * survives the export still pointing at the omitted `IfcStructuralLoadConfiguration`.
 *
 * The `IFCMATERIALPROFILE*` family (#5115) qualifies the same way:
 * `IfcMaterialProfile`, `IfcMaterialProfileSet` (+ its `MaterialProfiles`
 * list back-reference), `IfcMaterialProfileSetUsage`,
 * `IfcMaterialProfileSetUsageTapering` (adds a second `ForProfileEndSet`
 * slot) and `IfcMaterialProfileWithOffsets` are IFC4-only, non-rooted, and
 * every ordinary path to one of them is `IfcRelAssociatesMaterial
 * .RelatingMaterial` (the sole `IfcMaterialSelect`-typed attribute in the
 * schema) — `IfcRelAssociatesMaterial` is rooted, so it already gets the
 * IFCPROXY fallback regardless of this set. (A handful of generic,
 * multi-purpose non-rooted types could in principle also name one of these
 * ids — `IfcResourceObjectSelect` on `IfcExternalReferenceRelationship`/
 * `IfcResourceApprovalRelationship`/`IfcResourceConstraintRelationship`,
 * `IfcObjectReferenceSelect` on `IfcPropertyReferenceValue`, and
 * `IfcMaterialProperties.Material` (typed `IfcMaterialDefinition`, so it can
 * legally hold a profile/profile-set directly, not only a plain
 * `IfcMaterial`) — they are deliberately NOT added here, because
 * `computeWithheldRefIds` is type-scoped, not instance-scoped, and every one
 * of those types is used for many unrelated resources too (the fixture
 * itself has two `IfcMaterialProperties` on a plain `IfcMaterial`, which must
 * NOT be omitted), so adding them would omit every instance of that type
 * rather than only the ones that reference a withheld id. A real file
 * exercising one of those rare paths would still throw — a known,
 * documented residual, not a silent miss.)
 *
 * Do not add another type here without the same end-to-end guarantee: this
 * set is exactly as safe as the caller's `withheldRefIds` computation is
 * complete for it.
 */
export const WITHHOLDABLE_UNROOTED_TYPES: ReadonlySet<string> = new Set([
  'IFCSTRUCTURALLOADCONFIGURATION',
  'IFCMATERIALPROFILE',
  'IFCMATERIALPROFILESET',
  'IFCMATERIALPROFILESETUSAGE',
  'IFCMATERIALPROFILESETUSAGETAPERING',
  'IFCMATERIALPROFILEWITHOFFSETS',
]);

/**
 * Every express id, across `WITHHOLDABLE_UNROOTED_TYPES`, that an export
 * targeting `toSchema` will omit — computed once per export and threaded
 * through `convertStepLine` as `withheldRefIds` so a referencing record can
 * be redirected to the same fallback BEFORE it ships a now-dangling `#N`.
 * Empty (and free to compute) for any schema other than IFC2X3: nothing in
 * `WITHHOLDABLE_UNROOTED_TYPES` is currently unrepresented anywhere else.
 */
export function computeWithheldRefIds(
  dataStore: Pick<IfcDataStore, 'entityIndex'>,
  toSchema: IfcSchemaVersion,
): ReadonlySet<number> {
  if (toSchema !== 'IFC2X3') return EMPTY_ID_SET;
  const ids = new Set<number>();
  for (const type of WITHHOLDABLE_UNROOTED_TYPES) {
    for (const id of dataStore.entityIndex.byType.get(type) ?? []) ids.add(id);
  }
  return ids;
}

const EMPTY_ID_SET: ReadonlySet<number> = new Set();
