/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * LandXML→IFC output, graded by an engine this repo does not control.
 *
 * Every other test of this converter reads its output back through
 * `@ifc-lite/parser` — our code grading our own work. Two defects of exactly
 * that blind-spot shape are why this file exists:
 *
 * - ifc-lite's parser cannot evaluate an IFC4X3 `IfcAlignment` at all, so no
 *   in-repo test could tell whether an alignment we write lands where the
 *   LandXML says it does;
 * - the v1 output declared `FILE_SCHEMA(('IFC4X3'))`, which IfcOpenShell (and
 *   the buildingSMART validator built on it) resolves to a post-ADD2
 *   development schema, under which our standard-conformant layouts fail
 *   (#5351). Our parser treats the two identifiers alike, so parse(write(x))
 *   could never see it.
 *
 * Four external checks, all from `tools/ifcopenshell_reference/`:
 * - `validate_export.py` — `ifcopenshell.validate(express_rules=True)`;
 * - `check_alignment.py` — IfcOpenShell regenerates every `IfcCurveSegment`
 *   from our `IfcAlignmentHorizontalSegment` through its own mapping and must
 *   get ours back, then evaluates our curve and must land every segment
 *   boundary on the point the fixture AUTHORED. The fixture comes from
 *   `make_alignment_fixture.py`, which integrates the geometry independently of
 *   our TypeScript;
 * - `check_vertical.py` — the same for the vertical layout (§12): IfcOpenShell
 *   regenerates every gradient-curve segment from our
 *   `IfcAlignmentVerticalSegment` and must get ours back, agrees with every
 *   transition code, and evaluates our `IfcGradientCurve` to the heights the
 *   fixture generator computed from each LandXML profile definition;
 * - `check_referents.py` — IfcOpenShell reads the stationing referents back
 *   (start station and station equations, §14): their `Pset_Stationing`
 *   values, their order in the referent nest, and the point its kernel
 *   evaluates at each `DistanceAlong`, against the same generator's points.
 *
 * Requires `ifcopenshell` (pinned in `tools/ifcopenshell_reference/
 * requirements.lock`, plus `pytest`); set `IFCOPENSHELL_PYTHON` or have it on
 * `python3`. Wired by `.github/workflows/export-schema-conformance.yml`.
 * Without that environment it SKIPS loudly — reported skipped, never passed.
 */

import { describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { landXmlToIfc } from './landxml-to-ifc.js';
import { TRANSVERSE_MERCATOR_BOUNDS } from './coordinate-plausibility.js';
import type { LandXmlIfcAlignment, LandXmlIfcSource } from './source-types.js';

const TOOL_DIR = resolve(__dirname, '../../../../tools/ifcopenshell_reference');
const VALIDATE_SCRIPT = resolve(TOOL_DIR, 'validate_export.py');
const ALIGNMENT_SCRIPT = resolve(TOOL_DIR, 'check_alignment.py');
const REFERENT_SCRIPT = resolve(TOOL_DIR, 'check_referents.py');
const ALIGNMENT_FIXTURE = resolve(TOOL_DIR, 'alignment_fixture.json');
const VERTICAL_SCRIPT = resolve(TOOL_DIR, 'check_vertical.py');
const CANT_PROBE_SCRIPT = resolve(TOOL_DIR, 'probe_cant_mapping.py');
const PYTHON = process.env.IFCOPENSHELL_PYTHON || 'python3';

const canRun = spawnSync(PYTHON, ['-c', 'import ifcopenshell, ifcopenshell.validate'], { stdio: 'ignore' }).status === 0;
if (!canRun) {
  console.warn(
    `[landxml ifcopenshell-conformance] SKIPPED: ifcopenshell not importable via "${PYTHON}" — set `
    + 'IFCOPENSHELL_PYTHON or install tools/ifcopenshell_reference/requirements.lock (+ pytest).',
  );
}

/** Cold import of ifcopenshell.validate: 3-4 s locally, ~7.5 s on CI runners. */
const TIMEOUT_MS = 30_000;

const UNITS = {
  linearUnit: 'meter', elevationUnit: 'meter',
  linearScaleToMeters: 1, elevationScaleToMeters: 1, assumed: false,
} as const;

/** Every non-alignment entity family the mapping writes. */
const TERRAIN_SOURCE: LandXmlIfcSource = {
  schema: 'LandXML-1.2',
  version: '1.2',
  units: UNITS,
  coordinateSystem: { horizontalDatum: 'SWEREF99 TM', verticalDatum: 'RH2000' },
  surfaces: [{
    sourceId: 'landxml:surface:1', name: 'Existing Ground', kind: 'tin', renderState: 'rendered',
    points: [
      { sourceId: 'p1', id: '1', northing: 6406977.86, easting: 157899.16, elevation: 20.77 },
      { sourceId: 'p2', id: '2', northing: 6406990.12, easting: 157903.44, elevation: 21.03 },
      { sourceId: 'p3', id: '3', northing: 6407001.55, easting: 157888.02, elevation: 19.88 },
    ],
    faces: [['1', '2', '3']],
  }],
  plan: {
    cogoPoints: [{
      sourceId: 'landxml:cgpoint:994', name: 'Point 994', code: 'VAG_VM', description: 'Offset startpoint',
      point: { northing: 6406977.86, easting: 157899.16, elevation: 20.77 },
    }],
  },
};

function alignmentSource(): LandXmlIfcSource {
  const fixture = JSON.parse(readFileSync(ALIGNMENT_FIXTURE, 'utf8')) as {
    alignments: LandXmlIfcAlignment[]; profiles: unknown[];
  };
  return {
    schema: 'LandXML-1.2', version: '1.2', units: UNITS, surfaces: [],
    alignments: fixture.alignments, profiles: fixture.profiles,
  };
}

function writeConverted(source: LandXmlIfcSource, name: string, mutate: (step: string) => string = (s) => s): string {
  const result = landXmlToIfc(source, {
    sourceFileName: `${name}.xml`,
    timestampMs: 0,
    ...(source.coordinateSystem
      ? { crs: { Name: 'SWEREF99 TM', VerticalDatum: 'RH2000', Bounds: TRANSVERSE_MERCATOR_BOUNDS } }
      : {}),
  });
  expect(result.status, `the ${name} fixture must export`).toBe('exported');
  const path = join(mkdtempSync(join(tmpdir(), 'ifc-lite-landxml-conformance-')), `${name}.ifc`);
  writeFileSync(path, mutate(result.status === 'exported' ? result.content : ''));
  return path;
}

/** Run a tool; return [exit code, stdout]. Never throws on a non-zero exit. */
function run(script: string, args: string[]): [number, string] {
  try {
    return [0, execFileSync(PYTHON, [script, ...args], { encoding: 'utf8' })];
  } catch (error) {
    const failure = error as { status?: number; stdout?: string };
    return [failure.status ?? 1, failure.stdout ?? String(error)];
  }
}

describe.skipIf(!canRun)('LandXML→IFC4X3 output, checked by IfcOpenShell', () => {
  it('is schema-conformant: TIN, survey point, georeferencing and provenance', () => {
    const [code, stdout] = run(VALIDATE_SCRIPT, [writeConverted(TERRAIN_SOURCE, 'terrain')]);
    expect(stdout, stdout).toContain('0 issues');
    expect(code).toBe(0);
  }, TIMEOUT_MS);

  it('is schema-conformant: horizontal alignments with vertical profiles', () => {
    const [code, stdout] = run(VALIDATE_SCRIPT, [writeConverted(alignmentSource(), 'alignment')]);
    expect(stdout, stdout).toContain('0 issues');
    expect(code).toBe(0);
  }, TIMEOUT_MS);

  it('writes alignment geometry IfcOpenShell derives identically and lands on every authored point', () => {
    const [code, stdout] = run(ALIGNMENT_SCRIPT, [writeConverted(alignmentSource(), 'alignment'), ALIGNMENT_FIXTURE]);
    expect(stdout, stdout).toContain('3 alignment(s) checked, 0 problems');
    expect(code).toBe(0);
  }, TIMEOUT_MS);

  it('has teeth: a corrupted clothoid offset is caught by both the mapping and the evaluation check', () => {
    // Flip the sign of every non-zero clothoid SegmentStart — the exact fault
    // a sign slip in the offset formula produces. A checker that stays green
    // here proves nothing about the green run above.
    const corrupt = (step: string): string => step.replace(
      /(IFCCURVESEGMENT\([^,]+,#\d+,IFCLENGTHMEASURE\()(-?)(\d+\.\d*[1-9]\d*)(\))/g,
      (_all, head: string, minus: string, value: string, tail: string) => `${head}${minus ? '' : '-'}${value}${tail}`,
    );
    const path = writeConverted(alignmentSource(), 'alignment-corrupt', corrupt);
    expect(readFileSync(path, 'utf8'), 'the fault was actually injected').not.toBe(
      readFileSync(writeConverted(alignmentSource(), 'alignment-clean'), 'utf8'),
    );
    const [code, stdout] = run(ALIGNMENT_SCRIPT, [path, ALIGNMENT_FIXTURE]);
    expect(code, stdout).toBe(1);
    expect(stdout).toMatch(/SegmentStart .* != IfcOpenShell/);
    expect(stdout).toMatch(/from the authored/);
  }, TIMEOUT_MS);

  it('writes vertical geometry IfcOpenShell derives identically, and every authored height is on it (§12.7)', () => {
    const [code, stdout] = run(VERTICAL_SCRIPT, [writeConverted(alignmentSource(), 'vertical'), ALIGNMENT_FIXTURE]);
    expect(stdout, stdout).toContain('2 vertical layout(s) checked, 0 problems');
    expect(code).toBe(0);
  }, TIMEOUT_MS);

  it('has teeth: a flipped parabola coefficient is caught by the mapping and height checks', () => {
    // Negate every IfcPolynomialCurve's quadratic term: a crest written as a
    // sag. IfcOpenShell regenerates the coefficient from our (unchanged)
    // design parameters, and the evaluated heights leave the authored profile.
    const corrupt = (step: string): string => step.replace(
      /(IFCPOLYNOMIALCURVE\(#\d+,\(0\.,1\.\),\([^,]+,[^,]+,)(-?)([^)]+\))/g,
      (_all, head: string, minus: string, tail: string) => `${head}${minus ? '' : '-'}${tail}`,
    );
    // One export, before and after: two exports under different names always
    // differ (the name seeds GlobalIds), so comparing those could never fail.
    const clean = readFileSync(writeConverted(alignmentSource(), 'vertical-corrupt'), 'utf8');
    expect(corrupt(clean), 'the fault was actually injected').not.toBe(clean);
    const path = writeConverted(alignmentSource(), 'vertical-corrupt', corrupt);
    const [code, stdout] = run(VERTICAL_SCRIPT, [path, ALIGNMENT_FIXTURE]);
    expect(code, stdout).toBe(1);
    expect(stdout).toMatch(/IfcPolynomialCurve parameters .* != IfcOpenShell/);
    expect(stdout).toMatch(/the LandXML profile gives/);
  }, TIMEOUT_MS);

  it('does not pass vacuously: an authored profile missing from the file fails the vertical check', () => {
    const source = alignmentSource();
    const partial = { ...source, profiles: (source.profiles ?? []).slice(1) };
    const [code, stdout] = run(VERTICAL_SCRIPT, [writeConverted(partial, 'vertical-partial'), ALIGNMENT_FIXTURE]);
    expect(code, stdout).toBe(1);
    expect(stdout).toMatch(/authored profile of alignment '.+' is not in the file/);
  }, TIMEOUT_MS);

  it('refuses cant only while its premise holds: the pinned IfcOpenShell cannot regenerate cant geometry (§13.2)', () => {
    // The refusal rests on a measured fact about the oracle, so the fact is
    // measured here. If a pinned-version bump fixes IfcOpenShell's cant
    // mapping, this goes red: re-examine mapping spec §13.2, because cant
    // geometry may then be provable and the refusal no longer justified.
    const [code, stdout] = run(CANT_PROBE_SCRIPT, []);
    expect(code, stdout).toBe(0);
    const probe = JSON.parse(stdout) as {
      mirror_distinguished: boolean; centre_rotation_tilted: boolean; centre_linear_transition: string;
    };
    const premise = 'IfcOpenShell\'s cant mapping changed — revisit the cant refusal in mapping spec §13.2';
    expect(probe.mirror_distinguished, premise).toBe(false);
    expect(probe.centre_rotation_tilted, premise).toBe(false);
    expect(probe.centre_linear_transition, premise).toBe('ZeroDivisionError');

    // And the alignment carrying that cant is still written, horizontal only,
    // as a schema-conformant file.
    const source = alignmentSource();
    const [first, ...rest] = (source.alignments ?? []) as LandXmlIfcAlignment[];
    const withCant = {
      ...source,
      alignments: [{ ...first, cant: { name: 'Rail', gauge: 1.435 }, cantStations: [{ station: 0, appliedCant: 150 }] }, ...rest],
    };
    const path = writeConverted(withCant, 'alignment-with-cant');
    expect(readFileSync(path, 'utf8')).not.toMatch(/IFCALIGNMENTCANT|IFCSEGMENTEDREFERENCECURVE/);
    const [validCode, validOut] = run(VALIDATE_SCRIPT, [path]);
    expect(validOut, validOut).toContain('0 issues');
    expect(validCode).toBe(0);
  }, TIMEOUT_MS);

  it('does not pass vacuously: an authored alignment missing from the file fails the check', () => {
    // Before, only alignments IN the file were compared, and the count printed
    // was the authored one: a refused alignment read as "3 checked" (#5370 review).
    const source = alignmentSource();
    const partial = { ...source, alignments: (source.alignments ?? []).slice(1) };
    const [code, stdout] = run(ALIGNMENT_SCRIPT, [writeConverted(partial, 'alignment-partial'), ALIGNMENT_FIXTURE]);
    expect(code, stdout).toBe(1);
    expect(stdout).toMatch(/authored alignment '.+' is not in the file/);
  }, TIMEOUT_MS);

  it('writes station-equation referents IfcOpenShell reads back at their authored stations and points (§14)', () => {
    // 3 start referents + 4 station equations in the fixture. The expected
    // points are integrated by make_alignment_fixture.py, not by our mapping.
    const [code, stdout] = run(REFERENT_SCRIPT, [writeConverted(alignmentSource(), 'referents'), ALIGNMENT_FIXTURE]);
    expect(stdout, stdout).toContain('7 referent(s) checked, 0 problems');
    expect(code).toBe(0);
  }, TIMEOUT_MS);

  it('has teeth: a station-equation referent placed at the wrong distance is caught', () => {
    // Shift every non-zero DistanceAlong by 1 km: the start referents (0.)
    // stay put, every equation referent moves along the curve.
    const shift = (step: string): string => step.replace(
      /IFCPOINTBYDISTANCEEXPRESSION\(IFCLENGTHMEASURE\(([1-9]\d*\.\d*)\)/g,
      (_all, value: string) => `IFCPOINTBYDISTANCEEXPRESSION(IFCLENGTHMEASURE(${Number(value) + 1000}.)`,
    );
    const path = writeConverted(alignmentSource(), 'referents-shifted', shift);
    const [code, stdout] = run(REFERENT_SCRIPT, [path, ALIGNMENT_FIXTURE]);
    expect(code, stdout).toBe(1);
    expect(stdout).toMatch(/A-Left referent 2 \(station equation 1\): DistanceAlong 1200(\.0)? != authored 200/);
    expect(stdout).toMatch(/is \d+\.\d+ from the authored/);
  }, TIMEOUT_MS);
});
