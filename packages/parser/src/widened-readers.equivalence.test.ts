/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Source-shape equivalence for the parser's OTHER widened byte-range readers
 * (#2183): `extractLengthUnitScale`, `extractProjectUnits` and
 * `buildEntityRefsFromIndex`.
 *
 * `entity-extractor.equivalence.test.ts` covers the 42 construction sites that
 * funnel through `EntityExtractor`. These three do not all: only the two unit
 * readers build an extractor, while `buildEntityRefsFromIndex` reads the source
 * through `IfcSourceBytes.slice` directly and never decodes a string at all.
 * So the seam has to be pinned here as well.
 *
 * THREE sides, deliberately, for the same reason the extractor harness has
 * three. Comparing `reader(raw)` against `reader(contiguousSourceBytes(raw))`
 * ALONE IS A TAUTOLOGY: every one of these readers normalises its argument
 * through `asSourceBytes`, which wraps a `Uint8Array` in the very same
 * `ContiguousSourceBytes`, so both sides are one implementation and a decode or
 * slice bug shifts them identically.
 *
 *   raw        the `Uint8Array` every call site passes today
 *   accessor   `contiguousSourceBytes(raw)` — the shape the migration moves to
 *   reference  an independent, deliberately naive `IfcSourceBytes` that copies
 *              the requested range and decodes it with a plain `TextDecoder`
 *
 * `reference` shares no code with the implementation under test, so it is the
 * oracle that turns a real read bug into a diff instead of a shifted-but-equal
 * pair. On top of that every case pins a CONCRETE expected value (a millimetre
 * model must resolve to 0.001, not merely to "whatever all three sides say"),
 * which is what stops a run where every side failed identically from passing.
 *
 * Mutation-checked, measured not assumed:
 *
 *   decodeUtf8 start+1   RED (3/5) — the extractor's `^#(\d+)=` match fails,
 *                        so the millimetre scale collapses to the unconfirmed
 *                        1.0 default and the declared-unit map empties.
 *   slice start+1        green, and CORRECTLY so: the only reader here that
 *                        touches `slice` is `buildEntityRefsFromIndex`, and its
 *                        output is genuinely invariant to losing the leading
 *                        `#` — it scans forward to `=` for the type token and
 *                        takes the offsets from the pre-pass columns. No
 *                        correct assertion can fail on that mutation.
 *   slice wrong origin   RED (2/5) — every record reads from byte 0, which is
 *   (`subarray(0,e-s)`)  the bug class a blocked/compressed source introduces,
 *                        and the case `buildEntityRefsFromIndex` must catch.
 */

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractLengthUnitScale } from './unit-extractor.js';
import { extractProjectUnits, type ProjectUnits } from './project-units.js';
import { buildEntityRefsFromIndex } from './entity-refs-from-index.js';
import { scanIfcEntities } from './entity-scanner.js';
import { contiguousSourceBytes, type IfcSourceBytes, type IfcSourceTransfer } from './source-bytes.js';
import type { EntityRef } from './types.js';

/** Fixture, relative to `tests/models`. Fixtures are NOT committed (AGENTS.md). */
const FIXTURE_RELPATH = 'ara3d/AC20-FZK-Haus.ifc';

/** Non-vacuity floor for the fixture side: AC20-FZK-Haus indexes ~44k records. */
const MIN_ENTITIES = 10_000;

// `import.meta.url`, not `cwd`: the test must resolve the same fixture whether
// it runs from the repo root (turbo) or from the package directory.
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MANIFEST_PATH = resolve(REPO_ROOT, 'tests', 'models', 'manifest.json');
const FIXTURE_PATH = resolve(REPO_ROOT, 'tests', 'models', FIXTURE_RELPATH);

interface FixtureManifest {
  files?: { path?: string }[];
}

/**
 * An independent `IfcSourceBytes` written from the interface contract alone —
 * no `subarray` views, no `safeUtf8Decode`, nothing shared with
 * `ContiguousSourceBytes`. Every read copies the requested range and decodes it
 * with a plain `TextDecoder`. Slow and allocation-happy on purpose: its job is
 * to disagree when the real implementation reads the wrong bytes.
 *
 * Duplicated from `entity-extractor.equivalence.test.ts` rather than imported:
 * importing one vitest file from another re-registers its suites here.
 */
function referenceSourceBytes(bytes: Uint8Array): IfcSourceBytes {
  const decoder = new TextDecoder();
  const len = bytes.byteLength;
  const clamp = (n: number): number => (Number.isFinite(n) ? Math.max(0, Math.min(Math.trunc(n), len)) : 0);
  const copy = (start: number, end: number): Uint8Array => {
    const s = clamp(start);
    const e = Math.max(s, clamp(end));
    const out = new Uint8Array(e - s);
    for (let i = s; i < e; i++) out[i - s] = bytes[i];
    return out;
  };
  return {
    byteLength: len,
    length: len,
    isResident: true,
    contentKey: `reference-${len}`,
    slice: (start: number, end: number) => copy(start, end),
    decodeUtf8: (start: number, end: number) => decoder.decode(copy(start, end)),
    materialize: () => copy(0, len),
    withMaterialized: <T,>(fn: (b: Uint8Array) => T) => fn(copy(0, len)),
    withMaterializedAsync: <T,>(fn: (b: Uint8Array) => Promise<T>) => fn(copy(0, len)),
    toTransferable: (): IfcSourceTransfer => ({
      kind: 'contiguous',
      bytes: copy(0, len),
      contentKey: `reference-${len}`,
    }),
  };
}

interface Model {
  raw: Uint8Array;
  entityIndex: { byId: Map<number, EntityRef>; byType: Map<string, number[]> };
}

/** Build a source buffer + index from one-record-per-line STEP text. */
function inlineModel(lines: string[]): Model {
  const encoder = new TextEncoder();
  const byId = new Map<number, EntityRef>();
  const byType = new Map<string, number[]>();
  const parts: Uint8Array[] = [];
  let offset = 0;
  lines.forEach((line, i) => {
    const match = line.match(/^#(\d+)\s*=\s*(\w+)/);
    if (!match) throw new Error(`inlineModel: unparseable record: ${line}`);
    const expressId = Number(match[1]);
    const type = match[2].toUpperCase();
    const encoded = encoder.encode(line);
    byId.set(expressId, { expressId, type, byteOffset: offset, byteLength: encoded.byteLength, lineNumber: i + 1 });
    const ids = byType.get(type);
    if (ids) ids.push(expressId);
    else byType.set(type, [expressId]);
    parts.push(encoded);
    offset += encoded.byteLength;
    // Newline separator, so a reader that over-reads by a byte picks up
    // something that is NOT part of the record.
    parts.push(encoder.encode('\n'));
    offset += 1;
  });
  const raw = new Uint8Array(offset);
  let pos = 0;
  for (const part of parts) {
    raw.set(part, pos);
    pos += part.byteLength;
  }
  return { raw, entityIndex: { byId, byType } };
}

/** A millimetre model with an SI-prefixed length unit, a conversion-based
 *  plane angle and a monetary unit — enough that a reader which silently falls
 *  back to its defaults produces a visibly different answer. */
const MILLIMETRE_MODEL = [
  "#1=IFCPROJECT('0Project0000000000000a',$,'Millimetre model',$,$,$,$,(#2),#3);",
  "#2=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-05,#4,$);",
  '#3=IFCUNITASSIGNMENT((#5,#6,#7,#8));',
  '#4=IFCAXIS2PLACEMENT3D(#9,$,$);',
  '#5=IFCSIUNIT(*,.LENGTHUNIT.,.MILLI.,.METRE.);',
  '#6=IFCSIUNIT(*,.AREAUNIT.,$,.SQUARE_METRE.);',
  "#7=IFCCONVERSIONBASEDUNIT(#10,.PLANEANGLEUNIT.,'DEGREE',#11);",
  "#8=IFCMONETARYUNIT('EUR');",
  '#9=IFCCARTESIANPOINT((0.,0.,0.));',
  '#10=IFCDIMENSIONALEXPONENTS(0,0,0,0,0,0,0);',
  '#11=IFCMEASUREWITHUNIT(IFCPLANEANGLEMEASURE(1.745329E-02),#12);',
  '#12=IFCSIUNIT(*,.PLANEANGLEUNIT.,$,.RADIAN.);',
];

/** The measures whose resolved unit is compared across source shapes. Covers
 *  every unit type either model declares plus a dimensionless control. */
const PROBE_MEASURES = [
  'IfcLengthMeasure', 'IfcAreaMeasure', 'IfcVolumeMeasure', 'IfcMassMeasure',
  'IfcTimeMeasure', 'IfcPlaneAngleMeasure', 'IfcSolidAngleMeasure',
  'IfcThermodynamicTemperatureMeasure', 'IfcLuminousIntensityMeasure',
  'IfcPowerMeasure', 'IfcThermalTransmittanceMeasure', 'IfcMonetaryMeasure',
  'IfcRatioMeasure',
];

/** Whole-object snapshot of a `ProjectUnits`, since its map is private. */
function summarizeUnits(units: ProjectUnits): string {
  const rows = PROBE_MEASURES.map((m) => [m, units.unitForMeasure(m)] as const);
  return JSON.stringify({ declaredCount: units.declaredCount, monetary: units.monetary(), rows });
}

/** The three columnar arrays the geometry pre-pass hands
 *  `buildEntityRefsFromIndex`, rebuilt from an entity index. */
function columnsFrom(refs: Iterable<EntityRef>): {
  ids: Uint32Array; starts: Uint32Array; lengths: Uint32Array;
} {
  const list = [...refs];
  const ids = new Uint32Array(list.length);
  const starts = new Uint32Array(list.length);
  const lengths = new Uint32Array(list.length);
  list.forEach((r, i) => {
    ids[i] = r.expressId;
    starts[i] = r.byteOffset;
    lengths[i] = r.byteLength;
  });
  return { ids, starts, lengths };
}

describe('widened byte-range readers: source-shape equivalence', () => {
  it('lists the fixture in the committed manifest so CI actually fetches it', () => {
    // Asserted SEPARATELY, and before any skip, so the fixture-backed case
    // below cannot silently skip forever: `pnpm fixtures` only fetches what the
    // manifest catalogues, so a dropped entry would make the file permanently
    // absent on CI and the skip permanently green.
    const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as FixtureManifest;
    const paths = (manifest.files ?? []).map((f) => f.path);
    expect(paths).toContain(FIXTURE_RELPATH);
  });

  describe('extractLengthUnitScale', () => {
    it('resolves the same millimetre scale from a Uint8Array, an IfcSourceBytes and a reference source', () => {
      const { raw, entityIndex } = inlineModel(MILLIMETRE_MODEL);

      const fromRaw = extractLengthUnitScale(raw, entityIndex);
      const fromAccessor = extractLengthUnitScale(contiguousSourceBytes(raw), entityIndex);
      const fromReference = extractLengthUnitScale(referenceSourceBytes(raw), entityIndex);

      // Pinned, not merely "all three agree": 1.0 is what EVERY failure path in
      // this reader returns, so a run where all three sides failed identically
      // would otherwise pass. .MILLI. must resolve to 1e-3.
      expect(fromRaw).toBe(1e-3);
      expect(fromAccessor).toBe(fromRaw);
      expect(fromReference).toBe(fromRaw);
    });
  });

  describe('extractProjectUnits', () => {
    it('resolves the same declared units from a Uint8Array, an IfcSourceBytes and a reference source', () => {
      const { raw, entityIndex } = inlineModel(MILLIMETRE_MODEL);

      const fromRaw = extractProjectUnits(raw, entityIndex);
      const fromAccessor = extractProjectUnits(contiguousSourceBytes(raw), entityIndex);
      const fromReference = extractProjectUnits(referenceSourceBytes(raw), entityIndex);

      // Non-vacuity: an empty ProjectUnits is this reader's silent failure
      // mode, and three empty ones compare equal.
      expect(fromRaw.declaredCount).toBe(3);
      expect(fromRaw.unitForMeasure('IfcLengthMeasure')).toEqual({ symbol: 'mm', siScale: 1e-3 });
      expect(fromRaw.unitForMeasure('IfcAreaMeasure')).toEqual({ symbol: 'm²', siScale: 1 });
      expect(fromRaw.unitForMeasure('IfcPlaneAngleMeasure')?.symbol).toBe('°');
      expect(fromRaw.unitForMeasure('IfcPlaneAngleMeasure')?.siScale).toBeCloseTo(1.745329e-2, 12);
      expect(fromRaw.monetary()).toEqual({ symbol: '€', siScale: 1 });

      expect(summarizeUnits(fromAccessor)).toBe(summarizeUnits(fromRaw));
      expect(summarizeUnits(fromReference)).toBe(summarizeUnits(fromRaw));
    });
  });

  describe('buildEntityRefsFromIndex', () => {
    it('synthesizes the same refs from a Uint8Array, an IfcSourceBytes and a reference source', () => {
      const { raw, entityIndex } = inlineModel(MILLIMETRE_MODEL);
      const { ids, starts, lengths } = columnsFrom(entityIndex.byId.values());

      const fromRaw = buildEntityRefsFromIndex(raw, ids, starts, lengths);
      const fromAccessor = buildEntityRefsFromIndex(contiguousSourceBytes(raw), ids, starts, lengths);
      const fromReference = buildEntityRefsFromIndex(referenceSourceBytes(raw), ids, starts, lengths);

      // Pinned per record: the type token is what this reader derives from the
      // bytes, so an empty or shifted type name has to be visible here. Refs
      // come out id-ordered by contract.
      expect(fromRaw.map((r) => [r.expressId, r.type])).toEqual([
        [1, 'IFCPROJECT'],
        [2, 'IFCGEOMETRICREPRESENTATIONCONTEXT'],
        [3, 'IFCUNITASSIGNMENT'],
        [4, 'IFCAXIS2PLACEMENT3D'],
        [5, 'IFCSIUNIT'],
        [6, 'IFCSIUNIT'],
        [7, 'IFCCONVERSIONBASEDUNIT'],
        [8, 'IFCMONETARYUNIT'],
        [9, 'IFCCARTESIANPOINT'],
        [10, 'IFCDIMENSIONALEXPONENTS'],
        [11, 'IFCMEASUREWITHUNIT'],
        [12, 'IFCSIUNIT'],
      ]);
      expect(fromAccessor).toEqual(fromRaw);
      expect(fromReference).toEqual(fromRaw);
    });
  });

  it('agrees across source shapes on a real IFC file', async (ctx) => {
    if (!existsSync(FIXTURE_PATH)) {
      // ctx.skip(), never a bare `return`: a return records a PASS, so the
      // suite would look green on a machine that has no fixtures at all.
      ctx.skip(`${FIXTURE_RELPATH} missing — run \`pnpm fixtures\` to fetch it`);
    }

    const file = readFileSync(FIXTURE_PATH);
    // Copy into a clean ArrayBuffer: a Node Buffer aliases a shared pool, so
    // `file.buffer` is not the file's bytes.
    const ab = new ArrayBuffer(file.byteLength);
    const raw = new Uint8Array(ab);
    raw.set(file);

    // Pure-TS tokenizer path (no worker, no wasm): the index is produced
    // without touching the readers compared below, so the `type` it carries is
    // an INDEPENDENT oracle for `buildEntityRefsFromIndex`.
    const { entityRefs } = await scanIfcEntities(ab, { disableWorkerScan: true });
    const byId = new Map<number, EntityRef>();
    const byType = new Map<string, number[]>();
    for (const ref of entityRefs) {
      byId.set(ref.expressId, ref);
      const ids = byType.get(ref.type);
      if (ids) ids.push(ref.expressId);
      else byType.set(ref.type, [ref.expressId]);
    }
    expect(byId.size).toBeGreaterThanOrEqual(MIN_ENTITIES);

    const entityIndex = { byId, byType };
    const accessor = contiguousSourceBytes(raw);
    const reference = referenceSourceBytes(raw);

    // --- extractLengthUnitScale -------------------------------------------
    const scaleRaw = extractLengthUnitScale(raw, entityIndex);
    expect(extractLengthUnitScale(accessor, entityIndex)).toBe(scaleRaw);
    expect(extractLengthUnitScale(reference, entityIndex)).toBe(scaleRaw);
    // AC20-FZK-Haus declares `IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.)`.
    expect(scaleRaw).toBe(1.0);

    // --- extractProjectUnits ----------------------------------------------
    const unitsRaw = extractProjectUnits(raw, entityIndex);
    expect(unitsRaw.declaredCount).toBeGreaterThanOrEqual(8);
    expect(unitsRaw.unitForMeasure('IfcLengthMeasure')).toEqual({ symbol: 'm', siScale: 1 });
    expect(summarizeUnits(extractProjectUnits(accessor, entityIndex))).toBe(summarizeUnits(unitsRaw));
    expect(summarizeUnits(extractProjectUnits(reference, entityIndex))).toBe(summarizeUnits(unitsRaw));

    // --- buildEntityRefsFromIndex -----------------------------------------
    const { ids, starts, lengths } = columnsFrom(byId.values());
    const refsRaw = buildEntityRefsFromIndex(raw, ids, starts, lengths);
    expect(buildEntityRefsFromIndex(accessor, ids, starts, lengths)).toEqual(refsRaw);
    expect(buildEntityRefsFromIndex(reference, ids, starts, lengths)).toEqual(refsRaw);

    // Independent oracle: the type this reader carved out of the bytes must be
    // the type the tokenizer scan reported for the same record. Without this,
    // three sides that all produced `type: ''` would compare equal.
    expect(refsRaw.length).toBe(byId.size);
    const typeMismatches: string[] = [];
    const seenTypes = new Set<string>();
    for (const ref of refsRaw) {
      seenTypes.add(ref.type);
      const scanned = byId.get(ref.expressId);
      if (!scanned || scanned.type !== ref.type) {
        if (typeMismatches.length < 5) {
          typeMismatches.push(`#${ref.expressId}: built=${ref.type} scanned=${scanned?.type}`);
        }
      }
    }
    expect(typeMismatches).toEqual([]);
    expect(seenTypes.size).toBeGreaterThanOrEqual(20);
    expect(seenTypes.has('')).toBe(false);
  });
});
