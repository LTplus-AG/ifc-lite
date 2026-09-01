/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Attribute-list reconciliation for a genuine cross-schema entity RENAME
 * whose lists fail `schema-converter.ts`'s strict-prefix test (neither list
 * is a positional prefix of the other). Split out to stay under
 * `schema-converter.ts`'s line budget (`scripts/module-size-allowlist.txt`).
 */

/** Split a raw STEP attribute list into its top-level (comma-separated)
 *  value strings, respecting nested parentheses and single-quoted strings.
 *  Mirrors `schema-converter.ts`'s `trimAttributes` scanner but returns
 *  every value instead of stopping at a budget. Empty list → []. */
export function splitTopLevelAttributes(attrsRaw: string): string[] {
  if (!attrsRaw.trim()) return [];
  const attrs: string[] = [];
  let depth = 0;
  let inString = false;
  let current = '';
  for (let i = 0; i < attrsRaw.length; i++) {
    const ch = attrsRaw[i];
    if (ch === "'" && !inString) {
      inString = true;
      current += ch;
    } else if (ch === "'" && inString) {
      if (i + 1 < attrsRaw.length && attrsRaw[i + 1] === "'") {
        current += "''";
        i++;
        continue;
      }
      inString = false;
      current += ch;
    } else if (inString) {
      current += ch;
    } else if (ch === '(') {
      depth++;
      current += ch;
    } else if (ch === ')') {
      depth--;
      current += ch;
    } else if (ch === ',' && depth === 0) {
      attrs.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  attrs.push(current);
  return attrs;
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
