/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Attribute-list shrinkage is INDEPENDENT of schema rank: a newer schema can
 * REMOVE attributes an older one had. `convertStepLine` gated its trim on the
 * rank comparison (`schemaRank(to) < schemaRank(from)`) instead of on the prefix
 * relation, so on an UPGRADE the trim branch never ran and the padding branch
 * had nothing to do — the extra trailing arguments survived into a file whose
 * header declares the newer schema.
 *
 * Derived from the generated buildingSMART tables, 10 entities have an IFC4
 * attribute list that is a strict prefix of their IFC2X3 one, and 4 more for
 * IFC4 → IFC4X3. `IFCRELDECOMPOSES` was written with 6 arguments into an IFC4
 * file where the entity takes 4.
 *
 * These tests parameterise over ALL SIX ordered schema pairs, not just the
 * downgrades, because the guarantee under test is precisely that the trim keys
 * on the prefix relation and not on the direction of travel.
 */

import { describe, it, expect } from 'vitest';
import { getSchemaRegistryForVersion, type SchemaVersionWithRegistry } from '@ifc-lite/parser';
import { convertStepLine, type IfcSchemaVersion } from './schema-converter.js';

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
  const out = convertStepLine(makeLine(type, 1), from, to)!;
  return !out.startsWith(`#1=${type}(`);
}

/**
 * Entities that MUST appear in each pair's shrink corpus. A bare
 * `length > 0` floor is the honest anti-vacuity check, but it would go on
 * passing if a schema regeneration quietly dropped the very entities this fix
 * exists for. Naming them fails loudly, and with a readable message, rather
 * than relying on a magic count that also reds on any benign corpus growth.
 */
const REQUIRED_SHRINKS: Partial<Record<string, readonly string[]>> = {
  'IFC2X3>IFC4': ['IFCRELDECOMPOSES', 'IFCDISTRIBUTIONCONTROLELEMENT', 'IFCLSHAPEPROFILEDEF'],
  'IFC2X3>IFC4X3': ['IFCRELDECOMPOSES', 'IFCDISTRIBUTIONCONTROLELEMENT', 'IFCLSHAPEPROFILEDEF'],
  // IFCREFERENT is NOT in this corpus: it has no IFC4 representation at all
  // (issue #5204 — it only ever appeared to, via the wrong buildingSMART-C#-
  // derived table), so an EXPRESS-ground-truthed `src` table has no IFC4
  // entry for it and it cannot enter the "shrinks" corpus. See the
  // `IFCREFERENT`/`IFCLINEARPOSITIONINGELEMENT`/`IFCPOSITIONINGELEMENT`
  // rename-map pin in `schema-converter-ifc4-entity-table.test.ts` for its
  // real behaviour (it becomes IFCPROXY, like the other three protected
  // entities).
  'IFC4>IFC4X3': ['IFCCOORDINATEREFERENCESYSTEM'],
  'IFC4>IFC2X3': ['IFCMATERIAL', 'IFCWALLSTANDARDCASE'],
  'IFC4X3>IFC4': ['IFCANNOTATION'],
  'IFC4X3>IFC2X3': ['IFCMATERIAL'],
};

describe.each([
  ['IFC2X3', 'IFC4'],
  ['IFC2X3', 'IFC4X3'],
  ['IFC4', 'IFC4X3'],
  ['IFC4', 'IFC2X3'],
  ['IFC4X3', 'IFC4'],
  ['IFC4X3', 'IFC2X3'],
] as const)('convertStepLine trims by prefix, not by rank: %s → %s', (from, to) => {
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

  it('has a non-empty derived corpus on both sides of the rule (anti-vacuity)', () => {
    expect(shrinks.length).toBeGreaterThan(0);
    // IFC4 → IFC4X3 is the one pair with no real mid-list-insertion shrink:
    // against the EXPRESS-derived tables (not the buggy `ENTITIES_IFC4` this
    // file used before #5204 — that table spuriously matched several
    // IFC4X3-only entities against themselves here, manufacturing a
    // non-empty `notPrefix` corpus for a category that is actually empty),
    // every entity IFC4X3 shortened from its IFC4 form did so by a strict
    // trailing drop. The other five pairs keep the `toBeGreaterThan(0)` floor.
    if (`${from}>${to}` === 'IFC4>IFC4X3') {
      expect(notPrefix.length).toBe(0);
    } else {
      expect(notPrefix.length).toBeGreaterThan(0);
    }
    const names = new Set(shrinks.map(([t]) => t));
    const missing = (REQUIRED_SHRINKS[`${from}>${to}`] ?? []).filter((t) => !names.has(t));
    expect(missing).toEqual([]);
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

  it('never trims an entity whose attributes were inserted mid-list, not appended', () => {
    const wrong = notPrefix
      .map(([type, srcN]) => {
        const got = argCount(convertStepLine(makeLine(type, srcN), from, to)!);
        return got === srcN ? null : `${type}: expected ${srcN} args untouched, got ${got}`;
      })
      .filter((x): x is string => x !== null);
    expect(wrong).toEqual([]);
  });

  it('pads every entity whose source form is a strict prefix of the target form', () => {
    const wrong: string[] = [];
    for (const [type, tgtAttrs] of tgt) {
      const srcAttrs = src.get(type);
      if (!srcAttrs || srcAttrs.length === 0 || !isStrictPrefix(srcAttrs, tgtAttrs)) continue;
      if (isDivertedByConversion(type, from, to)) continue;
      const got = argCount(convertStepLine(makeLine(type, srcAttrs.length), from, to)!);
      if (got !== tgtAttrs.length) wrong.push(`${type}: expected ${tgtAttrs.length} args, got ${got}`);
    }
    expect(wrong).toEqual([]);
  });

  it('leaves same-length entities alone in either direction', () => {
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

describe('the trim and the pad cannot both fire on one entity', () => {
  it('holds by construction: a strict prefix is strictly shorter, both ways is impossible', () => {
    const both: string[] = [];
    for (const [from, to] of [
      ['IFC2X3', 'IFC4'],
      ['IFC4', 'IFC2X3'],
      ['IFC2X3', 'IFC4X3'],
      ['IFC4X3', 'IFC2X3'],
      ['IFC4', 'IFC4X3'],
      ['IFC4X3', 'IFC4'],
    ] as const) {
      for (const [type, tgtAttrs] of TABLES[to]) {
        const srcAttrs = TABLES[from].get(type);
        if (!srcAttrs) continue;
        if (isStrictPrefix(tgtAttrs, srcAttrs) && isStrictPrefix(srcAttrs, tgtAttrs)) {
          both.push(`${from}→${to} ${type}`);
        }
      }
    }
    expect(both).toEqual([]);
  });
});

describe('upgrades that REMOVE attributes — worked examples', () => {
  it('IFC2X3 IfcRelDecomposes (6 attrs) drops the two IFC4 moved to its subtypes', () => {
    const line = "#1=IFCRELDECOMPOSES('g',$,'n','d',#2,(#3));";
    expect(convertStepLine(line, 'IFC2X3', 'IFC4')).toBe("#1=IFCRELDECOMPOSES('g',$,'n','d');");
  });

  it('IFC2X3 IfcDistributionControlElement drops the ControlElementId IFC4 removed', () => {
    const line = "#4=IFCDISTRIBUTIONCONTROLELEMENT('guid',$,'Sensor',$,$,#10,#11,'tag','ctrlid');";
    expect(convertStepLine(line, 'IFC2X3', 'IFC4')).toBe(
      "#4=IFCDISTRIBUTIONCONTROLELEMENT('guid',$,'Sensor',$,$,#10,#11,'tag');",
    );
  });

  it('IFC2X3 IfcLShapeProfileDef drops the two CentreOfGravity attrs IFC4 removed', () => {
    const line = '#5=IFCLSHAPEPROFILEDEF(.AREA.,\'L100x100\',#12,100.,100.,10.,5.,3.,0.,7.,8.);';
    expect(convertStepLine(line, 'IFC2X3', 'IFC4')).toBe(
      "#5=IFCLSHAPEPROFILEDEF(.AREA.,'L100x100',#12,100.,100.,10.,5.,3.,0.);",
    );
  });

  it('IFC4 IfcCoordinateReferenceSystem drops the VerticalDatum IFC4X3 removed', () => {
    // Not IfcReferent, the ORIGINAL worked example here: IfcReferent has no
    // IFC4 representation at all (#5204) — the pre-fix `schema-converter.ts`
    // only believed otherwise because it read the wrong entity table, so
    // this example exercised the bug, not the trim rule.
    const line = "#6=IFCCOORDINATEREFERENCESYSTEM('CRS','desc','Datum','VDatum');";
    expect(convertStepLine(line, 'IFC4', 'IFC4X3')).toBe(
      "#6=IFCCOORDINATEREFERENCESYSTEM('CRS','desc','Datum');",
    );
  });
});
