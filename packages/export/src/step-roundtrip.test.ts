/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * STEP export round-trip fidelity tests.
 *
 * Contract under test: `StepExporter.export()` without mutations is a
 * FULL-MODEL pass-through — it re-emits every entity line verbatim from the
 * source buffer (same expressIds, same attribute text) and only regenerates
 * the ISO-10303-21 header. So a parse → export → re-parse cycle must
 * preserve the complete model: per-type entity counts, GlobalIds, property
 * sets, and units. (Schema CONVERSION and mutation application are separate
 * code paths covered by step-exporter.test.ts / schema-converter.test.ts;
 * here we always export to the source schema so no conversion runs.)
 *
 * All comparisons are set/count based — byte equality is intentionally NOT
 * asserted because header text and line ordering may legitimately differ.
 */

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';
import { IfcParser, type IfcDataStore } from '@ifc-lite/parser';
import { StepExporter, exportToStep } from './step-exporter.js';

const MODELS_DIR = resolve(__dirname, '../../../tests/models');

// Small (< 1 MB) real-world fixtures covering IFC2X3 and IFC4. Fixtures are
// fetched on demand via `pnpm fixtures` (AGENTS.md §9); skip cleanly when
// they aren't on disk so a fresh checkout doesn't crash with ENOENT.
const FIXTURES = [
  {
    name: 'various/test.ifc',
    schema: 'IFC2X3' as const,
    lengthUnitScale: 1, // metres
    hasPsets: false,
  },
  {
    name: 'buildingsmart/wall-with-opening-and-window.ifc',
    schema: 'IFC4' as const,
    lengthUnitScale: 0.001, // millimetres
    hasPsets: true,
  },
  {
    name: 'buildingsmart/basin-tessellation.ifc',
    schema: 'IFC4' as const,
    lengthUnitScale: 0.001, // millimetres
    hasPsets: false,
  },
];

const FIXTURES_AVAILABLE = FIXTURES.every((f) => existsSync(resolve(MODELS_DIR, f.name)));

function toArrayBuffer(buf: Buffer): ArrayBuffer {
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}

async function parseFixture(name: string): Promise<IfcDataStore> {
  const parser = new IfcParser();
  return parser.parseColumnar(toArrayBuffer(readFileSync(resolve(MODELS_DIR, name))));
}

async function roundTrip(store: IfcDataStore): Promise<IfcDataStore> {
  // Export to the SOURCE schema so the pass-through path runs (no conversion).
  const result = new StepExporter(store).export({ schema: store.schemaVersion });
  const parser = new IfcParser();
  return parser.parseColumnar(toArrayBuffer(Buffer.from(result.content)));
}

/** Per-IFC-type entity counts, e.g. { IFCWALL: 2, IFCSLAB: 1, ... } */
function typeCounts(store: IfcDataStore): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const [type, ids] of store.entityIndex.byType) {
    counts[type] = ids.length;
  }
  return counts;
}

/** All non-empty GlobalIds in the entity table. */
function globalIdSet(store: IfcDataStore): Set<string> {
  const out = new Set<string>();
  const { entities, strings } = store;
  for (let i = 0; i < entities.count; i++) {
    const globalId = strings.get(entities.globalId[i]);
    if (globalId) out.add(globalId);
  }
  return out;
}

/**
 * Canonical pset snapshot per entity: expressId -> sorted
 * [psetName, propName, value] triples. ExpressIds are stable across the
 * round-trip because the exporter re-emits original entity lines.
 */
function psetSnapshot(store: IfcDataStore): Map<number, string> {
  const out = new Map<number, string>();
  const { entities } = store;
  for (let i = 0; i < entities.count; i++) {
    const expressId = entities.expressId[i];
    const psets = store.getProperties(expressId);
    if (!psets.length) continue;
    const triples: Array<[string, string, unknown]> = [];
    for (const pset of psets) {
      for (const prop of pset.properties) {
        triples.push([pset.name, prop.name, prop.value]);
      }
    }
    triples.sort((a, b) => `${a[0]}|${a[1]}`.localeCompare(`${b[0]}|${b[1]}`));
    out.set(expressId, JSON.stringify(triples));
  }
  return out;
}

describe.skipIf(!FIXTURES_AVAILABLE)('STEP export round-trip fidelity', () => {
  for (const fixture of FIXTURES) {
    describe(fixture.name, () => {
      it('preserves schema version and per-type entity counts', async () => {
        const original = await parseFixture(fixture.name);
        expect(original.schemaVersion).toBe(fixture.schema);

        const reparsed = await roundTrip(original);

        expect(reparsed.schemaVersion).toBe(original.schemaVersion);
        expect(reparsed.entityCount).toBe(original.entityCount);
        // Full per-type map equality: catches both dropped entities and
        // entities whose type token got mangled on export.
        expect(typeCounts(reparsed)).toEqual(typeCounts(original));
      });

      it('preserves the GlobalId set', async () => {
        const original = await parseFixture(fixture.name);
        const reparsed = await roundTrip(original);

        const originalIds = globalIdSet(original);
        // Guard against a vacuous pass on a fixture with no rooted entities.
        expect(originalIds.size).toBeGreaterThan(0);
        expect(globalIdSet(reparsed)).toEqual(originalIds);
      });

      it('preserves property sets (names and values) per entity', async () => {
        const original = await parseFixture(fixture.name);
        const reparsed = await roundTrip(original);

        const before = psetSnapshot(original);
        const after = psetSnapshot(reparsed);

        if (fixture.hasPsets) {
          // Guard: this fixture is the one exercising real pset content.
          expect(before.size).toBeGreaterThan(0);
        }
        expect(after.size).toBe(before.size);
        for (const [expressId, snapshot] of before) {
          expect(after.get(expressId), `psets of #${expressId}`).toBe(snapshot);
        }
      });

      it('preserves project units', async () => {
        const original = await parseFixture(fixture.name);
        const reparsed = await roundTrip(original);

        // Known absolute value guards against a units regression that
        // breaks both parses identically.
        expect(original.lengthUnitScale).toBe(fixture.lengthUnitScale);
        expect(reparsed.lengthUnitScale).toBe(original.lengthUnitScale);

        // Unit entities themselves must survive verbatim.
        const unitTypes = ['IFCSIUNIT', 'IFCCONVERSIONBASEDUNIT', 'IFCUNITASSIGNMENT'];
        for (const type of unitTypes) {
          expect(
            reparsed.entityIndex.byType.get(type)?.length ?? 0,
            `${type} count`,
          ).toBe(original.entityIndex.byType.get(type)?.length ?? 0);
        }
      });

      it('re-exports geometry entity references intact (export of re-parse is stable)', async () => {
        // Second-generation check: exporting the re-parsed model again must
        // produce the same DATA section content (the pass-through is
        // idempotent). This catches mangled entity refs that still happen
        // to re-parse without error.
        const original = await parseFixture(fixture.name);
        const gen1 = new StepExporter(original).export({ schema: original.schemaVersion });
        const reparsed = await roundTrip(original);
        const gen2 = new StepExporter(reparsed).export({ schema: reparsed.schemaVersion });

        const dataSection = (bytes: Uint8Array) => {
          const text = new TextDecoder().decode(bytes);
          return text.slice(text.indexOf('DATA;'));
        };
        expect(dataSection(gen2.content)).toBe(dataSection(gen1.content));
      });
    });
  }
});

// The `exportToStep()` convenience wrapper is the public one-call round-trip
// path. It used to hardcode `schema: 'IFC4'` as its default, so a caller who
// omitted `schema` silently schema-CONVERTED every non-IFC4 model: an IFC2X3
// or IFC4X3 file came back out under a `FILE_SCHEMA(('IFC4'))` header — the
// wrong schema token, and an invalid file wherever the source used
// schema-specific entities (e.g. AB22's IFC4X3 IfcRoad / IfcCourse /
// IfcPavement have no IFC4 equivalent). The wrapper must default to the SOURCE
// schema, matching `StepExporter.export()`'s own fallback and the
// `?? store.schemaVersion ?? 'IFC4'` every internal caller already spells out.
const SCHEMA_FIXTURES = [
  { name: 'various/test.ifc', schema: 'IFC2X3', token: 'IFC2X3' },
  { name: 'AB22.ifc', schema: 'IFC4X3', token: 'IFC4X3_RC4' },
] as const;
const SCHEMA_FIXTURES_AVAILABLE = SCHEMA_FIXTURES.every((f) =>
  existsSync(resolve(MODELS_DIR, f.name)),
);

function fileSchemaToken(step: string): string | undefined {
  // FILE_SCHEMA(('IFC4X3_RC4')); -> IFC4X3_RC4
  return step.match(/FILE_SCHEMA\s*\(\s*\(\s*'([^']+)'/)?.[1];
}

describe.skipIf(!SCHEMA_FIXTURES_AVAILABLE)('exportToStep default schema fidelity', () => {
  for (const fixture of SCHEMA_FIXTURES) {
    it(`preserves the source ${fixture.schema} schema when no schema option is given (${fixture.name})`, async () => {
      const original = await parseFixture(fixture.name);
      expect(original.schemaVersion).toBe(fixture.schema);

      // No `schema` option: the default must NOT force conversion to IFC4.
      const step = exportToStep(original);
      expect(fileSchemaToken(step)).toBe(fixture.token);

      const store = await new IfcParser().parseColumnar(
        new TextEncoder().encode(step).buffer as ArrayBuffer,
      );
      expect(store.schemaVersion).toBe(fixture.schema);
      // The whole model must still be present (no entities lost to a
      // spurious cross-schema conversion pass).
      expect(store.entityCount).toBe(original.entityCount);
    });
  }

  it('still honors an EXPLICIT schema override (conversion path is unchanged)', async () => {
    const original = await parseFixture('various/test.ifc');
    expect(original.schemaVersion).toBe('IFC2X3');
    // Control: an explicit target still converts, proving the fix only moved
    // the DEFAULT and did not disable the conversion path.
    const step = exportToStep(original, { schema: 'IFC4' });
    expect(fileSchemaToken(step)).toBe('IFC4');
  });
});
