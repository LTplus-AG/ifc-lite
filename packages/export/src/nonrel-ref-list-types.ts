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
 * lists only). This is a second, narrow, named enumeration of the classes
 * where a session deletion (`bim.store.removeEntity`, `@ifc-lite/mutations`'s
 * `store-editor.ts`) reaches the output as a dangling `#N` through a plain
 * LIST attribute rather than through a relationship, found by inspecting
 * IFC4/IFC4X3's `.exp` schemas for a non-`IFCREL*` `LIST`/`SET` OF an entity
 * type:
 *
 *  - `IfcCostItem.CostValues` / `.CostQuantities`
 *  - `IfcAppliedValue.Components`, and its one IFC4/IFC4X3 subtype,
 *    `IfcCostValue` — a `Components` list is authored on the record's own
 *    concrete type token (`IFCCOSTVALUE`), never on `IFCAPPLIEDVALUE`
 *    itself, since `IfcAppliedValue` has no other instantiable subtype in
 *    either schema.
 *  - `IfcPhysicalComplexQuantity.HasQuantities`
 *
 * `narrowNonRelPositionalRefLists` is purely SYNTACTIC — it does not know or
 * care which attribute position means what, only whether an attribute is a
 * bare `#N` (left alone) or a parenthesised list of them (narrowed) — so
 * adding a type here is the whole change: no new per-type attribute-index
 * table.
 */
export const NONREL_REF_LIST_TYPES: ReadonlySet<string> = new Set([
  'IFCCOSTITEM',
  'IFCAPPLIEDVALUE',
  'IFCCOSTVALUE',
  'IFCPHYSICALCOMPLEXQUANTITY',
]);
