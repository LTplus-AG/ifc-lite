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
import { ENTITIES_IFC2X3, ENTITIES_IFC4, ENTITIES_IFC4X3, type IfcEntityInfo } from '@ifc-lite/data';
import { convertStepLine, type IfcSchemaVersion } from './schema-converter.js';

function table(entities: readonly IfcEntityInfo[]): Map<string, readonly string[]> {
  const m = new Map<string, readonly string[]>();
  for (const e of entities) m.set(e.name.toUpperCase(), e.attributes);
  return m;
}

const TABLES: Record<string, Map<string, readonly string[]>> = {
  IFC2X3: table(ENTITIES_IFC2X3),
  IFC4: table(ENTITIES_IFC4),
  IFC4X3: table(ENTITIES_IFC4X3),
};

/** True when `short` is a strict prefix of `long` by attribute NAME. */
function isStrictPrefix(short: readonly string[], long: readonly string[]): boolean {
  return short.length < long.length && short.every((n, i) => n === long[i]);
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
  return !out.startsWith(`#1=${type}(`);
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
    if (isStrictPrefix(tgtAttrs, srcAttrs)) shrinks.push([type, srcAttrs.length, tgtAttrs.length]);
    else notPrefix.push([type, srcAttrs.length, tgtAttrs.length]);
  }

  it('has a non-empty derived corpus in both directions (anti-vacuity)', () => {
    expect(shrinks.length).toBeGreaterThan(4);
    expect(notPrefix.length).toBeGreaterThan(0);
  });

  it('trims every entity whose target form is a strict prefix of the source form', () => {
    const wrong = shrinks
      .map(([type, srcN, tgtN]) => {
        const got = argCount(convertStepLine(makeLine(type, srcN), from, to));
        return got === tgtN ? null : `${type}: expected ${tgtN} args, got ${got}`;
      })
      .filter((x): x is string => x !== null);
    expect(wrong).toEqual([]);
  });

  it('never trims an entity whose attributes were inserted mid-list, not appended', () => {
    const wrong = notPrefix
      .map(([type, srcN]) => {
        const got = argCount(convertStepLine(makeLine(type, srcN), from, to));
        return got === srcN ? null : `${type}: expected ${srcN} args untouched, got ${got}`;
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
      const got = argCount(convertStepLine(makeLine(type, srcAttrs.length), from, to));
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

  it('IFC4 IfcApproval is left alone — IFC2X3 inserted its extra attributes mid-list', () => {
    const line = "#9=IFCAPPROVAL('desc',$,'name',$,$,$,$,$,'id');";
    expect(convertStepLine(line, 'IFC4', 'IFC2X3')).toBe(line);
  });
});
