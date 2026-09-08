/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `isNonRootedClassifiableResourceType` (classifications.ts) decides
 * whether an IFC entity type can be the `RelatedResourceObjects` target of
 * an `IfcExternalReferenceRelationship` — i.e. whether it is a subtype of
 * `IfcMaterialDefinition` or `IfcProfileDef`. Three predicates for this in
 * three days each used a string test (`startsWith`, `endsWith`,
 * `includes`) as a proxy for that schema fact, and each was wrong at a
 * different edge:
 *
 *   1. `startsWith('IFCMATERIAL')` admitted `IfcMaterialList`,
 *      `IfcMaterialLayerSetUsage`, `IfcMaterialDefinitionRepresentation`,
 *      `IfcMaterialRelationship` — none is `IfcMaterialDefinition`.
 *   2. `endsWith('PROFILEDEF')` missed `IfcArbitraryProfileDefWithVoids`,
 *      a genuine `IfcProfileDef` subtype whose name doesn't end that way.
 *   3. `includes('PROFILEDEF')` (the fix for #2) admitted
 *      `IfcRelAssociatesProfileDef`, a *rooted* relationship.
 *
 * This test re-derives the answer directly from the EXPRESS schemas
 * (`packages/codegen/schemas/IFC4_ADD2_TC1.exp` and `IFC4X3.exp`) by
 * walking each entity's `SUBTYPE OF` chain to the root, and asserts the
 * code's answer agrees with the schema's answer for every entity name in
 * both schemas. It is the thing meant to end the three-day cycle: it
 * fails whenever the code and the schema disagree, regardless of which
 * string test (if any) produced the code's answer.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { isNonRootedClassifiableResourceType } from './classifications.js';

const SCHEMA_FILES = ['IFC4_ADD2_TC1.exp', 'IFC4X3.exp'] as const;

// Vitest runs with `packages/ids` as the working directory. `import.meta.url`
// is not usable here: Vite serves the module under a `/@fs` prefix, so a URL
// relative to it resolves to a path that does not exist on disk.
const SCHEMA_DIR = resolve(process.cwd(), '../codegen/schemas');

function schemaText(name: string): string {
  return readFileSync(resolve(SCHEMA_DIR, name), 'utf8');
}

/**
 * Split the schema into one text block per `ENTITY <Name> … END_ENTITY;`
 * declaration. A root abstract type (`IfcRoot`, `IfcMaterialDefinition`,
 * `IfcProfileDef`, …) has an `ABSTRACT SUPERTYPE OF (ONEOF (…))` clause but
 * NO `SUBTYPE OF` clause of its own — scanning `SUBTYPE\s+OF\s+\(\w+\)`
 * across the whole file with a non-greedy `[\s\S]*?` would, for exactly
 * those entities, walk past their own (absent) clause and mis-attribute
 * the NEXT entity's `SUBTYPE OF` as if it were this one's, corrupting the
 * chain for everything in between. Splitting into per-entity blocks first
 * makes each entity's own (possibly absent) `SUBTYPE OF` clause the only
 * thing its regex can see.
 */
function splitEntityBlocks(text: string): Map<string, string> {
  const out = new Map<string, string>();
  const re = /^ENTITY\s+(\w+)\b/gm;
  const starts: Array<{ name: string; index: number }> = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    starts.push({ name: m[1]!.toUpperCase(), index: m.index });
  }
  for (let i = 0; i < starts.length; i++) {
    const end = i + 1 < starts.length ? starts[i + 1]!.index : text.length;
    out.set(starts[i]!.name, text.slice(starts[i]!.index, end));
  }
  return out;
}

/**
 * `SUBTYPE OF (<Parent>);` within a single entity's own block — the
 * EXPRESS spelling used throughout both schema files (verified against
 * `packages/codegen/src/express-parser.ts`'s own `SUBTYPE\s+OF\s+\((\w+)\)`
 * extraction). Root entities have no `SUBTYPE OF` clause and so get no
 * parent entry.
 */
function parseEntityParents(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const [name, block] of splitEntityBlocks(text)) {
    const m = /SUBTYPE\s+OF\s+\((\w+)\)/.exec(block);
    if (m) out.set(name, m[1]!.toUpperCase());
  }
  return out;
}

/** Every entity name declared in the schema (whether or not it has a parent). */
function parseAllEntityNames(text: string): string[] {
  return [...splitEntityBlocks(text).keys()];
}

/**
 * Is `name` a PROPER descendant of `ancestor` (never `name === ancestor`
 * itself)? `IfcMaterialDefinition` and `IfcProfileDef` are themselves
 * `ABSTRACT SUPERTYPE`s with no direct instances — no real IFC entity's
 * `EntityRef.type` is ever the literal string `"IFCMATERIALDEFINITION"` or
 * `"IFCPROFILEDEF"` — so the predicate under test correctly never matches
 * them, and this derivation must agree by excluding self-matches too.
 */
function isDescendantOf(
  parents: Map<string, string>,
  name: string,
  ancestor: string
): boolean {
  let cur: string | undefined = parents.get(name);
  const seen = new Set<string>([name]);
  while (cur && !seen.has(cur)) {
    if (cur === ancestor) return true;
    seen.add(cur);
    cur = parents.get(cur);
  }
  return false;
}

/** The schema's answer: is `name` a subtype of `IfcMaterialDefinition` or `IfcProfileDef`? */
function schemaSaysClassifiable(parents: Map<string, string>, name: string): boolean {
  return (
    isDescendantOf(parents, name, 'IFCMATERIALDEFINITION') ||
    isDescendantOf(parents, name, 'IFCPROFILEDEF')
  );
}

describe('isNonRootedClassifiableResourceType vs the EXPRESS schemas', () => {
  const perSchema = SCHEMA_FILES.map((file) => {
    const text = schemaText(file);
    return { file, parents: parseEntityParents(text), names: parseAllEntityNames(text) };
  });

  it('reaches the schemas and finds the families this predicate is about', () => {
    // Anti-vacuity: a silent parse failure (e.g. a regex that stops
    // matching after an .exp formatting change) would make the sweep
    // below iterate zero entities and trivially pass.
    for (const { file, parents, names } of perSchema) {
      expect(names.length, `${file}: no ENTITY declarations parsed`).toBeGreaterThan(500);
      expect(
        isDescendantOf(parents, 'IFCMATERIALCONSTITUENT', 'IFCMATERIALDEFINITION'),
        `${file}: IfcMaterialConstituent should chain to IfcMaterialDefinition`
      ).toBe(true);
      expect(
        isDescendantOf(parents, 'IFCRECTANGLEPROFILEDEF', 'IFCPROFILEDEF'),
        `${file}: IfcRectangleProfileDef should chain to IfcProfileDef`
      ).toBe(true);
    }
  });

  it('agrees with the schema for every entity in both IFC4 and IFC4X3', () => {
    const disagreements: string[] = [];
    for (const { file, parents, names } of perSchema) {
      for (const name of names) {
        const expected = schemaSaysClassifiable(parents, name);
        const actual = isNonRootedClassifiableResourceType(name);
        if (actual !== expected) {
          disagreements.push(`${file}: ${name} — schema says ${expected}, code says ${actual}`);
        }
      }
    }
    expect(disagreements).toEqual([]);
  });

  it('excludes the specific entities each historical bug wrongly admitted or missed', () => {
    // Bug 1 (startsWith('IFCMATERIAL')): these are NOT IfcMaterialDefinition.
    expect(isNonRootedClassifiableResourceType('IFCMATERIALLIST')).toBe(false);
    expect(isNonRootedClassifiableResourceType('IFCMATERIALLAYERSETUSAGE')).toBe(false);
    expect(isNonRootedClassifiableResourceType('IFCMATERIALDEFINITIONREPRESENTATION')).toBe(
      false
    );
    expect(isNonRootedClassifiableResourceType('IFCMATERIALRELATIONSHIP')).toBe(false);

    // Bug 2 (endsWith('PROFILEDEF')): this IS an IfcProfileDef subtype.
    expect(isNonRootedClassifiableResourceType('IFCARBITRARYPROFILEDEFWITHVOIDS')).toBe(true);

    // Bug 3 (includes('PROFILEDEF')): this is a rooted relationship, not a profile def.
    expect(isNonRootedClassifiableResourceType('IFCRELASSOCIATESPROFILEDEF')).toBe(false);

    // Sanity: an ordinary rooted element is never in scope for this pathway.
    expect(isNonRootedClassifiableResourceType('IFCWALL')).toBe(false);
  });
});
