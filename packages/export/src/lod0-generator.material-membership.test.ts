/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `lod0-generator.ts`'s `isMaterialDefinition` (used by `isCandidateElementType`
 * to exclude materials from LOD0 export) used to be
 * `typeUpper.startsWith('IFCMATERIAL')` — the exact same over-broad-prefix
 * bug fixed for `@ifc-lite/ids`'s `isNonRootedClassifiableResourceType`
 * (ifc-lite #3999, bug 1): it also excluded `IfcMaterialList`,
 * `IfcMaterialLayerSetUsage`, `IfcMaterialDefinitionRepresentation` and
 * `IfcMaterialRelationship`, none of which is an `IfcMaterialDefinition`.
 *
 * This test re-derives the schema's answer directly from the EXPRESS
 * schemas (same method as
 * `packages/ids/src/bridge/is-non-rooted-classifiable-resource.exp-derived.test.ts`)
 * and:
 *
 *   1. proves the NEW predicate (`isMaterialDefinition`, schema-hierarchy
 *      based) agrees with the schema for every entity in both IFC4 and
 *      IFC4X3;
 *   2. quotes every entity where the OLD predicate (`startsWith('IFCMATERIAL')`)
 *      disagreed with the schema, to show the new predicate is strictly more
 *      precise (narrows, never widens) rather than changing behavior at
 *      sites the old prefix got right;
 *   3. proves that narrowing is behavior-preserving for
 *      `isCandidateElementType`'s purpose: every entity the old predicate
 *      wrongly excluded (and the new one correctly admits) has no
 *      `ObjectPlacement` attribute, so `isCandidateElementType`'s caller in
 *      `generateLod0` drops it via the independent `findAttrIndex(...,
 *      'ObjectPlacement') === null` guard regardless of which predicate
 *      classified it as "not a material".
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isMaterialDefinition } from './lod0-generator.js';

const SCHEMA_FILES = ['IFC4_ADD2_TC1.exp', 'IFC4X3.exp'] as const;

// Vitest runs with `packages/export` as the working directory.
const SCHEMA_DIR = resolve(process.cwd(), '../codegen/schemas');

function schemaText(name: string): string {
  return readFileSync(resolve(SCHEMA_DIR, name), 'utf8');
}

/** See the identical helper in the `@ifc-lite/ids` exp-derived test for why blocks are split first. */
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

function parseEntityParents(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const [name, block] of splitEntityBlocks(text)) {
    const m = /SUBTYPE\s+OF\s+\((\w+)\)/.exec(block);
    if (m) out.set(name, m[1]!.toUpperCase());
  }
  return out;
}

/** Attribute names declared directly on this entity's own block (not inherited). */
function parseOwnAttributeNames(block: string): string[] {
  const bodyMatch = /ENTITY\s+\w+[\s\S]*?;\s*([\s\S]*?)(?:DERIVE|INVERSE|WHERE|END_ENTITY)/.exec(
    block
  );
  const body = bodyMatch ? bodyMatch[1]! : '';
  const names: string[] = [];
  const attrRe = /^\s*(\w+)\s*:/gm;
  let m: RegExpExecArray | null;
  while ((m = attrRe.exec(body)) !== null) {
    names.push(m[1]!);
  }
  return names;
}

function parseAllEntityNames(text: string): string[] {
  return [...splitEntityBlocks(text).keys()];
}

function isDescendantOf(parents: Map<string, string>, name: string, ancestor: string): boolean {
  let cur: string | undefined = parents.get(name);
  const seen = new Set<string>([name]);
  while (cur && !seen.has(cur)) {
    if (cur === ancestor) return true;
    seen.add(cur);
    cur = parents.get(cur);
  }
  return false;
}

describe('isMaterialDefinition vs the EXPRESS schemas', () => {
  const perSchema = SCHEMA_FILES.map((file) => {
    const text = schemaText(file);
    return {
      file,
      parents: parseEntityParents(text),
      names: parseAllEntityNames(text),
      blocks: splitEntityBlocks(text),
    };
  });

  it('reaches the schemas and finds IfcMaterialDefinition', () => {
    for (const { file, parents, names } of perSchema) {
      expect(names.length, `${file}: no ENTITY declarations parsed`).toBeGreaterThan(500);
      expect(
        isDescendantOf(parents, 'IFCMATERIALCONSTITUENT', 'IFCMATERIALDEFINITION'),
        `${file}: IfcMaterialConstituent should chain to IfcMaterialDefinition`
      ).toBe(true);
    }
  });

  it('agrees with the schema for every entity in both IFC4 and IFC4X3', () => {
    const disagreements: string[] = [];
    for (const { file, parents, names } of perSchema) {
      for (const name of names) {
        const expected = isDescendantOf(parents, name, 'IFCMATERIALDEFINITION');
        const actual = isMaterialDefinition(name);
        if (actual !== expected) {
          disagreements.push(`${file}: ${name} — schema says ${expected}, code says ${actual}`);
        }
      }
    }
    expect(disagreements).toEqual([]);
  });

  it('quotes every entity where the OLD startsWith(\'IFCMATERIAL\') predicate disagreed with the schema', () => {
    const oldPredicate = (typeUpper: string): boolean => typeUpper.startsWith('IFCMATERIAL');
    const disagreements: string[] = [];
    for (const { file, parents, names } of perSchema) {
      for (const name of names) {
        const expected = isDescendantOf(parents, name, 'IFCMATERIALDEFINITION');
        const oldAnswer = oldPredicate(name);
        if (oldAnswer !== expected) {
          disagreements.push(`${file}: ${name} — schema says ${expected}, OLD startsWith says ${oldAnswer}`);
        }
      }
    }
    // Anti-vacuity: bug 1 is real and reproducible against these schemas.
    expect(disagreements.length).toBeGreaterThan(0);
    // Every disagreement is the old predicate over-admitting (never under-admitting):
    // `startsWith('IFCMATERIAL')` can only ever say `true` for a name that
    // literally starts with that prefix, so every disagreement has
    // `schema says false` and old predicate `true`.
    for (const line of disagreements) {
      expect(line).toContain('schema says false');
      expect(line).toContain('OLD startsWith says true');
    }
    expect(disagreements.length, JSON.stringify(disagreements, null, 2)).toBeGreaterThan(0);
    // eslint-disable-next-line no-console
    console.log(`OLD-vs-schema disagreements (${disagreements.length}):\n${disagreements.join('\n')}`);
  });

  it('every entity the OLD predicate wrongly excluded has no own-or-inherited ObjectPlacement, so isCandidateElementType\'s ObjectPlacement guard drops it either way', () => {
    // "Wrongly excluded" = old predicate said `true` (exclude, not a
    // candidate element) but the schema says `false` (not actually an
    // IfcMaterialDefinition, so the NEW predicate says `false` too, i.e. the
    // new code no longer excludes it on this ground alone).
    for (const { file, parents, names, blocks } of perSchema) {
      for (const name of names) {
        const schemaSays = isDescendantOf(parents, name, 'IFCMATERIALDEFINITION');
        const oldSaysExclude = name.startsWith('IFCMATERIAL');
        if (!oldSaysExclude || schemaSays) continue; // not one of the old predicate's false positives

        // Walk the inheritance chain collecting every own attribute name.
        let cur: string | undefined = name;
        const seen = new Set<string>();
        let hasObjectPlacement = false;
        while (cur && !seen.has(cur)) {
          seen.add(cur);
          const block = blocks.get(cur);
          if (block && parseOwnAttributeNames(block).includes('ObjectPlacement')) {
            hasObjectPlacement = true;
            break;
          }
          cur = parents.get(cur);
        }
        expect(
          hasObjectPlacement,
          `${file}: ${name} was excluded only by the old IFCMATERIAL prefix; ` +
            `expected it to have no ObjectPlacement attribute so isCandidateElementType's ` +
            `independent guard still drops it under the new, narrower predicate`
        ).toBe(false);
      }
    }
  });
});
