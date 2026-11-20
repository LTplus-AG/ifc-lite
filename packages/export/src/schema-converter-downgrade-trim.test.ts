/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The downgrade trim must be DERIVED from the generated buildingSMART entity
 * tables, not from a hand-maintained count list.
 *
 * `convertStepLine`'s UPGRADE path already pads from `ENTITIES_IFC*` under a
 * strict-attribute-name-prefix rule. Its DOWNGRADE path used a 30-entry hand
 * map instead, so 63 IFC4 entities whose IFC2X3 form is strictly shorter were
 * emitted with too many arguments — e.g. `IFCMATERIAL('Concrete',$,$)` in a file
 * declaring IFC2X3, where `IfcMaterial` takes exactly one argument.
 *
 * These tests derive both directions from the generated tables:
 *   - every prefix-safe shrink MUST be trimmed (no gaps);
 *   - every non-prefix (mid-list insertion) and every non-shrink MUST NOT be
 *     trimmed (no over-reach, which would shift values into the wrong slots).
 */

import { describe, it, expect } from 'vitest';
import { getSchemaRegistryForVersion, type SchemaVersionWithRegistry } from '@ifc-lite/parser';
import { convertStepLine, type IfcSchemaVersion } from './schema-converter.js';
import { downgradesMaterial } from './schema-converter-material-referent.js';
import { isStrictAttrPrefix } from './schema-converter-renames.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** The same-name types the shared fixture maps (#10763), read from the fixture, not from `attrMapFor`,
 *  so the oracle cannot share a dispatch defect. A map runs between IFC2X3 and IFC4/IFC4X3 only. */
const MAPPED: ReadonlySet<string> = new Set((JSON.parse(readFileSync(fileURLToPath(new URL('../../../rust/export/tests/fixtures/schema_attribute_maps.json', import.meta.url)), 'utf8')) as { maps: { ifc2x3: string; ifc4: string }[] }).maps
  .filter((m) => m.ifc2x3 === m.ifc4).map((m) => m.ifc2x3));
const ifc4Like = (s: IfcSchemaVersion) => s === 'IFC4' || s === 'IFC4X3';
const mapped = (type: string, from: IfcSchemaVersion, to: IfcSchemaVersion) =>
  MAPPED.has(type) && ((from === 'IFC2X3' && ifc4Like(to)) || (to === 'IFC2X3' && ifc4Like(from)));

// Derived from `@ifc-lite/parser`'s EXPRESS-derived schema registries —
// deliberately NOT from `@ifc-lite/data`'s `ENTITIES_IFC2X3`/`ENTITIES_IFC4`/
// `ENTITIES_IFC4X3`, which are generated from buildingSMART's vendored C#
// `SchemaInfo` source and (issue #5204) misfile several IFC4X3-only entities
// into their IFC4 section — an independently-wrong ground truth would make
// this file agree with `schema-converter.ts`'s bug instead of catching it.
function table(version: SchemaVersionWithRegistry): Map<string, readonly string[]> {
  const registry = getSchemaRegistryForVersion(version);
  const m = new Map<string, readonly string[]>();
  for (const [name, meta] of Object.entries(registry.entities)) {
    m.set(name.toUpperCase(), (meta.allAttributes ?? meta.attributes).map((a) => a.name));
  }
  return m;
}

const TABLES: Record<string, Map<string, readonly string[]>> = {
  IFC2X3: table('IFC2X3'),
  IFC4: table('IFC4'),
  IFC4X3: table('IFC4X3'),
};

/**
 * True when `short` is a strict prefix of `long` by attribute NAME, with the
 * in-place renames of `type` read as one name (#7739; the allowance table is
 * pinned on its own by schema-converter-renames.test.ts and the sweep fixture).
 */
function isStrictPrefix(short: readonly string[], long: readonly string[], type: string): boolean {
  return isStrictAttrPrefix(short, long, type);
}

/** Count top-level STEP arguments of `#1=TYPE(...)` (no nesting in our fixtures). */
function argCount(line: string): number {
  const body = line.match(/^#\d+=\w+\((.*)\);$/)?.[1] ?? '';
  return body.trim() === '' ? 0 : body.split(',').length;
}

/** A synthetic source line with `n` distinct `$` placeholders. */
function makeLine(type: string, n: number): string {
  return `#1=${type}(${Array.from({ length: n }, () => '$').join(',')});`;
}

/**
 * Types that keep their own dedicated conversion behaviour and so never reach
 * the generic trim: they are renamed to a different target type, or replaced by
 * an IFCPROXY placeholder.
 */
function isDivertedByConversion(type: string, from: IfcSchemaVersion, to: IfcSchemaVersion): boolean {
  const out = convertStepLine(makeLine(type, 1), from, to);
  // Only the IfcMaterialProperties a downgrade checks may go unwritten (#10763); any other null is a lost record.
  if (out === null && !(type === 'IFCMATERIALPROPERTIES' && downgradesMaterial(from, to))) throw new Error(`${from} -> ${to} wrote no ${type}`);
  return out === null || !out.startsWith(`#1=${type}(`);
}

describe.each([
  ['IFC4', 'IFC2X3'],
  ['IFC4X3', 'IFC2X3'],
  ['IFC4X3', 'IFC4'],
] as const)('convertStepLine downgrade trim %s → %s', (from, to) => {
  const src = TABLES[from];
  const tgt = TABLES[to];

  const shrinks: Array<[string, number, number]> = [];
  const notPrefix: Array<[string, number, number]> = [];
  for (const [type, tgtAttrs] of tgt) {
    const srcAttrs = src.get(type);
    if (!srcAttrs || srcAttrs.length <= tgtAttrs.length) continue;
    if (isDivertedByConversion(type, from, to)) continue;
    if (isStrictPrefix(tgtAttrs, srcAttrs, type)) shrinks.push([type, srcAttrs.length, tgtAttrs.length]);
    else notPrefix.push([type, srcAttrs.length, tgtAttrs.length]);
  }

  it('has a non-empty derived corpus in both directions (anti-vacuity)', () => {
    expect(shrinks.length).toBeGreaterThan(4);
    expect(notPrefix.length).toBeGreaterThan(0);
  });

  it('trims every entity whose target form is a strict prefix of the source form', () => {
    const wrong = shrinks
      .map(([type, srcN, tgtN]) => {
        const got = argCount(convertStepLine(makeLine(type, srcN), from, to)!);
        return got === tgtN ? null : `${type}: expected ${tgtN} args, got ${got}`;
      })
      .filter((x): x is string => x !== null);
    expect(wrong).toEqual([]);
  });

  // #10763: a type with a reviewed attribute map is written at the target's arity instead.
  it('never trims an entity whose attributes were inserted mid-list, unless an attribute map reconciles it', () => {
    const wrong = notPrefix
      // Reconciled by name instead (#9026 item 14), see schema-grid-frames.parity.test.ts.
      .filter(([type]) => type !== 'IFCGRIDPLACEMENT')
      .map(([type, srcN, tgtN]) => {
        const want = mapped(type, from, to) ? tgtN : srcN;
        const got = argCount(convertStepLine(makeLine(type, srcN), from, to)!);
        return got === want ? null : `${type}: expected ${want} args, got ${got}`;
      })
      .filter((x): x is string => x !== null);
    expect(wrong).toEqual([]);
  });

  // Only SAME-LENGTH entities. An entity whose source (newer-schema) list is
  // strictly SHORTER than the older target's is padded, not left alone — the
  // older schema really does take more arguments there (IFC2X3 IfcRelDecomposes
  // takes 6 against IFC4's 4), and emitting the short IFC4 form into a file
  // declaring IFC2X3 is the same defect this file exists for, mirrored. That
  // growth corpus is covered in `schema-converter-upgrade-trim.test.ts`.
  it('never trims an entity that is the same length in both schemas', () => {
    const wrong: string[] = [];
    for (const [type, tgtAttrs] of tgt) {
      const srcAttrs = src.get(type);
      if (!srcAttrs || srcAttrs.length === 0 || srcAttrs.length !== tgtAttrs.length) continue;
      if (isDivertedByConversion(type, from, to)) continue;
      const got = argCount(convertStepLine(makeLine(type, srcAttrs.length), from, to)!);
      if (got !== srcAttrs.length) wrong.push(`${type}: expected ${srcAttrs.length} args, got ${got}`);
    }
    expect(wrong).toEqual([]);
  });
});

describe('convertStepLine downgrade trim — worked examples', () => {
  it('IFC4 IfcMaterial (3 attrs) becomes the single-attribute IFC2X3 form', () => {
    const line = "#7=IFCMATERIAL('Concrete','C30/37 cast in situ',$);";
    expect(convertStepLine(line, 'IFC4', 'IFC2X3')).toBe("#7=IFCMATERIAL('Concrete');");
  });

  it('IFC4 IfcQuantityArea (5 attrs) drops the IFC4-only Formula', () => {
    const line = "#8=IFCQUANTITYAREA('NetArea',$,$,12.5,'FORMULA');";
    expect(convertStepLine(line, 'IFC4', 'IFC2X3')).toBe("#8=IFCQUANTITYAREA('NetArea',$,$,12.5);");
  });

  it('IFC4 IfcWallStandardCase drops PredefinedType, like IfcWall', () => {
    const line = "#5=IFCWALLSTANDARDCASE('guid',$,'Wall 1',$,$,$,$,'tag',.STANDARD.);";
    expect(convertStepLine(line, 'IFC4', 'IFC2X3')).toBe(
      "#5=IFCWALLSTANDARDCASE('guid',$,'Wall 1',$,$,$,$,'tag');",
    );
  });

  it('IFC4X3 IfcAnnotation drops the PredefinedType IFC4X3 appended', () => {
    const line = "#6=IFCANNOTATION('guid',$,'Note',$,$,$,$,.USERDEFINED.);";
    expect(convertStepLine(line, 'IFC4X3', 'IFC4')).toBe("#6=IFCANNOTATION('guid',$,'Note',$,$,$,$);");
  });

  it('IFC4 IfcApproval is reconciled by its attribute map, not trimmed (#10763)', () => {
    const line = "#9=IFCAPPROVAL('id','name','desc',$,$,$,$,$,$);";
    expect(convertStepLine(line, 'IFC4', 'IFC2X3')).toBe("#9=IFCAPPROVAL('desc',$,$,$,$,'name','id');");
  });
});
