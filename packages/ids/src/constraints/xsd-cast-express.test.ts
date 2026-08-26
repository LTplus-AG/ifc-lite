/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Derives the IFC-measure → XSD-type expectation from the EXPRESS
 * schemas instead of hand-copying it, so the mapping in `xsd-cast.ts`
 * cannot silently drift from `TYPE <name> = <base>;`.
 *
 * `IfcTimeStamp` was mapped to `xs:duration` though it is `INTEGER` in
 * every schema — an IDS property facet on it could never pass. A
 * hand-written table cannot notice that; a re-derivation can.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ifcMeasureToXsdTypes } from './xsd-cast.js';

const SCHEMA_FILES = ['IFC4_ADD2_TC1.exp', 'IFC4X3.exp'] as const;

// Vitest runs with `packages/ids` as the working directory. `import.meta.url`
// is not usable here: Vite serves the module under a `/@fs` prefix, so a URL
// relative to it resolves to a path that does not exist on disk.
const SCHEMA_DIR = resolve(process.cwd(), '../codegen/schemas');

function schemaText(name: string): string {
  return readFileSync(resolve(SCHEMA_DIR, name), 'utf8');
}

/** `TYPE IfcFoo = REAL;` → `{ IFCFOO: 'REAL' }`, per schema file. */
function parseDefinedTypes(text: string): Map<string, string> {
  const out = new Map<string, string>();
  const re = /^\s*TYPE\s+(\w+)\s*=\s*([\s\S]*?);/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    out.set(m[1]!.toUpperCase(), m[2]!.trim().split(/\s+/)[0]!.toUpperCase());
  }
  return out;
}

/**
 * A defined type may be declared over another defined type —
 * `TYPE IfcPositiveInteger = IfcInteger;` — so follow the chain down to
 * the EXPRESS primitive. Bounded so a malformed schema cannot spin.
 */
function resolveBase(types: Map<string, string>, name: string): string | undefined {
  let base = types.get(name);
  for (let hops = 0; base !== undefined && types.has(base) && hops < 16; hops++) {
    base = types.get(base);
  }
  return base;
}

/** Members of `TYPE <sel> = SELECT (...);`, upper-cased. */
function selectMembers(text: string, sel: string): string[] {
  const m = new RegExp(`TYPE\\s+${sel}\\s*=\\s*SELECT\\s*\\(([\\s\\S]*?)\\)\\s*;`, 'i').exec(
    text
  );
  if (!m) return [];
  return m[1]!
    .split(',')
    .map((n) => n.trim().toUpperCase())
    .filter(Boolean);
}

/**
 * Measures whose XSD mapping is deliberately NOT the EXPRESS base:
 * IFC stores these as `STRING`, but their lexical space is ISO-8601 and
 * the IDS specification maps them to the corresponding XSD date types.
 */
const LEXICAL_OVERRIDES: Record<string, readonly string[]> = {
  IFCDATE: ['xs:date'],
  IFCDATETIME: ['xs:dateTime'],
  IFCDURATION: ['xs:duration'],
};

/**
 * `IfcCountMeasure` is `NUMBER` in IFC4 but `INTEGER` in IFC4X3, and the
 * mapping carries no schema version, so no single answer agrees with
 * both. It keeps the stricter `xs:integer`; this test does not police it.
 */
const SCHEMA_DIVERGENT = new Set(['IFCCOUNTMEASURE']);

/**
 * Measures whose no-version answer is deliberately a SUPERSET of what the
 * EXPRESS base alone implies.
 *
 * `TYPE IfcTimeStamp = INTEGER;` in every schema, so this sweep — which calls
 * `ifcMeasureToXsdTypes` with no schema version — would settle for
 * `xs:integer`. The mapper's versionless answer is the union across versions
 * instead, because the authoritative attribute table splits:
 * `IfcOwnerHistory.CreationDate` is `["xs:integer"]` under IFC2X3 and
 * `["xs:dateTime","xs:integer"]` under IFC4 and IFC4X3. A caller that cannot
 * say which schema it is reading should defer rather than reject a value some
 * schema allows.
 *
 * The per-version answers are NOT policed here — `xsd-cast-measure-map.test.ts`
 * pins each one against that table directly, which is the check that would
 * catch the union being handed back for IFC2X3.
 */
const SUPERSET_OVERRIDES: Record<string, readonly string[]> = {
  IFCTIMESTAMP: ['xs:integer', 'xs:dateTime'],
};

function expectedFor(name: string, base: string): readonly string[] | null {
  if (name in LEXICAL_OVERRIDES) return LEXICAL_OVERRIDES[name]!;
  if (name in SUPERSET_OVERRIDES) return SUPERSET_OVERRIDES[name]!;
  switch (base) {
    case 'INTEGER':
      return ['xs:integer'];
    case 'REAL':
    case 'NUMBER':
      return ['xs:double'];
    case 'BOOLEAN':
      return ['xs:boolean'];
    case 'LOGICAL':
      return ['xs:boolean', 'xs:string'];
    case 'STRING':
      return ['xs:string'];
    default:
      // SELECT / ENUMERATION / ARRAY / BINARY — not a scalar literal.
      return null;
  }
}

/**
 * The value space an IFC property can actually carry: the closure of the
 * `IfcValue` SELECT. A measure outside it is unreachable by the property
 * facet, so a mapping gap there would be inert.
 */
function reachableMeasures(): Map<string, string> {
  const out = new Map<string, string>();
  for (const file of SCHEMA_FILES) {
    const text = schemaText(file);
    const types = parseDefinedTypes(text);
    for (const sel of ['IfcMeasureValue', 'IfcSimpleValue', 'IfcDerivedMeasureValue']) {
      for (const member of selectMembers(text, sel)) {
        const base = resolveBase(types, member);
        if (base) out.set(member, base);
      }
    }
  }
  return out;
}

describe('ifcMeasureToXsdTypes vs the EXPRESS schemas', () => {
  const measures = reachableMeasures();

  it('reaches the schemas and derives the IfcValue closure', () => {
    // Anti-vacuity: a silent parse failure would make every assertion
    // below trivially true. Name what MUST be there, in each branch of
    // the SELECT, rather than trusting a count floor.
    for (const [name, base] of [
      ['IFCLENGTHMEASURE', 'REAL'], // IfcMeasureValue
      ['IFCDESCRIPTIVEMEASURE', 'STRING'], // IfcMeasureValue, non-numeric
      ['IFCINTEGER', 'INTEGER'], // IfcSimpleValue
      ['IFCTIMESTAMP', 'INTEGER'], // IfcSimpleValue, the #3250 shape
      ['IFCPARAMETERVALUE', 'REAL'], // IfcMeasureValue, no MEASURE suffix
      ['IFCPOSITIVEINTEGER', 'INTEGER'], // IfcSimpleValue, no suffix
      ['IFCINTEGERCOUNTRATEMEASURE', 'INTEGER'], // IfcDerivedMeasureValue
      ['IFCTHERMALTRANSMITTANCEMEASURE', 'REAL'], // IfcDerivedMeasureValue
    ] as const) {
      expect(measures.get(name), `${name} missing from derived closure`).toBe(base);
    }
  });

  it('maps every reachable scalar measure to the XSD types its EXPRESS base implies', () => {
    const disagreements: string[] = [];
    for (const [name, base] of [...measures].sort()) {
      if (SCHEMA_DIVERGENT.has(name)) continue;
      const expected = expectedFor(name, base);
      if (expected === null) continue;
      const actual = [...ifcMeasureToXsdTypes(name)];
      if (actual.length === 0) {
        disagreements.push(`${name} (EXPRESS ${base}): no cast gate at all`);
        continue;
      }
      if ([...actual].sort().join(',') !== [...expected].sort().join(',')) {
        disagreements.push(
          `${name} (EXPRESS ${base}): got [${actual}], expected [${expected}]`
        );
      }
    }
    expect(disagreements).toEqual([]);
  });

  it('the derivation can fail — a deliberately wrong mapping is caught', () => {
    // Negative control: the check above only means something if the
    // comparison it performs actually rejects a contradicting answer.
    expect(expectedFor('IFCDESCRIPTIVEMEASURE', 'STRING')).toEqual(['xs:string']);
    expect(expectedFor('IFCTIMESTAMP', 'INTEGER')).not.toEqual(['xs:duration']);
    expect(expectedFor('IFCINTEGERCOUNTRATEMEASURE', 'INTEGER')).not.toEqual(['xs:double']);
  });
});

describe('the corrected measures, through the cast gate', () => {
  it('accepts a descriptive text literal for IfcDescriptiveMeasure', () => {
    expect(ifcMeasureToXsdTypes('IFCDESCRIPTIVEMEASURE')).toEqual(['xs:string']);
  });

  it('rejects a decimal literal for IfcIntegerCountRateMeasure, accepts an integer', () => {
    expect(ifcMeasureToXsdTypes('IFCINTEGERCOUNTRATEMEASURE')).toEqual(['xs:integer']);
  });

  it('still gates the measures that were already correct', () => {
    expect(ifcMeasureToXsdTypes('IFCLENGTHMEASURE')).toEqual(['xs:double']);
    expect(ifcMeasureToXsdTypes('IFCBOOLEAN')).toEqual(['xs:boolean']);
    expect(ifcMeasureToXsdTypes('IFCLABEL')).toEqual(['xs:string']);
    expect(ifcMeasureToXsdTypes('IFCDATE')).toEqual(['xs:date']);
  });
});
