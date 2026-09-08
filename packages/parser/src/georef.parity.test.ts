/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Holds `extractGeoreferencing` to the SAME shared vectors as the Rust twin
 * (`ifc_lite_core::GeoRefExtractor`, driven by
 * `rust/core/tests/georef_parity.rs`). Georeferencing is thirteen function
 * pairs implemented twice; before this harness the only thing asserting the
 * halves agreed was prose in a doc comment, and a disagreement of a factor of
 * a thousand in the CRS scale relocates a building in every downstream file.
 *
 * The expectations live in the fixture and are anchored to the EXPRESS schema
 * and to IFC semantics, NOT to either implementation's output: a test that
 * compared the two halves only to each other goes green on behaviour that is
 * wrong the same way on both sides.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { extractGeoreferencing, transformToWorld, transformToLocal } from './georef-extractor.js';
import { normalizeIfcTypeName } from './ifc-schema.js';
import type { IfcEntity } from './entity-extractor.js';

// The fixture lives in the core crate, next to the Rust half of the harness;
// skip gracefully if this package is tested outside the monorepo.
const fixturePath = fileURLToPath(
  new URL('../../../rust/core/tests/fixtures/georef_vectors.json', import.meta.url),
);

interface Expect {
  hasGeoreference: boolean;
  source?: string;
  crsName?: string | null;
  crsDescription?: string | null;
  geodeticDatum?: string | null;
  verticalDatum?: string | null;
  mapProjection?: string | null;
  mapZone?: string | null;
  mapUnit?: string | null;
  mapUnitScale?: number | null;
  eastings?: number;
  northings?: number;
  orthogonalHeight?: number;
  xAxisAbscissa?: number;
  xAxisOrdinate?: number;
  scale?: number;
  localToMap?: { local: [number, number, number]; map: [number, number, number] }[];
}

interface Vector {
  name: string;
  /** Minimal but complete ISO-10303-21 file. */
  ifc: string;
  expect: Expect;
}

/**
 * Split a STEP attribute list on top-level commas, respecting nesting and
 * single-quoted literals.
 */
function splitAttributes(body: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let inString = false;
  let current = '';
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (inString) {
      current += ch;
      if (ch === "'") {
        // '' is an escaped quote inside a STEP string.
        if (body[i + 1] === "'") { current += "'"; i++; } else { inString = false; }
      }
      continue;
    }
    if (ch === "'") { inString = true; current += ch; continue; }
    if (ch === '(') { depth++; current += ch; continue; }
    if (ch === ')') { depth--; current += ch; continue; }
    if (ch === ',' && depth === 0) { out.push(current); current = ''; continue; }
    current += ch;
  }
  if (current.length > 0) out.push(current);
  return out;
}

/**
 * Decode one STEP attribute into the shape the real parser hands the
 * extractor: `$` -> null, `#n` -> '#n', a quoted literal -> its unquoted text,
 * a number -> a number, an enum -> '.ENUM.', a typed value -> ['TYPE', value],
 * and a list -> an array of the same.
 */
function decodeAttribute(raw: string): unknown {
  const t = raw.trim();
  if (t === '' || t === '$') return null;
  if (t === '*') return '*';
  if (t.startsWith('#')) return t;
  if (t.startsWith("'") && t.endsWith("'")) return t.slice(1, -1).replace(/''/g, "'");
  if (t.startsWith('(') && t.endsWith(')')) {
    const inner = t.slice(1, -1).trim();
    return inner === '' ? [] : splitAttributes(inner).map(decodeAttribute);
  }
  // Typed value, e.g. IFCREAL(1000.) or IFCLENGTHMEASURE(0.3048).
  const typed = /^([A-Za-z0-9_]+)\((.*)\)$/s.exec(t);
  if (typed) return [typed[1].toUpperCase(), decodeAttribute(typed[2])];
  if (t.startsWith('.') && t.endsWith('.')) return t;
  const num = Number(t.endsWith('.') ? t.slice(0, -1) : t);
  if (t !== '' && Number.isFinite(num)) return num;
  return t;
}

/** Index a complete IFC STEP file into the maps `extractGeoreferencing` takes. */
function indexIfc(content: string): {
  entities: Map<number, IfcEntity>;
  entitiesByType: Map<string, number[]>;
} {
  const entities = new Map<number, IfcEntity>();
  const entitiesByType = new Map<string, number[]>();
  const re = /^#(\d+)=([A-Za-z0-9_]+)\((.*)\);\s*$/;
  for (const line of content.split('\n')) {
    const m = re.exec(line.trim());
    if (!m) continue;
    const expressId = Number(m[1]);
    // The real parser hands the extractor canonical PascalCase type names.
    const type = normalizeIfcTypeName(m[2]);
    const attributes = splitAttributes(m[3]).map(decodeAttribute) as IfcEntity['attributes'];
    entities.set(expressId, { expressId, type, attributes });
    const list = entitiesByType.get(type) ?? [];
    list.push(expressId);
    entitiesByType.set(type, list);
  }
  return { entities, entitiesByType };
}

/**
 * Same tolerance rule as the Rust half: relative to the expectation with an
 * absolute floor so an expected 0 stays comparable. Every expectation is an
 * exact decimal or a constant reproduced identically in both languages, so
 * this is far looser than the real agreement and still catches any semantic
 * divergence (the smallest one the fixture guards is a factor of 10).
 */
function approx(got: number | undefined, want: number, what: string): void {
  expect(got, what).toBeTypeOf('number');
  const tol = Math.abs(want) * 1e-9 + 1e-9;
  expect(Math.abs((got as number) - want), `${what}: got ${got}, want ${want}`).toBeLessThanOrEqual(tol);
}

const doc: { cases: Vector[]; requiredCases: string[] } = existsSync(fixturePath)
  ? JSON.parse(readFileSync(fixturePath, 'utf8'))
  : { cases: [], requiredCases: [] };

describe.skipIf(!existsSync(fixturePath))('extractGeoreferencing shared parity vectors', () => {
  it('fixture has cases', () => {
    expect(doc.cases.length).toBeGreaterThan(0);
  });

  /**
   * Anti-vacuity guard. A count floor is not enough — dropping the exact case
   * a defect was about leaves a floor satisfied — so every name in
   * `requiredCases` must be present by name, and every IfcSIPrefix member the
   * readers must resolve must have its own vector.
   */
  it('fixture carries every required case', () => {
    expect(doc.requiredCases.length).toBeGreaterThan(0);
    const present = new Set(doc.cases.map((c) => c.name));
    for (const required of doc.requiredCases) {
      expect(present.has(required), `required vector \`${required}\` is missing`).toBe(true);
    }
    for (const prefix of ['MILLI', 'CENTI', 'DECI', 'DECA', 'HECTO', 'KILO', 'MICRO', 'NANO', 'MEGA', 'GIGA']) {
      const want = `projected_crs_si_prefix_${prefix}`;
      expect(present.has(want), `IfcSIPrefix.${prefix} has no vector: \`${want}\` is missing`).toBe(true);
    }
    // The ePSet free-text label path is where BOTH halves were wrong the same
    // way, so a harness that only diffs the two could not see it. These are the
    // labels a substring test for METRE silently collapses onto 1, plus the two
    // refusal cases that prove the reader declines instead of approximating.
    for (const want of [
      'epset_map_unit_label_DECAMETRE',
      'epset_map_unit_label_HECTOMETRE',
      'epset_map_unit_label_KILOMETRE',
      'epset_map_unit_label_MICROMETRE',
      'epset_map_unit_label_SQUARE_METRE_REFUSED',
      'epset_map_unit_label_UNKNOWN_REFUSED',
      // MapUnit is exporter FREE TEXT, so the plural, the US spelling and the
      // separated US-survey word orders are ordinary real values. Refusing a
      // recognisable spelling is its own defect: it silently hands the model
      // back to the project length unit.
      'epset_map_unit_label_METRES_PLURAL',
      'epset_map_unit_label_MILLIMETRES_PLURAL',
      'epset_map_unit_label_DECAMETRES_PLURAL',
      'epset_map_unit_label_INCHES_PLURAL',
      'epset_map_unit_label_metres_lowercase',
      'epset_map_unit_label_US_SURVEY_FOOT_PARENTHESISED',
      'epset_map_unit_label_US_SURVEY_FEET_WORD_ORDER',
      // ...and the controls proving the normalisation did not become a
      // sniffer: an area unit and an unqualified survey foot still decline.
      'epset_map_unit_label_SQUARE_METRES_REFUSED',
      'epset_map_unit_label_SURVEY_FOOT_NO_NATION_REFUSED',
    ]) {
      expect(present.has(want), `ePSet MapUnit label vector \`${want}\` is missing`).toBe(true);
    }
  });

  for (const c of doc.cases) {
    it(`matches the shared vectors: ${c.name}`, () => {
      const { entities, entitiesByType } = indexIfc(c.ifc);
      const got = extractGeoreferencing(entities, entitiesByType);
      const want = c.expect;

      expect(got.hasGeoreference, 'hasGeoreference').toBe(want.hasGeoreference);
      if (!want.hasGeoreference) return;

      if (want.source !== undefined) expect(got.source, 'source').toBe(want.source);

      const crs = got.projectedCRS;
      if ('mapUnitScale' in want) {
        if (want.mapUnitScale === null) {
          // No MapUnit authored: per the spec the project length unit applies
          // and the reader must not invent one.
          expect(crs?.mapUnitScale ?? null, 'mapUnitScale').toBe(null);
        } else {
          approx(crs?.mapUnitScale, want.mapUnitScale as number, 'mapUnitScale');
        }
      }

      const strings: [keyof Expect, string | undefined][] = [
        ['crsName', crs?.name],
        ['crsDescription', crs?.description],
        ['geodeticDatum', crs?.geodeticDatum],
        ['verticalDatum', crs?.verticalDatum],
        ['mapProjection', crs?.mapProjection],
        ['mapZone', crs?.mapZone],
        ['mapUnit', crs?.mapUnit],
      ];
      for (const [key, actual] of strings) {
        if (!(key in want)) continue;
        const expected = want[key] as string | null;
        expect(actual ?? null, key).toBe(expected);
      }

      const mc = got.mapConversion;
      if (want.eastings !== undefined) approx(mc?.eastings, want.eastings, 'eastings');
      if (want.northings !== undefined) approx(mc?.northings, want.northings, 'northings');
      if (want.orthogonalHeight !== undefined) {
        approx(mc?.orthogonalHeight, want.orthogonalHeight, 'orthogonalHeight');
      }
      if (want.scale !== undefined) approx(mc?.scale ?? 1, want.scale, 'scale');

      // Behavioural check: the transform, not just the parsed fields.
      for (const point of want.localToMap ?? []) {
        const world = transformToWorld(point.local, got);
        expect(world, 'transformToWorld returned a point').not.toBeNull();
        approx(world?.[0], point.map[0], 'transformToWorld.e');
        approx(world?.[1], point.map[1], 'transformToWorld.n');
        approx(world?.[2], point.map[2], 'transformToWorld.h');

        // transformToLocal is the documented inverse.
        const local = transformToLocal(point.map, got);
        expect(local, 'transformToLocal returned a point').not.toBeNull();
        approx(local?.[0], point.local[0], 'transformToLocal.x');
        approx(local?.[1], point.local[1], 'transformToLocal.y');
        approx(local?.[2], point.local[2], 'transformToLocal.z');
      }
    });
  }
});
