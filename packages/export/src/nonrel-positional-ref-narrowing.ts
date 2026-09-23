/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The `NONREL_REF_LIST_TYPES` (`nonrel-ref-list-types.ts`) sibling of
 * `filterHiddenRefsFromRelationshipLine` (`reference-collector.ts`): narrows
 * a parenthesised list attribute exactly as that function does, but NEVER
 * withholds the line.
 *
 * Split into its own file rather than added to `reference-collector.ts`:
 * that module already documents itself as sitting at its module-size budget
 * (`style-closure.ts`'s header says so, and this addition measured 968 lines
 * pushed to 1054 against a 976 budget — over it), and this function shares
 * no state with anything else there, only two already-exported helpers.
 *
 * A separate function, not a parameter on the shared one, because the two
 * rules disagree on what a bare excluded `#N` means, and that disagreement
 * cannot be papered over with a flag without also touching every existing
 * `IFCREL*`/`STYLE_RESCUE_TYPES` call site's contract:
 *
 * `filterHiddenRefsFromRelationshipLine` withholds the WHOLE line when a
 * bare, single-valued attribute names an excluded id, because for an
 * `IFCREL*` line that IS the association — `IfcRelContainedInSpatialStructure
 * .RelatingStructure` naming a hidden storey has no other spelling for "this
 * relationship no longer applies", so the relationship itself must go. The
 * classes in `NONREL_REF_LIST_TYPES` are not relationships: `IfcCostItem`'s
 * bare `OwnerHistory` (`IfcRoot`) or `IfcAppliedValue`'s bare `UnitBasis` are
 * ordinary attributes of the entity's OWN record, not a link between two
 * OTHER records. Withholding `#N=IFCCOSTITEM(...)` over its OwnerHistory
 * having been deleted does not remove an association the way withholding a
 * relationship does — it deletes the cost item itself, and every OTHER
 * entity that names that cost item now dangles instead. That is worse than
 * the one dangling `#N` this function exists to remove, and a regression
 * against the untouched-line behaviour `upstream/main` already ships for
 * these types. So a bare excluded ref here is left exactly as `main` emits
 * it: unfiltered, exempt, the same as `Representation`/`ObjectPlacement`
 * (`step-omission-predicates.ts`'s documented general gap for
 * non-relationship lines) already is.
 *
 * ## An emptied list: `$`, unchanged, or `()` — and why not always the same one
 *
 * `filterHiddenRefsFromRelationshipLine`'s own doc already states the trap:
 * "a SET attribute of a real IFC schema is never empty, so an empty list is
 * not 'no forward reference', it is a second, different kind of invalid
 * file." An earlier revision of this function answered every emptied list
 * with `()` and reproduced exactly that invalid file. The right answer is
 * NOT uniform, because the types in `NONREL_REF_LIST_TYPES` do not all
 * declare their list attribute alike — two examples:
 *
 *  - `IfcCostItem.CostValues` / `.CostQuantities`, `IfcAppliedValue`/
 *    `IfcCostValue.Components` are all `OPTIONAL LIST [1:?]`
 *    (`IFC4_ADD2_TC1.exp`) — the schema HAS a spelling for "none of these":
 *    `$`, the same token every other omitted optional attribute already
 *    uses in this export.
 *  - `IfcPhysicalComplexQuantity.HasQuantities` is `SET [1:?]`, NOT
 *    `OPTIONAL` (`IFC4_ADD2_TC1.exp` AND `IFC2X3_TC1.exp` — checked both,
 *    identical). There is no valid spelling for "none left" at all: `()`
 *    breaks the `[1:?]` lower bound and `$` breaks "this attribute is
 *    mandatory", equally invalid. Withholding the whole record cascades the
 *    same way the bare-`OwnerHistory` case does. The only choice that harms
 *    nothing else is to leave the slot exactly as `upstream/main` already
 *    ships it: the excluded ref(s) stay, dangling — one dangling `#N`,
 *    which is the pre-existing, already-accepted defect class this file
 *    only narrows the REACH of, not a new invalid shape.
 *
 * `readAggregateSlot` below derives the optional/mandatory answer (and the
 * slot's own lower bound) from
 * the generated schema registry (`@ifc-lite/parser`'s
 * `getSchemaRegistryForVersion`, keyed by the SOURCE line's own schema
 * version) rather than a fourth hand-written table — the exact defect shape
 * flagged separately (a hand-maintained table silently diverging from the
 * schema it was copied from). `IfcCostItem` in particular is NOT the same
 * shape across schema versions: IFC2X3's `IfcCostItem` declares neither
 * `CostValues` nor `CostQuantities` at all (`IFC2X3_TC1.exp` — the entity is
 * `SUBTYPE OF (IfcControl)` with zero own attributes), so a lookup keyed to
 * the wrong version would answer about attributes that line does not have.
 * Reading `allAttributes[slotIndex]` from the version-correct registry
 * answers both "is this slot even an aggregate" and "is it optional" from
 * one source, so a schema evolution changing either can never desync the two
 * questions the way two separately hand-kept facts could.
 *
 * Returns the line unchanged when it names nothing excluded, or a rewritten
 * line otherwise. Never returns `null`: unlike the sibling function, there is
 * no shape this rule ever withholds a whole record for. A line whose
 * validated slot layout cannot be read is still returned unchanged rather
 * than withheld — nothing here can VERIFY it holds an excluded ref, so
 * altering it would be a guess, and the untouched-line behaviour for these
 * types is already the accepted default. Non-entity text is returned
 * unchanged, matching the sibling function.
 */
import { getSchemaRegistryForVersion, type SchemaVersionWithRegistry } from '@ifc-lite/parser';
import { readStepSlots, splitTopLevelListItems } from './step-argument-parser.js';
import { BARE_REF_RE } from './reference-collector.js';
import { NONREL_REF_LIST_REGISTRY_NAMES } from './nonrel-ref-list-types.js';
import type { IfcSchemaVersion } from './schema-converter.js';

function isRegistryVersion(version: IfcSchemaVersion): version is SchemaVersionWithRegistry {
  return version === 'IFC2X3' || version === 'IFC4' || version === 'IFC4X3';
}

/**
 * The declaration of the aggregate attribute at `slotIndex` of `entityType`,
 * as `schemaVersion`'s generated registry declares it: whether it is
 * `OPTIONAL`, and its lower bound.
 *
 * Returns `undefined` when the metadata cannot be read (an entity/schema
 * version this file does not cover, a slot index the registry has no
 * attribute for, a slot that is not an aggregate at all, or an aggregate
 * with no declared bound) so the caller falls back to the SAFE default —
 * leave the slot untouched — rather than guess. `IFC5` (this export's
 * schema-conversion target enum, never a source-iteration STEP schema) and
 * any future addition to `IfcSchemaVersion` outside
 * {@link SchemaVersionWithRegistry} take this path automatically, by
 * construction, with no version list to keep in sync here.
 *
 * Read PER SLOT because a type joins `NONREL_REF_LIST_TYPES` on the strength
 * of ONE qualifying attribute, while this function rewrites every
 * parenthesised slot on the line. `IfcTextureMap` qualifies through
 * `Maps : LIST [1:?]` but also carries `Vertices : LIST [3:?]`;
 * `IfcFillAreaStyleTiles` qualifies through `Tiles : SET [1:?]` but also
 * carries `TilingPattern : LIST [2:2]` (#5181). Narrowing those by the
 * `[1:?]` rule would turn a valid 3-vertex map into an invalid 2-vertex one,
 * so each slot is held to its OWN declared lower bound.
 */
function readAggregateSlot(
  entityType: string,
  slotIndex: number,
  schemaVersion: IfcSchemaVersion,
): { optional: boolean; lowerBound: number } | undefined {
  const registryName = NONREL_REF_LIST_REGISTRY_NAMES.get(entityType);
  if (registryName === undefined || !isRegistryVersion(schemaVersion)) return undefined;
  const attr = getSchemaRegistryForVersion(schemaVersion).entities[registryName]?.allAttributes?.[slotIndex];
  if (attr === undefined || !(attr.isList || attr.isSet)) return undefined;
  const lowerBound = attr.arrayBounds?.[0];
  if (lowerBound === undefined || !Number.isFinite(lowerBound)) return undefined;
  return { optional: attr.optional, lowerBound };
}

export function narrowNonRelPositionalRefLists(
  line: string,
  isExcluded: (id: number) => boolean,
  entityType: string,
  schemaVersion: IfcSchemaVersion,
): string {
  const record = readStepSlots(line);
  if (record === null) return line;
  const attrs = [...record.slots];

  let changed = false;
  const nextAttrs: string[] = [];
  for (let index = 0; index < attrs.length; index++) {
    const rawAttr = attrs[index];
    const attr = rawAttr.trim();
    const leading = rawAttr.slice(0, rawAttr.indexOf(attr));
    const trailing = rawAttr.slice(rawAttr.indexOf(attr) + attr.length);
    if (attr.length >= 2 && attr.charCodeAt(0) === 0x28 /* '(' */ && attr.charCodeAt(attr.length - 1) === 0x29 /* ')' */) {
      const inner = attr.trim() === '()' ? '' : attr.slice(1, -1);
      const items = inner.trim() === '' ? [] : splitTopLevelListItems(inner);
      const survivors = items.filter((item) => {
        const refMatch = item.match(BARE_REF_RE);
        return !(refMatch && isExcluded(Number(refMatch[1])));
      });
      if (survivors.length === items.length) {
        // Nothing excluded in this list — untouched, whatever its cardinality.
        nextAttrs.push(rawAttr);
        continue;
      }
      const slot = readAggregateSlot(entityType, index, schemaVersion);
      if (slot === undefined) {
        // No declaration to check a narrowed list against — leave it exactly
        // as the source emitted it rather than guess its cardinality.
        nextAttrs.push(rawAttr);
        continue;
      }
      if (survivors.length > 0 && survivors.length >= slot.lowerBound) {
        // Still at or above this slot's own declared lower bound.
        changed = true;
        nextAttrs.push(`${leading}(${survivors.join(',')})${trailing}`);
        continue;
      }
      // Narrowing would break the slot's lower bound (every member excluded
      // from a `[1:?]` slot, or fewer than N left in an `[N:?]` one). `()`
      // or a short list is a different invalid file — see the module doc —
      // so the choice is `$` when nothing survives and the schema allows
      // omitting the attribute entirely, or otherwise leaving this slot
      // exactly as the source emitted it (dangling ref intact): `$` over a
      // list that still has survivors would drop live references too.
      if (survivors.length === 0 && slot.optional) {
        changed = true;
        nextAttrs.push(`${leading}$${trailing}`);
        continue;
      }
      nextAttrs.push(rawAttr);
      continue;
    }

    // A bare `#N` is left alone even when excluded — see the doc above for
    // why: narrowing reach only, never withholding, for these types.
    nextAttrs.push(rawAttr);
  }

  if (!changed) return line;
  return `${record.prefix}${nextAttrs.join(',')}${record.suffix}`;
}
