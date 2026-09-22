/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Non-`IFCREL*` classes whose OWN attributes hold direct entity-reference
 * LISTS, so `step-source-iteration.ts` runs
 * `narrowNonRelPositionalRefLists` (`nonrel-positional-ref-narrowing.ts`) on their
 * source line — a narrow-only sibling of the `filterHiddenRefsFromRelationshipLine`
 * rule already run on every `IFCREL*` line and on `STYLE_RESCUE_TYPES`
 * (`style-closure.ts`). Deliberately the sibling, not the shared function:
 * these classes also carry bare, inherited single-valued refs (`IfcRoot
 * .OwnerHistory`, `IfcAppliedValue.UnitBasis`) that the shared function's
 * bare-ref rule would withhold the whole line for — correct for an
 * `IFCREL*` association, wrong for an entity's own record (see
 * `narrowNonRelPositionalRefLists`'s doc for the full argument).
 *
 * `step-omission-predicates.ts` documents the filter's reach as "Only
 * `IFCREL*` lines" and gives `Representation`/`ObjectPlacement` as the
 * general exempt case (80 dangling refs before and after on
 * `tests/models/AB22.ifc`) — that stays true for every type NOT in this set,
 * and a BARE ref stays exempt even for a type IN this set (narrowing reaches
 * lists only).
 *
 * DERIVED, not hand-kept (#5181). Two rounds of hand-enumeration
 * (`IfcCostItem.CostValues`/`.CostQuantities`, `IfcAppliedValue`/
 * `IfcCostValue.Components`, `IfcPhysicalComplexQuantity.HasQuantities` —
 * the original four; `IfcPropertySet.HasProperties` and
 * `IfcElementQuantity.Quantities` — #5181's own gap) each missed a case, so
 * this is now computed at module load from `@ifc-lite/parser`'s
 * codegen-generated schema registries rather than copied by hand from the
 * `.exp` files: every CONCRETE, non-`IFCREL*` entity — across all three
 * registries `@ifc-lite/parser` carries (IFC2X3/IFC4/IFC4X3), since a class
 * can declare an attribute in one schema version and not another (the doc
 * on `IfcCostItem` in `nonrel-positional-ref-narrowing.ts` is the checked
 * example: no `CostValues`/`CostQuantities` at all in IFC2X3) — that has at
 * least one attribute, own or inherited, which is a SET or LIST (`isSet ||
 * isList`) whose `type` names another entity in that same registry. That is
 * exactly the shape `narrowNonRelPositionalRefLists` exists for: a direct
 * LIST attribute on a non-relationship class that names other entities,
 * reached by a session deletion (`bim.store.removeEntity`,
 * `@ifc-lite/mutations`'s `store-editor.ts`) the same way an `IFCREL*`
 * line's list attributes are.
 *
 * `@ifc-lite/parser`'s runtime schema registries are already an existing
 * runtime dependency of this package (`declared-property-type.ts` imports
 * `SCHEMA_REGISTRY` directly, and `nonrel-positional-ref-narrowing.ts`
 * already calls `getSchemaRegistryForVersion` for all three versions at
 * narrowing time) — deriving this set from them adds no new dependency
 * surface, so there is no perf/layering reason to fall back to a hand-kept
 * set plus a drift test here.
 *
 * `narrowNonRelPositionalRefLists` is purely SYNTACTIC — it does not know or
 * care which attribute position means what, only whether an attribute is a
 * bare `#N` (left alone) or a parenthesised list of them (narrowed) — so a
 * type appearing in the derived set is the whole change needed to cover it:
 * no new per-type attribute-index table.
 *
 * LOWER BOUND, NOT JUST "IS AN AGGREGATE OF ENTITIES". A first pass at this
 * derivation checked only `isSet || isList` plus an entity `type` and
 * produced 270 types — every non-`IFCREL*` concrete class with ANY
 * entity-reference aggregate, including geometry shapes such as
 * `IfcPolyline.Points` (`SET [2:?]`) and `IfcPolyLoop.Polygon`
 * (`SET [3:?]`). `narrowNonRelPositionalRefLists`'s own doc states the
 * premise its "still non-empty: narrowing alone cannot violate a `[1:?]`
 * lower bound" branch depends on: a lower bound of exactly 1 (or 0). Those
 * two examples have a lower bound of 2 and 3 — deleting one member of a
 * two-point `IfcPolyline` would narrow a valid 2-point line to an INVALID
 * 1-point one, silently, which is a worse defect than the dangling ref this
 * file exists to remove. So the derivation below additionally requires
 * `arrayBounds[0] <= 1`, matching the narrowing function's actual
 * guarantee. A future attribute this excludes for having a higher lower
 * bound needs a different fix in `narrowNonRelPositionalRefLists` itself
 * (falling back to "leave the slot untouched" once narrowing would drop
 * below the bound, the same way the mandatory-all-excluded case already
 * does) before it could safely join this set.
 *
 * ONE MORE EXCLUSION: every `IfcTypeObject` subtype (`IfcWallType`,
 * `IfcDoorStyle`, …) is skipped ENTIRELY, not just at its
 * `HasPropertySets` attribute. `HasPropertySets` — `SET [1:?] OF
 * IfcPropertySetDefinition` — already has a DEDICATED, tested owner:
 * `type-owned-psets.ts`'s `HAS_PROPERTY_SETS_SLOT` plus
 * `anonymize-scrub.ts`'s `keepPropertySets` option, which writes this exact
 * slot BEFORE `StepExporter` runs. `keepPropertySets: true`'s documented
 * contract is to preserve the ORIGINAL list verbatim, dangling ref and all
 * (`anonymize-scrub.test.ts`, "keeps the original HasPropertySets list").
 * A first version of this derivation tried excluding only the
 * `HasPropertySets` attribute by name — and still broke that contract,
 * because `IfcWallType` (through `IfcTypeProduct`) ALSO carries
 * `RepresentationMaps : SET [1:?] OF IfcRepresentationMap`, which
 * legitimately qualifies on its own. `narrowNonRelPositionalRefLists` reads
 * and rewrites a source line's slots as a whole (`readStepSlots` over every
 * parenthesised attribute), with no per-slot exemption mechanism — once a
 * line is in scope for ANY slot, EVERY slot on it is narrowed, including
 * `HasPropertySets`. So the only choice that actually keeps
 * `keepPropertySets`'s contract is to exclude the whole `IfcTypeObject`
 * family from this set, trading away narrowing's reach onto
 * `RepresentationMaps` (a pre-existing gap this change does not close,
 * not a regression) for correctness on the slot that already has an owner.
 */
import { getSchemaRegistryForVersion, type SchemaVersionWithRegistry } from '@ifc-lite/parser';

const REGISTRY_VERSIONS: readonly SchemaVersionWithRegistry[] = ['IFC2X3', 'IFC4', 'IFC4X3'];

/**
 * Builds {@link NONREL_REF_LIST_TYPES} (STEP type tokens) and
 * {@link NONREL_REF_LIST_REGISTRY_NAMES} (STEP token -> the registry's own
 * PascalCase entity name, e.g. `IFCPROPERTYSET` -> `IfcPropertySet`) in one
 * pass over all three schema registries, so the two can never disagree with
 * each other about which classes are covered — the same defect shape as the
 * `NONREL_REF_LIST_TYPES`/`REGISTRY_ENTITY_NAME` pair this replaces, which
 * were two independently hand-kept four-entry tables tied 1:1 by convention
 * only.
 */
function deriveNonRelRefListEntities(): {
  types: ReadonlySet<string>;
  registryNames: ReadonlyMap<string, string>;
} {
  const types = new Set<string>();
  const registryNames = new Map<string, string>();

  for (const version of REGISTRY_VERSIONS) {
    const registry = getSchemaRegistryForVersion(version);
    for (const entity of Object.values(registry.entities)) {
      if (entity.isAbstract) continue;
      const upperName = entity.name.toUpperCase();
      if (upperName.startsWith('IFCREL')) continue;

      // See the module doc: `IfcTypeObject`'s `HasPropertySets` already has
      // a dedicated owner, and narrowing cannot exempt one slot on a line
      // it otherwise touches, so the whole subtype family is excluded.
      if (entity.inheritanceChain?.includes('IfcTypeObject') === true) continue;

      const attributes = entity.allAttributes ?? entity.attributes;
      const namesAnEntityAggregate = attributes.some(
        (attribute) =>
          (attribute.isSet || attribute.isList) &&
          Object.hasOwn(registry.entities, attribute.type) &&
          // See the module doc: narrowing only ever removes members, never
          // adds them, so it is only safe when the attribute's own lower
          // bound is 0 or 1 — a higher bound (e.g. `IfcPolyline.Points`,
          // `[2:?]`) can be narrowed below its own minimum cardinality.
          // No `arrayBounds` at all (should not happen for a `isSet`/
          // `isList` attribute the generator produced, but not guaranteed
          // by the type) is treated as unsafe, not as bound-1: `Infinity`
          // fails the `<= 1` test below rather than passing by default.
          (attribute.arrayBounds?.[0] ?? Infinity) <= 1,
      );
      if (!namesAnEntityAggregate) continue;

      types.add(upperName);
      registryNames.set(upperName, entity.name);
    }
  }

  return { types, registryNames };
}

const DERIVED = deriveNonRelRefListEntities();

/** See the module doc: derived, not hand-kept, from the schema registries. */
export const NONREL_REF_LIST_TYPES: ReadonlySet<string> = DERIVED.types;

/**
 * `effectiveRelType` (the STEP type token, e.g. `IFCPROPERTYSET`) to the
 * exact PascalCase key the generated schema registries use
 * (`IfcPropertySet`), for every type in {@link NONREL_REF_LIST_TYPES} —
 * consumed by `nonrel-positional-ref-narrowing.ts` to read
 * `allAttributes[slotIndex]` back out of the version-correct registry.
 * Derived alongside `NONREL_REF_LIST_TYPES` from the exact same registry
 * entities, so the two sets can never drift apart.
 */
export const NONREL_REF_LIST_REGISTRY_NAMES: ReadonlyMap<string, string> = DERIVED.registryNames;
