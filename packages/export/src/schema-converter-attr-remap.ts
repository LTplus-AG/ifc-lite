/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { splitTopLevelArgs } from './step-argument-parser.js';

/**
 * Attribute-list reconciliation for a genuine cross-schema entity RENAME
 * whose lists fail `schema-converter.ts`'s strict-prefix test (neither list
 * is a positional prefix of the other). Split out to stay under
 * `schema-converter.ts`'s line budget (`scripts/module-size-allowlist.txt`).
 */

/**
 * Split a raw STEP attribute list into its top-level (comma-separated)
 * value strings, respecting nested parentheses and single-quoted strings.
 * Empty list → [].
 *
 * A thin wrapper over `step-argument-parser.ts`'s `splitTopLevelArgs` — the
 * same package's general-purpose top-level-comma splitter, already used by
 * seven other read paths in this package (`retype.ts`, `reference-collector.ts`,
 * `merged-empty-containers.ts`, etc). This module used to carry its own
 * near-identical scan; kept here as `remapRenamedAttributesByName`'s only
 * caller expects, but no longer a fourth copy of the same rule
 * (LTplus-AG/ifc-lite#4125). `trimAttributes` in `schema-converter.ts` is
 * NOT folded in here: it stops early at a positional budget, which is a
 * genuinely different rule, not a copy of this one.
 *
 * `splitTopLevelArgs` behaves differently from the old local scanner in two
 * ways: it drops a trailing empty argument (`"a,"` → `['a']`) rather than
 * keeping it as `['a', '']`, and it trims each token
 * (`"a, b,c"` → `['a','b','c']` instead of `['a',' b','c']`). Both are safe
 * for `remapRenamedAttributesByName`'s real inputs: neither `IFCDOORTYPE`
 * nor `IFCWINDOWTYPE`'s fixed-arity attribute list has a trailing comma in
 * well-formed STEP, so the first difference never fires; and STEP has no
 * semantic significance to whitespace between top-level tokens, so a trimmed
 * token is the same value either way. Pinned by
 * `schema-converter-attr-remap.test.ts`.
 */
export function splitTopLevelAttributes(attrsRaw: string): string[] {
  return splitTopLevelArgs(attrsRaw);
}

/**
 * Renamed entity types whose attribute lists are safe to reconcile BY NAME
 * (`remapRenamedAttributesByName`) instead of leaving the line's attributes
 * untouched under the new type name.
 *
 * This is deliberately an allowlist, not "every rename that fails the
 * strict-prefix test": `convertStepLine`'s existing behaviour for a rename
 * whose lists aren't prefix-related is to leave the attributes alone
 * (`IFCBRIDGE` → `IFCBUILDING` is pinned exactly that way in
 * `schema-converter.test.ts`, since `IfcBuilding` predates the IFC4X3
 * facility types and the two attribute vocabularies mostly don't correspond
 * by name either — a by-name remap there would silently `$`-out most of an
 * `IfcBuilding` line). Only IFCDOORTYPE/IFCWINDOWTYPE → IFCDOORSTYLE/
 * IFCWINDOWSTYLE are added here: verified case by case (see the entry in
 * `IFC4_TO_IFC2X3` in `schema-converter.ts`) to share a genuine
 * IfcTypeProduct-derived attribute vocabulary with their IFC2X3 target,
 * where before this fix every door/window TYPE object fell through to
 * `resolveUnrepresentedEntity` and was replaced by an IFCPROXY with a
 * freshly minted GlobalId — losing the door/window's own identity, Name
 * and property-set associations even though IFC2X3 has a real (if
 * differently shaped) representation for it.
 */
export const BY_NAME_ATTR_REMAP_TYPES = new Set(['IFCDOORTYPE', 'IFCWINDOWTYPE']);

/**
 * Reconcile a renamed entity's attribute list by matching attribute NAMES
 * between the source and target schema tables, rather than by position.
 *
 * Only called for `BY_NAME_ATTR_REMAP_TYPES` members whose lists fail the
 * strict-prefix test in `schema-converter.ts` — e.g. IfcDoorType(IFC4) →
 * IfcDoorStyle(IFC2X3): both start with the same eight IfcTypeProduct
 * attributes, but IFC4 inserted `ElementType`/`PredefinedType` before its
 * own `OperationType`/`ParameterTakesPrecedence`, so neither list is a
 * prefix of the other.
 *
 * A target attribute with no same-named source attribute becomes `$`
 * (unknown) rather than a guess; a source attribute with no same-named
 * target slot is dropped. Both are honest data loss for attributes the
 * target schema's OWN shape does not carry under that name — never a
 * misplaced value.
 */
export function remapRenamedAttributesByName(
  attrsRaw: string,
  srcNames: readonly string[],
  tgtNames: readonly string[],
): string {
  const values = splitTopLevelAttributes(attrsRaw);
  const byName = new Map<string, string>();
  for (let i = 0; i < srcNames.length && i < values.length; i++) {
    byName.set(srcNames[i], values[i]);
  }
  return tgtNames.map((name) => byName.get(name) ?? '$').join(',');
}
