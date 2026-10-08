/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Property test (IDS-014, ADR-005): `parseIDS(writeIdsXml(doc))` is `doc`
 * for every document in the parser's image, i.e. every `IDSDocument` that
 * `parseIDS` itself can produce. That space excludes only parser
 * bookkeeping and spellings the parser canonicalises:
 *
 * - `ifcVersionRaw` (the raw attribute echo) is dropped before comparing;
 * - restriction families come in the parser's order (pattern, enumeration,
 *   bounds) and every family of one restriction carries its `base`;
 * - `IFC4X3_ADD2` is read as `IFC4X3`, so documents carry `IFC4X3`;
 * - `info` text is trimmed on read, so generated info text is trimmed;
 * - requirement ids are positional (`req-N`) and entity requirements are
 *   `required` (IDS 1.0 has no cardinality on them).
 *
 * No property-testing library is a dependency of this repo, so documents come
 * from a small seeded generator: a failure names its seed and case, and
 * `ROUNDTRIP_SEED` / `ROUNDTRIP_CASES` replay or widen the run.
 */

import { describe, expect, it } from 'vitest';
import type {
  IDSConstraint, IDSDocument, IDSEntityFacet, IDSFacet, IDSInfo, IDSRequirement, IDSSpecification, IFCVersion, PartOfRelation,
} from '../types.js';
import { parseIDS } from '../parser/xml-parser.js';
import { writeIdsXml } from './index.js';

const SCHEMA_LOCATION = 'http://standards.buildingsmart.org/IDS http://standards.buildingsmart.org/IDS/1.0/ids.xsd';
const CASES = Number(process.env.ROUNDTRIP_CASES ?? 10_000);
const SEED = Number(process.env.ROUNDTRIP_SEED ?? 0x1d5_2026);

/** mulberry32: tiny, seedable, good enough to spread cases. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class Gen {
  constructor(readonly next: () => number) {}
  int(min: number, max: number): number { return min + Math.floor(this.next() * (max - min + 1)); }
  bool(p = 0.5): boolean { return this.next() < p; }
  pick<T>(items: readonly T[]): T { return items[this.int(0, items.length - 1)]; }
  maybe<T>(make: () => T, p = 0.5): T | undefined { return this.bool(p) ? make() : undefined; }
  list<T>(min: number, max: number, make: () => T): T[] { return Array.from({ length: this.int(min, max) }, make); }
}

/** Characters that stress escaping: markup, quotes, whitespace XML normalises, non-ASCII and astral text. */
const ALPHABET = [...'abcXYZ019 _-.', '<', '>', '&', '"', "'", '\n', '\t', '\r', ' ', 'é', 'ß', '中', '😀', ']]>', '&amp;', '\\d+', '[A-Z]'];

function text(g: Gen, min = 0, max = 12): string {
  return g.list(min, max, () => g.pick(ALPHABET)).join('');
}
function nonEmpty(g: Gen): string { return text(g, 1); }
/** `info` children are trimmed on read. */
function trimmed(g: Gen): string { return `a${text(g)}z`; }

const NUMBERS = [0, 1, -1, 0.5, -2.75, 3.14159, 1e-7, -4.2e-12, 1e21, 6.02e23, 123456789.125, Number.MAX_SAFE_INTEGER, 5e-324, 1.7976931348623157e308];
function number(g: Gen): number {
  return g.bool(0.7) ? g.pick(NUMBERS) : (g.next() - 0.5) * 10 ** g.int(-10, 12);
}

function restriction(g: Gen): IDSConstraint {
  const base = g.pick(['xs:string', 'xs:double', 'xs:decimal', 'xs:integer', 'xs:boolean']);
  const families: Exclude<IDSConstraint, { type: 'simpleValue' }>[] = [];
  const kinds = { pattern: g.bool(0.4), enumeration: g.bool(0.4), bounds: g.bool(0.5) };
  if (!kinds.pattern && !kinds.enumeration && !kinds.bounds) kinds[g.pick(['pattern', 'enumeration', 'bounds'] as const)] = true;
  if (kinds.pattern) families.push({ type: 'pattern', base, pattern: nonEmpty(g) });
  if (kinds.enumeration) families.push({ type: 'enumeration', base, values: g.list(1, 4, () => text(g)) });
  if (kinds.bounds) {
    const bounds: Extract<IDSConstraint, { type: 'bounds' }> = { type: 'bounds', base };
    for (const facet of ['minInclusive', 'minExclusive', 'maxInclusive', 'maxExclusive'] as const) {
      if (g.bool(0.3)) bounds[facet] = number(g);
    }
    for (const facet of ['length', 'minLength', 'maxLength', 'totalDigits', 'fractionDigits'] as const) {
      if (g.bool(0.2)) bounds[facet] = g.int(0, 40);
    }
    if (Object.keys(bounds).length === 2) bounds.maxInclusive = number(g);
    families.push(bounds);
  }
  const [primary, ...rest] = families;
  return rest.length > 0 ? { ...primary, and: rest } : primary;
}

function constraint(g: Gen): IDSConstraint {
  return g.bool(0.5) ? { type: 'simpleValue', value: text(g) } : restriction(g);
}

function entity(g: Gen): IDSEntityFacet {
  return { type: 'entity', name: constraint(g), predefinedType: g.maybe(() => constraint(g)) };
}

const RELATIONS: readonly PartOfRelation[] = [
  'IfcRelAggregates', 'IfcRelAssignsToGroup', 'IfcRelContainedInSpatialStructure', 'IfcRelNests', 'IfcRelVoidsElement IfcRelFillsElement',
];

function facet(g: Gen, kind: IDSFacet['type']): IDSFacet {
  switch (kind) {
    case 'entity': return entity(g);
    case 'attribute': return { type: 'attribute', name: constraint(g), value: g.maybe(() => constraint(g)) };
    case 'property': return {
      type: 'property', propertySet: constraint(g), baseName: constraint(g),
      dataType: g.maybe(() => ({ type: 'simpleValue', value: g.pick(['IFCLABEL', 'IFCREAL', 'IFCBOOLEAN', 'IFCLENGTHMEASURE']) })),
      value: g.maybe(() => constraint(g)),
    };
    case 'classification': return { type: 'classification', system: g.maybe(() => constraint(g)), value: g.maybe(() => constraint(g)) };
    case 'material': return { type: 'material', value: g.maybe(() => constraint(g)) };
    case 'partOf': return { type: 'partOf', relation: g.pick(RELATIONS), entity: entity(g) };
  }
}

const KINDS: readonly IDSFacet['type'][] = ['entity', 'partOf', 'classification', 'attribute', 'property', 'material'];
const VERSIONS: readonly IFCVersion[] = ['IFC2X3', 'IFC4', 'IFC4X3'];
const OCCURS = [[1, 'unbounded'], [0, 'unbounded'], [0, 0]] as const;

function specification(g: Gen, index: number): IDSSpecification {
  const identifier = g.maybe(() => nonEmpty(g));
  const [minOccurs, maxOccurs] = g.pick(OCCURS);
  const versions = VERSIONS.filter(() => g.bool());
  const requirements: IDSRequirement[] = g.list(0, 4, () => g.pick(KINDS)).map((kind, i) => ({
    id: `req-${i}`,
    facet: facet(g, kind),
    optionality: kind === 'entity' ? 'required' : g.pick(['required', 'optional', 'prohibited'] as const),
    instructions: g.maybe(() => nonEmpty(g), 0.3),
  }));
  return {
    id: identifier ?? `spec-${index}`, identifier, name: nonEmpty(g),
    description: g.maybe(() => nonEmpty(g), 0.3), instructions: g.maybe(() => nonEmpty(g), 0.3),
    ifcVersions: versions.length > 0 ? (g.bool() ? versions : [...versions].reverse()) : ['IFC4'],
    applicability: { facets: g.list(0, 4, () => facet(g, g.pick(KINDS))) },
    requirements, minOccurs, maxOccurs,
  };
}

function document(g: Gen): IDSDocument {
  const info: IDSInfo = { title: trimmed(g) };
  for (const key of ['copyright', 'version', 'description', 'author', 'date', 'purpose', 'milestone'] as const) {
    if (g.bool(0.3)) info[key] = trimmed(g);
  }
  return { info, specifications: g.list(0, 3, () => 0).map((_, i) => specification(g, i)), schemaLocation: SCHEMA_LOCATION };
}

/** Parser bookkeeping, not content: the raw `ifcVersion` echo. */
function withoutBookkeeping(doc: IDSDocument): IDSDocument {
  return { ...doc, specifications: doc.specifications.map(({ ifcVersionRaw: _raw, ...spec }) => spec) };
}

describe('parse ∘ write = id on generated documents (IDS-014)', () => {
  it(`holds for ${CASES} seeded documents (seed ${SEED})`, () => {
    const g = new Gen(rng(SEED));
    for (let i = 0; i < CASES; i++) {
      const doc = document(g);
      const xml = writeIdsXml(doc);
      let reread: IDSDocument;
      try { reread = withoutBookkeeping(parseIDS(xml)); }
      catch (error) { throw new Error(`seed ${SEED} case ${i}: the written XML does not parse: ${String(error)}\n${xml}`); }
      expect(reread, `seed ${SEED} case ${i}\n${xml}`).toEqual(doc);
    }
  }, 120_000);

  it('the generator reaches every constraint shape the writer has a branch for', () => {
    const g = new Gen(rng(SEED));
    const seen = new Set<string>();
    const visit = (c: IDSConstraint): void => {
      seen.add(c.type);
      if (c.type === 'simpleValue') return;
      if (c.and?.length) seen.add('and');
      if (c.type === 'bounds' && (c.length ?? c.minLength ?? c.maxLength) !== undefined) seen.add('length');
      if (c.type === 'bounds' && (c.totalDigits ?? c.fractionDigits) !== undefined) seen.add('digits');
      for (const sibling of c.and ?? []) visit(sibling);
    };
    for (let i = 0; i < 500; i++) {
      for (const spec of document(g).specifications) {
        for (const f of [...spec.applicability.facets, ...spec.requirements.map((r) => r.facet)]) {
          for (const value of Object.values(f)) {
            if (value && typeof value === 'object' && 'type' in value && value.type !== 'entity') visit(value as IDSConstraint);
          }
        }
      }
    }
    expect([...seen].sort()).toEqual(['and', 'bounds', 'digits', 'enumeration', 'length', 'pattern', 'simpleValue']);
  });
});
