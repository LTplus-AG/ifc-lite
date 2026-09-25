/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Schema-conformance check for the STEP/IFC writer, against IfcOpenShell (#4043).
 *
 * Every other fidelity test for this writer — `step-roundtrip.test.ts`,
 * `step-exporter.test.ts`, `schema-converter.test.ts` — is
 * `parse(write(x))` through `@ifc-lite/parser`, our own code reading its own
 * output. That is blind by construction to a mandatory STEP/EXPRESS
 * attribute our tolerant parser accepts but a strict engine rejects — the
 * exact shape of regression #1839 (a WHOLE number serialized into a
 * REAL-backed positional slot), which was only caught because someone ran
 * `ifcopenshell.validate` by hand once and never wired it in.
 *
 * This test re-exports two real third-party fixtures through `StepExporter`
 * (and, in its own block, an IFC4X3 set: see `IFC4X3_CONVERTED` and
 * `IFC4X3_ROUND_TRIP`, #5351) and shells out to `tools/ifcopenshell_reference/validate_export.py`, which
 * runs `ifcopenshell.validate.validate(file, logger, express_rules=True)` —
 * an external authority this codebase does not control. The two ORIGINAL
 * fixtures are validated too, as a control: if a fixture were itself
 * non-conformant, a real defect in ifc-lite's writer could hide behind it
 * (or an already-non-conformant input could be mistaken for a writer
 * defect). See `validate_export.py`'s own header for the vacuous-pass
 * refusals (zero files / missing file / ifcopenshell unavailable all fail,
 * never silently pass) and `test_validate_export.py` for the fault-injection
 * proof that the check itself has teeth.
 *
 * Requires a Python environment with `ifcopenshell` installed (see
 * `tools/ifcopenshell_reference/requirements.lock`, plus `pytest` for
 * `ifcopenshell.express.rule_executor`) — set `IFCOPENSHELL_PYTHON` to point
 * at it, or have it on `python3`. Wired in CI by
 * `.github/workflows/export-schema-conformance.yml`, gated on
 * `packages/export/**` changes so it doesn't run on every PR (see that
 * workflow's own header for the cost tradeoff). Locally, without that
 * environment, this SKIPS loudly (vitest reports it as skipped, not
 * passed) rather than passing vacuously.
 */

import { describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { IfcParser } from '@ifc-lite/parser';
import { StepExporter } from './step-exporter.js';
import { MergedExporter, type MergeModelInput } from './merged-exporter.js';

const MODELS_DIR = resolve(__dirname, '../../../tests/models');
const TOOL_DIR = resolve(__dirname, '../../../tools/ifcopenshell_reference');
const VALIDATE_SCRIPT = resolve(TOOL_DIR, 'validate_export.py');

const FIXTURES = ['ara3d/duplex.ifc', 'ara3d/IfcOpenHouse_IFC4.ifc'];

/**
 * IFC4X3 output (#5351). CONVERTED: IFC4 fixtures exported with
 * `schema: 'IFC4X3'`, where the writer chooses the `FILE_SCHEMA` token itself.
 * They carry the two entities whose layouts IfcOpenShell's development
 * `IFC4X3` schema changed (`IfcMapConversion`, `IfcTriangulatedFaceSet`), so a
 * bare `IFC4X3` token fails them. The two fixtures above cannot be converted
 * to IFC4X3 at all (`IfcPresentationStyleAssignment` has no IFC4X3
 * representation), hence these. ROUND_TRIP: IFC4X3_ADD2 fixtures re-exported
 * in their own schema, where the source token is kept.
 */
const IFC4X3_CONVERTED = ['buildingsmart/Building-Architecture.ifc', 'buildingsmart/tessellated-item.ifc'];
const IFC4X3_ROUND_TRIP = [
  'ifc5/Georeferencing_georeferenced-bridge-deck.ifc',
  'buildingsmart/annex_e/basic-geometric-shape/triangulated-item.ifc',
];
const IFC4X3_FIXTURES = [...IFC4X3_CONVERTED, ...IFC4X3_ROUND_TRIP];

const PYTHON = process.env.IFCOPENSHELL_PYTHON || 'python3';

function fixturesAvailable(fixtures: string[] = FIXTURES): boolean {
  return fixtures.every((f) => existsSync(resolve(MODELS_DIR, f)));
}

function ifcopenshellAvailable(): boolean {
  const result = spawnSync(PYTHON, ['-c', 'import ifcopenshell, ifcopenshell.validate'], {
    stdio: 'ignore',
  });
  return result.status === 0;
}

function toArrayBuffer(buf: Buffer): ArrayBuffer {
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}

async function reExport(name: string, outDir: string, schema?: 'IFC4X3'): Promise<string> {
  const parser = new IfcParser();
  const store = await parser.parseColumnar(toArrayBuffer(readFileSync(resolve(MODELS_DIR, name))));
  const result = new StepExporter(store).export({ schema: schema ?? store.schemaVersion });
  const outPath = join(outDir, name.replace(/\//g, '__'));
  writeFileSync(outPath, Buffer.from(result.content));
  return outPath;
}

/** duplex's text, a `#id` → GlobalId reader over it, and its IfcProject's `#id`. */
function readDuplex(): { text: string; guidOf: (id: string) => string; project: string } {
  const text = readFileSync(resolve(MODELS_DIR, 'ara3d/duplex.ifc'), 'latin1');
  const guidOf = (id: string) => new RegExp(`^${id}=IFC\\w+\\('([^']{22})'`, 'm').exec(text)![1];
  return { text, guidOf, project: /^(#\d+)=IFCPROJECT\(/m.exec(text)![1] };
}

/**
 * Lines #1-#11 of a small IFC2X3 model to merge into duplex: an owner history
 * (#5), metre units, a model context, and duplex's IfcProject by GlobalId (#11),
 * so the model unifies into duplex's project.
 */
const IFC2X3_PREAMBLE = (projectGuid: string): string[] => [
  "#1=IFCPERSON($,$,'author',$,$,$,$,$);", "#2=IFCORGANIZATION($,'author',$,$,$);",
  '#3=IFCPERSONANDORGANIZATION(#1,#2,$);', "#4=IFCAPPLICATION(#2,'1','author','author');",
  '#5=IFCOWNERHISTORY(#3,#4,$,.NOCHANGE.,$,$,$,0);', '#6=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);',
  '#7=IFCUNITASSIGNMENT((#6));', '#8=IFCCARTESIANPOINT((0.,0.,0.));', '#9=IFCAXIS2PLACEMENT3D(#8,$,$);',
  "#10=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-009,#9,$);",
  `#11=IFCPROJECT('${projectGuid}',#5,'0001',$,$,$,$,(#10),#7);`,
];

/** Merge duplex (primary) with an IFC2X3 model of `lines`, as IFC2X3. */
async function mergeWithDuplex(duplexText: string, name: string, lines: string[]): Promise<string> {
  const second = [
    'ISO-10303-21;', 'HEADER;', "FILE_DESCRIPTION(('ViewDefinition [CoordinationView]'),'2;1');",
    `FILE_NAME('${name}.ifc','2026-01-01T00:00:00',(''),(''),'t','t','');`, "FILE_SCHEMA(('IFC2X3'));",
    'ENDSEC;', 'DATA;', ...lines, 'ENDSEC;', 'END-ISO-10303-21;',
  ].join('\n');
  const parser = new IfcParser();
  const models: MergeModelInput[] = [];
  for (const [id, bytes] of [['duplex', Buffer.from(duplexText, 'latin1')], [name, Buffer.from(second)]] as const) {
    models.push({ id, name: id, dataStore: await parser.parseColumnar(toArrayBuffer(bytes)) });
  }
  return new TextDecoder().decode(new MergedExporter(models).export({ schema: 'IFC2X3' }).content);
}

/** Write a merged output to a fresh temp dir; returns its path. */
function writeMerged(content: string, tag: string): string {
  const out = join(mkdtempSync(join(tmpdir(), `ifc-lite-export-conformance-${tag}-`)), 'merged.ifc');
  writeFileSync(out, content);
  return out;
}

const canRun = fixturesAvailable() && ifcopenshellAvailable();
if (!canRun) {
  console.warn(
    '[ifcopenshell-schema-conformance] SKIPPED: ' +
      (!fixturesAvailable()
        ? 'fixtures missing — run `pnpm fixtures`.'
        : `ifcopenshell not importable via "${PYTHON}" — set IFCOPENSHELL_PYTHON or install ` +
          'tools/ifcopenshell_reference/requirements.lock (+ pytest).'),
  );
}

// Each test below shells out to a cold Python process that imports
// ifcopenshell.validate (which in turn imports ifcopenshell.express's
// rule_executor, and through it pytest's assertion rewriter — see
// validate_export.py's header) before it can check a single entity. That
// import chain, plus running express_rules=True over two real fixtures, is
// consistently 3-4s locally and measured at 7.5-7.6s on GitHub's shared
// runners — comfortably over vitest's 5000ms default. It is not repeated
// or wasted work (each test validates a different input: the original
// fixtures as a control vs. this branch's StepExporter re-export), so the
// fix is a longer timeout on these two tests specifically, not a smaller
// one elsewhere.
const IFCOPENSHELL_TEST_TIMEOUT_MS = 20_000;

describe.skipIf(!canRun)('StepExporter output is schema-conformant per IfcOpenShell', () => {
  it(
    'validates the ORIGINAL fixtures as a control (a non-conformant input must not masquerade as a writer defect)',
    () => {
      const inputs = FIXTURES.map((f) => resolve(MODELS_DIR, f));
      expect(inputs.length).toBeGreaterThan(0);
      runValidateOrThrow(inputs);
    },
    IFCOPENSHELL_TEST_TIMEOUT_MS,
  );

  it(
    'validates the full-fidelity StepExporter re-export of both fixtures',
    async () => {
      const outDir = mkdtempSync(join(tmpdir(), 'ifc-lite-export-conformance-'));
      const outputs: string[] = [];
      for (const fixture of FIXTURES) {
        outputs.push(await reExport(fixture, outDir));
      }
      expect(outputs.length).toBe(FIXTURES.length);
      runValidateOrThrow(outputs);
    },
    IFCOPENSHELL_TEST_TIMEOUT_MS,
  );

  it(
    'validates an IFC2X3 MergedExporter output that unifies a nested object (#5726)',
    async () => {
      // duplex aggregates each stair's flight and two stringers (IfcMember)
      // under the stair. The second model repeats the stringers by GlobalId
      // (so both unify onto duplex's) and NESTS one under the other, which is
      // valid on its own (IfcRelNests.WR1: same type). In IFC2X3 IfcRelNests
      // and IfcRelAggregates both fill IfcObjectDefinition.Decomposes,
      // SET [0:1], so writing that nest gives the stringer a second parent.
      const { text, guidOf, project } = readDuplex();
      const stair = /^(#\d+)=IFCSTAIR\(/m.exec(text)![1];
      const [, , first, second] = new RegExp(`^#\\d+=IFCRELAGGREGATES\\([^;]*,${stair},\\((#\\d+),(#\\d+),(#\\d+)[,)]`, 'm').exec(text)!;
      for (const stringer of [first, second]) expect(new RegExp(`^${stringer}=IFCMEMBER\\(`, 'm').test(text)).toBe(true);
      const detailing = [
        ...IFC2X3_PREAMBLE(guidOf(project)),
        `#12=IFCMEMBER('${guidOf(first)}',#5,'Stringer 1',$,$,$,$,$);`,
        `#13=IFCMEMBER('${guidOf(second)}',#5,'Stringer 2',$,$,$,$,$);`,
        "#14=IFCRELNESTS('3Nest5726Stringer00000',#5,$,$,#13,(#12));",
      ];
      runValidateOrThrow([writeMerged(await mergeWithDuplex(text, 'detailing', detailing), '5726')]);
    },
    IFCOPENSHELL_TEST_TIMEOUT_MS,
  );

  it(
    'validates an IFC2X3 MergedExporter output that unifies a property set by GlobalId (#5774)',
    async () => {
      // The second model repeats one of duplex's property sets and the object
      // it defines by GlobalId, and defines an object of its own with it too.
      // IFC2X3 bounds `IfcPropertySetDefinition.PropertyDefinitionOf` to one
      // IfcRelDefinesByProperties, so writing the second model's rel gave the
      // unified property set two; its new object is folded into duplex's rel.
      const { text, guidOf, project } = readDuplex();
      const [, object, pset] = /^#\d+=IFCRELDEFINESBYPROPERTIES\([^;]*,\((#\d+)\),(#\d+)\);/m.exec(text)!;
      const second = [
        ...IFC2X3_PREAMBLE(guidOf(project)),
        `#12=IFCBUILDINGELEMENTPROXY('${guidOf(object)}',#5,'Repeated',$,$,$,$,$,$);`,
        "#13=IFCBUILDINGELEMENTPROXY('3New5774ProxyObject000',#5,'New',$,$,$,$,$,$);",
        "#14=IFCPROPERTYSINGLEVALUE('Reference',$,IFCIDENTIFIER('R'),$);",
        `#15=IFCPROPERTYSET('${guidOf(pset)}',#5,'Pset_Repeated',$,(#14));`,
        "#16=IFCRELDEFINESBYPROPERTIES('3Rel5774DefinesByProp0',#5,$,$,(#12,#13),#15);",
      ];
      const merged = await mergeWithDuplex(text, 'properties', second);
      runValidateOrThrow([writeMerged(merged, '5774')]);
      expect(merged).not.toContain('3Rel5774DefinesByProp0');
    },
    IFCOPENSHELL_TEST_TIMEOUT_MS,
  );
});

const canRunIfc4x3 = fixturesAvailable(IFC4X3_FIXTURES) && ifcopenshellAvailable();
if (!canRunIfc4x3) {
  console.warn('[ifcopenshell-schema-conformance] IFC4X3 block SKIPPED: fixtures missing (run `pnpm fixtures`) or ifcopenshell unavailable.');
}

describe.skipIf(!canRunIfc4x3)('StepExporter IFC4X3 output is schema-conformant per IfcOpenShell (#5351)', () => {
  it(
    'validates the ORIGINAL IFC4X3 fixtures as a control',
    () => {
      runValidateOrThrow(IFC4X3_FIXTURES.map((f) => resolve(MODELS_DIR, f)));
    },
    IFCOPENSHELL_TEST_TIMEOUT_MS,
  );

  it(
    'validates IFC4 fixtures converted to IFC4X3, declared as IFC4X3_ADD2',
    async () => {
      const outDir = mkdtempSync(join(tmpdir(), 'ifc-lite-export-conformance-4x3-'));
      const outputs: string[] = [];
      for (const fixture of IFC4X3_CONVERTED) {
        const out = await reExport(fixture, outDir, 'IFC4X3');
        expect(readFileSync(out, 'utf8')).toContain("FILE_SCHEMA(('IFC4X3_ADD2'));");
        outputs.push(out);
      }
      runValidateOrThrow(outputs);
    },
    IFCOPENSHELL_TEST_TIMEOUT_MS,
  );

  it(
    'control: the same converted bytes declared as bare IFC4X3 fail, so the identifier is what makes the difference',
    async () => {
      const outDir = mkdtempSync(join(tmpdir(), 'ifc-lite-export-conformance-4x3-bare-'));
      for (const fixture of IFC4X3_CONVERTED) {
        const out = await reExport(fixture, outDir, 'IFC4X3');
        const bare = readFileSync(out, 'utf8').replace("FILE_SCHEMA(('IFC4X3_ADD2'));", "FILE_SCHEMA(('IFC4X3'));");
        expect(bare).toContain("FILE_SCHEMA(('IFC4X3'));");
        writeFileSync(out, bare);
        const run = spawnSync(PYTHON, [VALIDATE_SCRIPT, out], { encoding: 'utf8' });
        expect(run.status, `${fixture} validated under the bare IFC4X3 token:\n${run.stdout}`).not.toBe(0);
      }
    },
    IFCOPENSHELL_TEST_TIMEOUT_MS,
  );

  it(
    'validates the MergedExporter output of the two converted fixtures, as IFC4 and IFC4X3 (#5471)',
    async () => {
      // Building-Architecture aggregates its Building under a Site;
      // tessellated-item aggregates its Building straight under the Project.
      // The Buildings unify, and the merge used to give the result both
      // parents, failing IfcSpatialStructureElement.WR41.
      const parser = new IfcParser();
      const models: MergeModelInput[] = [];
      for (const fixture of IFC4X3_CONVERTED) {
        const buffer = toArrayBuffer(readFileSync(resolve(MODELS_DIR, fixture)));
        models.push({ id: fixture, name: fixture, dataStore: await parser.parseColumnar(buffer) });
      }
      const outDir = mkdtempSync(join(tmpdir(), 'ifc-lite-export-conformance-merged-'));
      const outputs = (['IFC4', 'IFC4X3'] as const).map((schema) => {
        const out = join(outDir, `merged-${schema}.ifc`);
        writeFileSync(out, Buffer.from(new MergedExporter(models).export({ schema }).content));
        return out;
      });
      runValidateOrThrow(outputs);
    },
    IFCOPENSHELL_TEST_TIMEOUT_MS,
  );

  it(
    'validates the round-trip re-export of IFC4X3_ADD2 fixtures',
    async () => {
      const outDir = mkdtempSync(join(tmpdir(), 'ifc-lite-export-conformance-4x3-rt-'));
      const outputs: string[] = [];
      for (const fixture of IFC4X3_ROUND_TRIP) {
        outputs.push(await reExport(fixture, outDir));
      }
      runValidateOrThrow(outputs);
    },
    IFCOPENSHELL_TEST_TIMEOUT_MS,
  );
});

/**
 * #5470: IfcOpenShell/Bonsai write FILE_NAME's author and organization as `$`,
 * which is itself invalid for a LIST [1:?], and a re-export used to turn it
 * into `()`, still invalid. The fixture's header is its ONLY defect, so the
 * control pins exactly that and the re-export must come back clean.
 */
const UNSET_AUTHOR_FIXTURE = 'ifc5/Hello_Wall_hello-wall.ifc';
const canRunUnsetAuthor = fixturesAvailable([UNSET_AUTHOR_FIXTURE]) && ifcopenshellAvailable();

describe.skipIf(!canRunUnsetAuthor)('StepExporter re-export of a `$` FILE_NAME author/organization (#5470)', () => {
  it(
    'writes the (\'\') default, and the re-export validates with 0 issues',
    async () => {
      const source = resolve(MODELS_DIR, UNSET_AUTHOR_FIXTURE);
      expect(readFileSync(source, 'utf8')).toMatch(/FILE_NAME\('[^']*','[^']*',\$,\$,/);
      const control = spawnSync(PYTHON, [VALIDATE_SCRIPT, source], { encoding: 'utf8' });
      expect(control.stdout, 'control: the source fails on its header, and only there').toContain(
        ': 2 schema-conformance issue(s)',
      );
      expect(control.stdout).toContain("Attribute 'author' has invalid type");
      expect(control.stdout).toContain("Attribute 'organization' has invalid type");

      const out = await reExport(UNSET_AUTHOR_FIXTURE, mkdtempSync(join(tmpdir(), 'ifc-lite-export-5470-')));
      expect(readFileSync(out, 'utf8')).toMatch(/FILE_NAME\('[^']*','[^']*',\(''\),\(''\),/);
      runValidateOrThrow([out]);
    },
    IFCOPENSHELL_TEST_TIMEOUT_MS,
  );
});

/**
 * Runs validate_export.py and turns a failure into a vitest assertion that
 * carries the script's own stdout — the offending entity and rule — rather
 * than a bare non-zero exit code.
 */
function runValidateOrThrow(files: string[]): void {
  expect(files.length, 'refuse to validate zero files').toBeGreaterThan(0);
  try {
    const stdout = execFileSync(PYTHON, [VALIDATE_SCRIPT, ...files], { encoding: 'utf8' });
    expect(stdout).toContain('0 issues');
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    throw new Error(
      `ifcopenshell schema-conformance check failed:\n${e.stdout ?? ''}\n${e.stderr ?? e.message ?? ''}`,
    );
  }
}
