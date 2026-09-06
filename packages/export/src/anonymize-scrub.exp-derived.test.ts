/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `isNonRootNameExempt` (`anonymize-scrub.ts`) is a name-exemption: types it
 * matches are skipped by `pseudonymizeNonRootNames`'s sweep, so their
 * `Name`/`Description`/etc. stay legible. Three of its checks are
 * `startsWith` prefix tests standing in for "is a subtype of X":
 *
 *   - `startsWith('IFCPROPERTY')` (+ the explicit `IFCCOMPLEXPROPERTY`
 *     exact match added for #4042) for `IfcProperty`
 *   - `startsWith('IFCPHYSICAL')`  for `IfcPhysicalQuantity`
 *   - `startsWith('IFCQUANTITY')`  for `IfcPhysicalSimpleQuantity`
 *
 * #4042: `startsWith('IFCPROPERTY')` alone missed `IfcComplexProperty`, a
 * direct `IfcProperty` subtype whose own name doesn't start with
 * `IFCPROPERTY` — an over-scrub (the exemption should have applied and
 * didn't), not a leak. This test imports the REAL `isNonRootNameExempt` (not
 * a copy) and re-derives, directly from the EXPRESS schemas
 * (`packages/codegen/schemas/IFC4_ADD2_TC1.exp` and `IFC4X3.exp`), every
 * entity that is a proper subtype of `IfcProperty`, `IfcPhysicalQuantity`,
 * or `IfcPhysicalSimpleQuantity`, then asserts the code's answer against the
 * schema's in both directions (missing exemption, AND newly over-admitting
 * something that isn't in this family) for every non-root entity in both
 * schemas — so a future schema change, or a careless fix that widens the
 * new `IFCCOMPLEXPROPERTY` check back into a prefix, fails here instead of
 * silently mis-scrubbing again.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isNonRootNameExempt } from './anonymize-scrub.js';
import { IFC_ROOT_TYPES } from './subset-roots.js';

const SCHEMA_FILES = ['IFC4_ADD2_TC1.exp', 'IFC4X3.exp'] as const;

// Vitest runs with `packages/export` as the working directory.
const SCHEMA_DIR = resolve(process.cwd(), '../codegen/schemas');

function schemaText(name: string): string {
  return readFileSync(resolve(SCHEMA_DIR, name), 'utf8');
}

/** Split the schema into one text block per `ENTITY <Name> … END_ENTITY;`
 *  declaration, so each entity's own (possibly absent) `SUBTYPE OF` clause
 *  is the only thing a per-entity regex can see. */
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

function parseAllEntityNames(text: string): string[] {
  return [...splitEntityBlocks(text).keys()];
}

/** Entities declared `ABSTRACT SUPERTYPE` never appear as a real STEP
 *  record's own type name (a file instantiates one of their concrete
 *  subtypes instead) — e.g. `IfcSimpleProperty` is itself a direct
 *  `IfcProperty` subtype, abstract, with every one of ITS subtypes already
 *  starting `IFCPROPERTY`. No real entity is ever literally typed
 *  `IFCSIMPLEPROPERTY`, so the predicate under test correctly never needs
 *  to answer for it either way; excluded here the same way the reference
 *  `is-non-rooted-classifiable-resource.exp-derived.test.ts` excludes an
 *  ancestor matching itself. */
function parseAbstractEntityNames(text: string): Set<string> {
  const out = new Set<string>();
  for (const [name, block] of splitEntityBlocks(text)) {
    if (/\bABSTRACT\s+SUPERTYPE\b/.test(block)) out.add(name);
  }
  return out;
}

/** Is `name` a PROPER descendant of `ancestor` (never `name === ancestor`)? */
function isDescendantOf(
  parents: Map<string, string>,
  name: string,
  ancestor: string,
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

/** The schema's answer: is `name` a proper subtype of `IfcProperty`,
 *  `IfcPhysicalQuantity`, or `IfcPhysicalSimpleQuantity`? */
function schemaSaysExempt(parents: Map<string, string>, name: string): boolean {
  return (
    isDescendantOf(parents, name, 'IFCPROPERTY') ||
    isDescendantOf(parents, name, 'IFCPHYSICALQUANTITY') ||
    isDescendantOf(parents, name, 'IFCPHYSICALSIMPLEQUANTITY')
  );
}

describe('isNonRootNameExempt vs the EXPRESS schemas', () => {
  const perSchema = SCHEMA_FILES.map((file) => {
    const text = schemaText(file);
    return {
      file,
      parents: parseEntityParents(text),
      names: parseAllEntityNames(text),
      abstractNames: parseAbstractEntityNames(text),
    };
  });

  it('reaches the schemas and finds the families this predicate is about', () => {
    // Anti-vacuity: a silent parse failure would make the sweep below
    // iterate zero entities and trivially pass.
    for (const { file, parents, names, abstractNames } of perSchema) {
      expect(names.length, `${file}: no ENTITY declarations parsed`).toBeGreaterThan(500);
      expect(abstractNames.has('IFCSIMPLEPROPERTY'), `${file}: IfcSimpleProperty should parse as ABSTRACT`).toBe(true);
      expect(
        isDescendantOf(parents, 'IFCCOMPLEXPROPERTY', 'IFCPROPERTY'),
        `${file}: IfcComplexProperty should chain to IfcProperty`,
      ).toBe(true);
      expect(
        isDescendantOf(parents, 'IFCQUANTITYLENGTH', 'IFCPHYSICALQUANTITY'),
        `${file}: IfcQuantityLength should chain to IfcPhysicalQuantity`,
      ).toBe(true);
    }
  });

  it('exempts every non-root IfcProperty/IfcPhysicalQuantity subtype in both IFC4 and IFC4X3', () => {
    // Restricted to non-`IFC_ROOT_TYPES` entities: `pseudonymizeNonRootNames`
    // only ever consults `isNonRootNameExempt` after `IFC_ROOT_TYPES.has`
    // already came back `false` (`slotsFor`'s
    // `IFC_ROOT_TYPES.has(typeUpper) || isNonRootNameExempt(typeUpper)`), so
    // this predicate's answer for a ROOT type (e.g. `IfcPropertySet`, which
    // happens to start with `IFCPROPERTY` but is not an `IfcProperty`
    // subtype) is never actually consulted — asserting it here would just
    // be testing dead code, not the module's real behaviour. Also excludes
    // ABSTRACT entities: no real STEP record is ever literally typed as one.
    //
    // Only the under-exemption direction is checked here: `isNonRootNameExempt`
    // exempts several non-`IfcProperty` entities for reasons OUTSIDE this
    // family entirely (`IFCAPPLICATION`/`IFCPERSON`/`IFCORGANIZATION`/
    // `IFCPERSONANDORGANIZATION` are owner-history actors, not schema
    // subtypes of `IfcProperty`), and the pre-existing `startsWith('IFCPROPERTY')`
    // already over-admits a few `IfcPropertyAbstraction` siblings that are
    // NOT `IfcProperty` subtypes (`IfcPropertyEnumeration`,
    // `IfcPropertyDependencyRelationship`) — both out of scope for #4042,
    // which is specifically about `IfcComplexProperty` being MISSED. The
    // over-admission direction for the #4042 fix itself is covered by the
    // dedicated mutation-guard test below instead.
    const disagreements: string[] = [];
    for (const { file, parents, names, abstractNames } of perSchema) {
      for (const name of names) {
        if (abstractNames.has(name) || IFC_ROOT_TYPES.has(name)) continue;
        const expected = schemaSaysExempt(parents, name);
        const actual = isNonRootNameExempt(name);
        if (expected && !actual) {
          disagreements.push(`${file}: ${name} — schema says exempt, code says not exempt`);
        }
      }
    }
    expect(disagreements).toEqual([]);
  });

  it('exempts the specific entity #4042 found missing (regression pin)', () => {
    expect(isNonRootNameExempt('IFCCOMPLEXPROPERTY')).toBe(true);
  });

  it('does not widen the #4042 fix into a prefix that over-admits a sibling (mutation guard)', () => {
    // `IfcComplexPropertyTemplate` is a subtype of `IfcPropertyTemplate`
    // (itself IfcRoot-derived, not an `IfcProperty` subtype at all) — it
    // shares the `IfcComplexProperty*` textual prefix but is a different
    // entity family. A fix that generalized the exact `IFCCOMPLEXPROPERTY`
    // match back into `startsWith('IFCCOMPLEX')` would wrongly exempt it.
    expect(isNonRootNameExempt('IFCCOMPLEXPROPERTYTEMPLATE')).toBe(false);
  });
});
