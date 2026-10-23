/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #7600 — IFC terrain → LandXML, graded by two authorities this codebase does
 * not control, plus a full round trip through both of the viewer's directions.
 *
 * 1. The official LandXML 1.2 XSD (vendored verbatim in
 *    `__fixtures__/landxml-1.2/`, hash-checked below), run through
 *    `xmllint-wasm` — libxml2 compiled to WebAssembly, the same validator the
 *    BCF package uses. A negative control proves the validator rejects what
 *    the schema forbids, so a "valid" here is a verdict, not a no-op.
 * 2. An independent oracle for the coordinates: a small STEP reader in this
 *    file resolves each terrain's `IfcLocalPlacement` chain and applies the
 *    `IfcMapConversion` formula in TypeScript. It shares no code with the Rust
 *    producer, so the two agreeing is evidence, not an echo.
 *
 * The round trip is IFC → LandXML (the wasm producer, through the viewer's
 * `runLandXmlTerrainExport`) → IFC (the viewer's own LandXML import and its
 * LandXML→IFC4X3 download, `downloadLandXmlAsIfc`) → LandXML again. The two
 * LandXML documents must carry the same surfaces, the same `<P>` text and the
 * same `<F>` triples. That comparison is EXACT, not toleranced: the producer
 * writes six decimals, the importer reads them into the nearest f64, the
 * LandXML→IFC writer prints that f64 in its shortest round-trip form, and the
 * second leg's map conversion is the identity (zero offsets, no rotation, unit
 * scale), so nothing is left to drift. A tolerance would hide exactly the
 * one-micrometre creep this test exists to catch. The oracle comparison against
 * the source IFC is toleranced at 1e-6 m because the producer rounds to 1e-6 m
 * (half of that is the most rounding can move a value).
 *
 * Needs the wasm runtime (`pnpm build:wasm`) and, for the bonsai-topo control,
 * `pnpm fixtures`. Each test SKIPS without its dependency — reported skipped,
 * never passed.
 */

import '@/test/setup-dom.js';
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { validateXML } from 'xmllint-wasm';
import { downloadLandXmlAsIfc } from './landXmlIfcDownload.js';
import { runLandXmlTerrainExport } from './landXmlTerrainExport.js';
import { parseLandXmlSourceInCurrentRealm } from '@/hooks/ingest/landXmlWasm.js';

const ROOT = new URL('../../../../../', import.meta.url);
const WASM = new URL('packages/wasm/pkg/ifc-lite_bg.wasm', ROOT);
const BONSAI_IFC = new URL('tests/models/landxml/federation/bonsai-topo-control-v1/terrain.ifc', ROOT);
const BONSAI_XML = new URL('tests/models/landxml/federation/bonsai-topo-control-v1/terrain.xml', ROOT);
const SAMPLE_TIN = new URL('apps/viewer/public/samples/terrain-tin-metric.xml', ROOT);
const XSD = new URL('./__fixtures__/landxml-1.2/LandXML-1.2.xsd', import.meta.url);
/** The hash recorded in `__fixtures__/landxml-1.2/README.md`. */
const XSD_SHA256 = 'f4f732341970a923943f94592a3fde0838534515d564a699761e85420fad4d77';

const HAS_WASM = existsSync(WASM);
const HAS_BONSAI = existsSync(BONSAI_IFC) && existsSync(BONSAI_XML);
const NEEDS_WASM = HAS_WASM ? false : 'needs the wasm runtime: run pnpm build:wasm';
const NEEDS_BONSAI = !HAS_WASM ? NEEDS_WASM : HAS_BONSAI ? false : 'needs the bonsai-topo-control-v1 fixture: run pnpm fixtures';
const NOW = new Date('2026-10-14T12:34:56Z');

before(async () => {
  if (!HAS_WASM) return;
  const { default: init } = await import('@ifc-lite/wasm');
  await init({ module_or_path: await readFile(WASM) });
});

// ─── The authority ───────────────────────────────────────────────────────────

let xsdText: string | null = null;
async function schemaErrors(xml: string): Promise<string[]> {
  xsdText ??= await readFile(XSD, 'utf8');
  const result = await validateXML({ xml: [{ fileName: 'subject.xml', contents: xml }], schema: [xsdText] });
  return result.valid ? [] : result.errors.map((error) => error.message);
}

async function assertSchemaValid(xml: string, label: string): Promise<void> {
  assert.deepEqual(await schemaErrors(xml), [], `${label} must validate against the LandXML 1.2 XSD`);
}

// ─── A STEP reader for the oracle (independent of the Rust producer) ────────

type Vec3 = [number, number, number];
interface Frame { origin: Vec3; x: Vec3; y: Vec3; z: Vec3 }
interface OracleSurface { productId: number; name: string; points: Vec3[]; faces: Array<[number, number, number]> }

/** Split a STEP argument list on its top-level commas. */
function splitArgs(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quoted = false;
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (c === "'") quoted = !quoted; // `''` toggles twice: an escaped quote stays inside
    else if (!quoted && c === '(') depth += 1;
    else if (!quoted && c === ')') depth -= 1;
    else if (!quoted && depth === 0 && c === ',') { out.push(text.slice(start, i)); start = i + 1; }
  }
  out.push(text.slice(start));
  return out.map((part) => part.trim());
}

const list = (arg: string): string[] => {
  assert.match(arg, /^\(.*\)$/s, `expected a STEP list, got ${arg}`);
  return splitArgs(arg.slice(1, -1));
};
const ref = (arg: string): number => {
  assert.match(arg, /^#\d+$/, `expected a reference, got ${arg}`);
  return Number(arg.slice(1));
};
const real = (arg: string): number => {
  const value = Number(arg);
  assert.ok(Number.isFinite(value), `expected a number, got ${arg}`);
  return value;
};
const stepString = (arg: string): string => arg.slice(1, -1).replace(/''/g, "'");

class Step {
  readonly entities = new Map<number, { type: string; args: string[] }>();
  constructor(text: string) {
    for (const match of text.matchAll(/^#(\d+)\s*=\s*([A-Z0-9_]+)\((.*)\);\s*$/gm)) {
      this.entities.set(Number(match[1]), { type: match[2], args: splitArgs(match[3]) });
    }
  }
  get(id: number, type?: string): string[] {
    const entity = this.entities.get(id);
    assert.ok(entity, `#${id} does not exist`);
    if (type) assert.equal(entity.type, type, `#${id}`);
    return entity.args;
  }
  ids(type: string): number[] {
    return [...this.entities].filter(([, entity]) => entity.type === type).map(([id]) => id);
  }
}

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (a: Vec3): Vec3 => scale(a, 1 / Math.hypot(...a));
const apply = (f: Frame, p: Vec3): Vec3 => [0, 1, 2].map((i) => f.origin[i] + f.x[i] * p[0] + f.y[i] * p[1] + f.z[i] * p[2]) as Vec3;

function direction(step: Step, arg: string, fallback: Vec3): Vec3 {
  return arg === '$' ? fallback : list(step.get(ref(arg), 'IFCDIRECTION')[0]).map(real) as Vec3;
}

/** IfcAxis2Placement3D, per its definition: Z from Axis, X from RefDirection projected off Z. */
function axisPlacement(step: Step, id: number): Frame {
  const [location, axis, refDirection] = step.get(id, 'IFCAXIS2PLACEMENT3D');
  const origin = list(step.get(ref(location), 'IFCCARTESIANPOINT')[0]).map(real) as Vec3;
  const z = unit(direction(step, axis, [0, 0, 1]));
  const r = direction(step, refDirection, [1, 0, 0]);
  const x = unit(sub(r, scale(z, dot(r, z))));
  return { origin, x, y: cross(z, x), z };
}

/** The world frame of an IfcLocalPlacement chain. */
function placement(step: Step, id: number): Frame {
  const [relativeTo, relative] = step.get(id, 'IFCLOCALPLACEMENT');
  const local = axisPlacement(step, ref(relative));
  if (relativeTo === '$') return local;
  const parent = placement(step, ref(relativeTo));
  const o = apply(parent, [0, 0, 0]);
  return {
    origin: apply(parent, local.origin),
    x: sub(apply(parent, local.x), o), y: sub(apply(parent, local.y), o), z: sub(apply(parent, local.z), o),
  };
}

/**
 * Every terrain in `ifc`, in map metres as `[northing, easting, elevation]`,
 * by the IFC4X3 `IfcMapConversion` definition: E = Eastings + s(a·x − b·y),
 * N = Northings + s(b·x + a·y), H = OrthogonalHeight + z, with (a, b) the
 * normalised X axis. The sources here all use Scale 1 in a metre project, so
 * whether Scale also applies to z cannot move a value; the oracle asserts that
 * rather than taking a side on it.
 */
function oracle(ifc: string, productIds: readonly number[]): OracleSurface[] {
  const step = new Step(ifc);
  assert.deepEqual(
    step.ids('IFCSIUNIT').filter((id) => step.get(id)[1] === '.LENGTHUNIT.').map((id) => step.get(id).join(',')),
    ['*,.LENGTHUNIT.,$,.METRE.'], 'the oracle assumes a metre project',
  );
  const [conversion] = step.ids('IFCMAPCONVERSION');
  assert.equal(step.ids('IFCMAPCONVERSION').length, 1, 'one IfcMapConversion');
  const [, , eastings, northings, height, abscissa, ordinate, mapScale] = step.get(conversion);
  assert.ok(mapScale === '$' || real(mapScale) === 1, 'the oracle assumes Scale 1');
  const [a0, b0] = [abscissa === '$' ? 1 : real(abscissa), ordinate === '$' ? 0 : real(ordinate)];
  const [a, b] = [a0 / Math.hypot(a0, b0), b0 / Math.hypot(a0, b0)];
  const [e0, n0, h0] = [real(eastings), real(northings), real(height)];
  const toMap = ([x, y, z]: Vec3): Vec3 => [n0 + b * x + a * y, e0 + a * x - b * y, h0 + z];

  return productIds.map((productId) => {
    const product = step.get(productId, 'IFCGEOGRAPHICELEMENT');
    const frame = placement(step, ref(product[5]));
    const representations = list(step.get(ref(product[6]), 'IFCPRODUCTDEFINITIONSHAPE')[2]);
    const items = representations.flatMap((rep) => list(step.get(ref(rep), 'IFCSHAPEREPRESENTATION')[3]).map(ref));
    const faceSets = items.filter((id) => /^IFCTRIANGULATED(FACESET|IRREGULARNETWORK)$/.test(step.entities.get(id)?.type ?? ''));
    assert.equal(faceSets.length, 1, `#${productId} has one triangulated body`);
    const faceSet = step.get(faceSets[0]);
    const coordinates = list(step.get(ref(faceSet[0]), 'IFCCARTESIANPOINTLIST3D')[0]).map((p) => list(p).map(real) as Vec3);
    const vertices = faceSet[4] === '$' ? coordinates : list(faceSet[4]).map((index) => coordinates[real(index) - 1]);
    return {
      productId,
      name: stepString(product[2]),
      points: vertices.map((vertex) => toMap(apply(frame, vertex))),
      faces: list(faceSet[3]).map((face) => list(face).map(real) as [number, number, number]),
    };
  });
}

// ─── The LandXML this producer writes, read back for comparison ─────────────

interface LandXmlSurface { name: string; definition: string; points: Array<{ id: string; text: string }>; faces: string[] }
interface LandXmlRead { coordinateSystem: string; surfaces: LandXmlSurface[] }

function readLandXml(xml: string): LandXmlRead {
  const coordinateSystem = /<CoordinateSystem [^>]*\/>/.exec(xml)?.[0] ?? '';
  const surfaces = [...xml.matchAll(/<Surface name="([^"]*)"[^>]*>([\s\S]*?)<\/Surface>/g)].map(([, name, body]) => ({
    name,
    definition: /<Definition [^>]*>/.exec(body)?.[0] ?? '',
    points: [...body.matchAll(/<P id="([^"]+)">([^<]*)<\/P>/g)].map(([, id, text]) => ({ id, text })),
    faces: [...body.matchAll(/<F>([^<]*)<\/F>/g)].map(([, face]) => face),
  }));
  return { coordinateSystem, surfaces };
}

function assertMatchesOracle(xml: string, expected: OracleSurface[], label: string): void {
  const read = readLandXml(xml);
  assert.equal(read.surfaces.length, expected.length, `${label}: one <Surface> per product`);
  read.surfaces.forEach((surface, s) => {
    const want = expected[s];
    assert.equal(surface.points.length, want.points.length, `${label} surface ${s}: point count`);
    surface.points.forEach((point, i) => {
      assert.equal(point.id, String(i + 1), `${label} surface ${s}: point ids are the authored vertex order`);
      const got = point.text.split(' ').map(Number);
      want.points[i].forEach((value, axis) => {
        assert.ok(Math.abs(got[axis] - value) <= 1e-6,
          `${label} surface ${s} point ${i + 1} axis ${'NEZ'[axis]}: ${got[axis]} vs oracle ${value}`);
      });
    });
    assert.deepEqual(surface.faces, want.faces.map((face) => face.join(' ')), `${label} surface ${s}: faces are CoordIndex as authored`);
  });
}

// ─── The viewer's two directions ────────────────────────────────────────────

async function exportTerrain(ifc: string, productIds: readonly number[]) {
  const outcome = await runLandXmlTerrainExport(new TextEncoder().encode(ifc), productIds, undefined, { now: NOW });
  assert.equal(outcome.status, 'ready', `the producer accepted the selection: ${JSON.stringify(outcome)}`);
  return (outcome as Extract<typeof outcome, { status: 'ready' }>).result;
}

/** Record what `downloadLandXmlAsIfc` hands the browser, at the two seams `downloadBlob` uses. */
async function landXmlToIfcThroughViewer(xml: string, name: string): Promise<string> {
  const document = await parseLandXmlSourceInCurrentRealm(new TextEncoder().encode(xml).buffer);
  const originalCreate = URL.createObjectURL;
  const originalRevoke = URL.revokeObjectURL;
  const originalClick = HTMLAnchorElement.prototype.click;
  let blob: Blob | undefined;
  URL.createObjectURL = ((value: Blob) => { blob = value; return 'blob:landxml-terrain-round-trip'; }) as typeof URL.createObjectURL;
  URL.revokeObjectURL = (() => {}) as typeof URL.revokeObjectURL;
  HTMLAnchorElement.prototype.click = function () {};
  try {
    const result = await downloadLandXmlAsIfc({ document, name });
    assert.equal(result.status, 'exported', `the viewer converted the LandXML: ${JSON.stringify(result)}`);
  } finally {
    URL.createObjectURL = originalCreate;
    URL.revokeObjectURL = originalRevoke;
    HTMLAnchorElement.prototype.click = originalClick;
  }
  assert.ok(blob, 'an IFC file was offered for download');
  return blob.text();
}

const geographicElements = (ifc: string): number[] => [...ifc.matchAll(/^#(\d+)=IFCGEOGRAPHICELEMENT\(/gm)].map((m) => Number(m[1]));

/**
 * IFC → LandXML → IFC → LandXML. Asserts the first LandXML against the
 * oracle of `ifc`, the second against the oracle of the re-imported IFC, and
 * the two LandXML documents against each other, exactly.
 */
async function assertRoundTrip(ifc: string, productIds: readonly number[], label: string) {
  const first = await exportTerrain(ifc, productIds);
  await assertSchemaValid(first.xml, `${label}: first export`);
  assertMatchesOracle(first.xml, oracle(ifc, productIds), `${label}: IFC → LandXML`);

  const reimported = await landXmlToIfcThroughViewer(first.xml, `${label}.xml`);
  const reimportedIds = geographicElements(reimported);
  assert.equal(reimportedIds.length, productIds.length, `${label}: every surface came back as one IfcGeographicElement`);
  const second = await exportTerrain(reimported, reimportedIds);
  await assertSchemaValid(second.xml, `${label}: second export`);
  assertMatchesOracle(second.xml, oracle(reimported, reimportedIds), `${label}: re-imported IFC → LandXML`);

  const [a, b] = [readLandXml(first.xml), readLandXml(second.xml)];
  assert.equal(second.crsName, first.crsName, `${label}: the CRS survives`);
  // #7604: the whole record, not only the name — a datum renamed into the
  // name, or a name dropped for the datum, fails here.
  assert.equal(b.coordinateSystem, a.coordinateSystem, `${label}: the <CoordinateSystem> record survives`);
  assert.equal(b.surfaces.length, a.surfaces.length, `${label}: surface count`);
  a.surfaces.forEach((surface, s) => {
    const again = b.surfaces[s];
    assert.equal(again.name, surface.name, `${label} surface ${s}: name`);
    assert.equal(again.definition, surface.definition, `${label} surface ${s}: surfType and elevation range`);
    assert.deepEqual(again.points, surface.points, `${label} surface ${s}: every <P>, exactly`);
    assert.deepEqual(again.faces, surface.faces, `${label} surface ${s}: every <F>, exactly`);
  });
  return { first, second, reimported };
}

// ─── Sources ────────────────────────────────────────────────────────────────

/**
 * Three terrains, hand-authored so every transform step does something: a
 * rotated map conversion (X axis 0.8/0.6), one placement rotated 90° and
 * translated, one surface reaching its vertices through PnIndex, one written
 * as an `IfcTriangulatedIrregularNetwork` with all-zero Flags, and names that
 * need XML escaping — two of them identical, which `uSrfName` forbids.
 */
const SYNTHETIC_IFC = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('ViewDefinition [ReferenceView]'),'2;1');
FILE_NAME('synthetic-terrain.ifc','2026-10-14T00:00:00',('ifc-lite'),(''),'Synthetic test source','','');
FILE_SCHEMA(('IFC4X3_ADD2'));
ENDSEC;
DATA;
#1=IFCPROJECT('0RoundTripSynthetic001',$,'Escaping & <round trip> "project"',$,$,$,$,(#5),#8);
#2=IFCCARTESIANPOINT((0.,0.,0.));
#3=IFCAXIS2PLACEMENT3D(#2,$,$);
#4=IFCDIRECTION((0.,1.));
#5=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-5,#3,#4);
#6=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#7=IFCSIUNIT(*,.PLANEANGLEUNIT.,$,.RADIAN.);
#8=IFCUNITASSIGNMENT((#6,#7));
#9=IFCLOCALPLACEMENT($,#3);
#10=IFCSITE('0RoundTripSynthetic002',$,'Site',$,$,#9,$,$,$,$,$,$,$,$);
#11=IFCRELAGGREGATES('0RoundTripSynthetic003',$,$,$,#1,(#10));
#12=IFCPROJECTEDCRS('EPSG:2056','CH1903+ / LV95','CH1903+','LN02',$,$,#6);
#13=IFCMAPCONVERSION(#5,#12,2600000.,1200000.,400.,0.8,0.6,1.);
#20=IFCCARTESIANPOINT((15.,-7.5,2.25));
#21=IFCDIRECTION((0.,0.,1.));
#22=IFCDIRECTION((0.,1.,0.));
#23=IFCAXIS2PLACEMENT3D(#20,#21,#22);
#24=IFCLOCALPLACEMENT(#9,#23);
#25=IFCCARTESIANPOINTLIST3D(((0.,0.,0.),(12.,0.,0.5),(0.,9.,1.25),(12.,9.,1.75),(6.,4.5,0.875)));
#26=IFCTRIANGULATEDFACESET(#25,$,.F.,((1,2,5),(2,4,5),(4,3,5),(3,1,5)),$);
#27=IFCSHAPEREPRESENTATION(#5,'Body','Tessellation',(#26));
#28=IFCPRODUCTDEFINITIONSHAPE($,$,(#27));
#29=IFCGEOGRAPHICELEMENT('0RoundTripSynthetic004',$,'Ground & <hill>',$,$,#24,#28,$,.TERRAIN.);
#30=IFCCARTESIANPOINTLIST3D(((100.,100.,3.),(110.,100.,3.5),(100.,112.,4.),(110.,112.,4.5),(999.,999.,999.)));
#31=IFCTRIANGULATEDFACESET(#30,$,.F.,((1,2,3),(2,4,3)),(2,1,4,3));
#32=IFCSHAPEREPRESENTATION(#5,'Body','Tessellation',(#31));
#33=IFCPRODUCTDEFINITIONSHAPE($,$,(#32));
#34=IFCGEOGRAPHICELEMENT('0RoundTripSynthetic005',$,'Ground & <hill>',$,$,#9,#33,$,.TERRAIN.);
#40=IFCCARTESIANPOINT((0.,0.,-1.5));
#41=IFCAXIS2PLACEMENT3D(#40,$,$);
#42=IFCLOCALPLACEMENT(#9,#41);
#43=IFCCARTESIANPOINTLIST3D(((-20.,-20.,0.),(-10.,-20.,1.),(-20.,-10.,2.),(-10.,-10.,3.)));
#44=IFCTRIANGULATEDIRREGULARNETWORK(#43,$,.F.,((1,2,3),(2,4,3)),$,(0,0));
#45=IFCSHAPEREPRESENTATION(#5,'Body','Tessellation',(#44));
#46=IFCPRODUCTDEFINITIONSHAPE($,$,(#45));
#47=IFCGEOGRAPHICELEMENT('0RoundTripSynthetic006',$,'O''Brien "knoll"',$,$,#42,#46,$,.TERRAIN.);
#50=IFCRELCONTAINEDINSPATIALSTRUCTURE('0RoundTripSynthetic007',$,$,$,(#29,#34,#47),#10);
ENDSEC;
END-ISO-10303-21;
`;
const SYNTHETIC_IDS = [29, 34, 47];

/**
 * #7604: the synthetic source with a CRS that has no EPSG code in its name,
 * with and without a `GeodeticDatum`. Before #7604 the first came back from
 * LandXML renamed to its datum, and the second with no IfcMapConversion at
 * all, so the second export refused.
 */
const NON_EPSG_CRS = [
  ['with GeodeticDatum', "#12=IFCPROJECTEDCRS('CH1903+ / LV95',$,'CH1903+','LN02',$,$,#6);",
    '<CoordinateSystem name="CH1903+ / LV95" horizontalDatum="CH1903+" verticalDatum="LN02"/>'],
  ['without GeodeticDatum', "#12=IFCPROJECTEDCRS('CH1903+ / LV95',$,$,$,$,$,#6);",
    '<CoordinateSystem name="CH1903+ / LV95"/>'],
] as const;

function syntheticWithCrs(record: string): string {
  const ifc = SYNTHETIC_IFC.replace(/^#12=IFCPROJECTEDCRS\(.*\);$/m, record);
  assert.notEqual(ifc, SYNTHETIC_IFC, 'the synthetic source still declares its CRS as #12');
  return ifc;
}

/** The committed sample TIN with a CRS declared the way producers declare it. */
async function sampleWithCrs(
  record = '<CoordinateSystem name="CH1903+ / LV95" epsgCode="2056" verticalDatum="LN02"/>',
): Promise<string> {
  const xml = await readFile(SAMPLE_TIN, 'utf8');
  const declared = xml.replace('<Project ', `${record}\n  <Project `);
  assert.notEqual(declared, xml, 'the sample still has the <Project> element the CRS is declared before');
  return declared;
}

/** The one IfcProjectedCRS in `ifc`, and how many IfcMapConversions target it. */
function projectedCrs(ifc: string): { name: string; geodeticDatum: string; conversions: number } {
  const step = new Step(ifc);
  const crs = step.ids('IFCPROJECTEDCRS');
  assert.equal(crs.length, 1, 'one IfcProjectedCRS');
  const [name, , geodeticDatum] = step.get(crs[0]);
  const conversions = step.ids('IFCMAPCONVERSION').filter((id) => step.get(id)[1] === `#${crs[0]}`).length;
  return { name: stepString(name), geodeticDatum, conversions };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('LandXML 1.2 XSD as the authority (#7600)', () => {
  it('is the published schema, byte for byte', async () => {
    assert.equal(createHash('sha256').update(await readFile(XSD)).digest('hex'), XSD_SHA256);
  });

  // Without this the "valid" verdicts below could come from a validator that
  // silently failed to compile a 226 KB schema and accepted everything.
  //
  // What the XSD can NOT catch: its identity constraints (`uSrfName` on
  // Surface@name, `uSrfPntNum` on P@id) select with unprefixed XPath, which in
  // XSD 1.0 means no-namespace elements, so they never match a document in
  // the LandXML namespace. xmllint does enforce them (strip the namespace from
  // both and a duplicate P@id fails), but against the published schema a
  // duplicate name or id validates. Uniqueness is therefore asserted directly
  // on the export, not left to the schema.
  it('rejects what the schema forbids (negative control)', async () => {
    const xml = await readFile(SAMPLE_TIN, 'utf8');
    assert.deepEqual(await schemaErrors(xml), [], 'the committed sample is the valid baseline');
    const broken: Array<[string, string, RegExp]> = [
      ['a non-integer point id', xml.replace('<P id="1">', '<P id="1.5">'), /'1\.5' is not a valid value of the atomic type 'xs:positiveInteger'/],
      ['no LandXML@date', xml.replace(/ date="[^"]*"/, ''), /The attribute 'date' is required but missing/],
      ['a non-integer face index', xml.replace('<F>1 2 4</F>', '<F>1 two 4</F>'), /'two' is not a valid value of the atomic type 'xs:integer'/],
      ['a surfType outside TIN/grid', xml.replace('surfType="TIN"', 'surfType="MESH"'), /'MESH' is not an element of the set/],
    ];
    for (const [label, document, expected] of broken) {
      assert.notEqual(document, xml, `${label}: the mutation applied`);
      const errors = await schemaErrors(document);
      assert.ok(errors.some((error) => expected.test(error)), `${label} must be rejected; got ${JSON.stringify(errors)}`);
    }
  });

  it('accepts the export of a multi-surface terrain whose names need escaping', { skip: NEEDS_WASM }, async () => {
    const result = await exportTerrain(SYNTHETIC_IFC, SYNTHETIC_IDS);
    await assertSchemaValid(result.xml, 'synthetic export');
    // Unique names: the schema's uSrfName cannot check this (see above).
    assert.deepEqual(result.surfaces.map((s) => s.name), ['Ground & <hill>', 'Ground & <hill> (2)', 'O\'Brien "knoll"']);
    for (const surface of readLandXml(result.xml).surfaces) {
      assert.equal(new Set(surface.points.map((p) => p.id)).size, surface.points.length, 'P@id is unique within a surface');
    }
    assert.match(result.xml, /<Surface name="Ground &amp; &lt;hill&gt;"/);
    // Read back by the viewer's real LandXML parser, not by a regex.
    const parsed = await parseLandXmlSourceInCurrentRealm(new TextEncoder().encode(result.xml).buffer);
    assert.deepEqual(parsed.surfaces.map((s) => s.name), result.surfaces.map((s) => s.name));
    assert.deepEqual(parsed.coordinateSystem, { name: 'EPSG:2056', horizontalDatum: 'CH1903+', verticalDatum: 'LN02', epsgCode: '2056' });
  });

  it('accepts the export of the bonsai-topo control terrain', { skip: NEEDS_BONSAI }, async () => {
    const result = await exportTerrain(await readFile(BONSAI_IFC, 'utf8'), [18]);
    await assertSchemaValid(result.xml, 'bonsai-topo export');
  });

  it('writes every unit option schema-valid, reading back to the same metres (#7618)', { skip: NEEDS_WASM }, async () => {
    const expected = oracle(SYNTHETIC_IFC, SYNTHETIC_IDS);
    for (const [linearUnit, declared] of [
      ['metre', { linearUnit: 'meter', elevationUnit: 'meter' }],
      ['internationalFoot', { linearUnit: 'foot', elevationUnit: 'feet' }],
      ['usSurveyFoot', { linearUnit: 'USSurveyFoot', elevationUnit: 'feet' }],
    ] as const) {
      const outcome = await runLandXmlTerrainExport(new TextEncoder().encode(SYNTHETIC_IFC), SYNTHETIC_IDS, undefined, { now: NOW, linearUnit });
      assert.equal(outcome.status, 'ready', JSON.stringify(outcome));
      const { xml } = (outcome as Extract<typeof outcome, { status: 'ready' }>).result;
      await assertSchemaValid(xml, `${linearUnit} export`);
      // The viewer's own LandXML parser applies the declared unit scales.
      const parsed = await parseLandXmlSourceInCurrentRealm(new TextEncoder().encode(xml).buffer);
      assert.ok(parsed.units, `${linearUnit}: units are declared`);
      assert.deepEqual({ linearUnit: parsed.units.linearUnit, elevationUnit: parsed.units.elevationUnit }, declared);
      parsed.surfaces.forEach((surface, s) => {
        surface.points.forEach((point, i) => {
          const metres = [
            point.northing * parsed.units!.linearScaleToMeters,
            point.easting * parsed.units!.linearScaleToMeters,
            point.elevation * parsed.units!.elevationScaleToMeters,
          ];
          // Six decimals of a foot is ~0.3 micrometres; allow the metre rounding too.
          metres.forEach((value, axis) => assert.ok(Math.abs(value - expected[s].points[i][axis]) <= 1e-6,
            `${linearUnit} surface ${s} point ${i + 1} axis ${'NEZ'[axis]}: ${value} vs oracle ${expected[s].points[i][axis]}`));
        });
      });
    }
  });
});

describe('IFC → LandXML → IFC → LandXML keeps vertices and faces (#7600)', () => {
  it('bonsai-topo control terrain (an external producer\'s IFC)', { skip: NEEDS_BONSAI }, async () => {
    const ifc = await readFile(BONSAI_IFC, 'utf8');
    const { first } = await assertRoundTrip(ifc, [18], 'bonsai-topo');
    // The fixture's own LandXML twin, written by the same external producer,
    // is a second, independent statement of the same positions.
    const twin = readLandXml(await readFile(BONSAI_XML, 'utf8')).surfaces[0];
    const ours = readLandXml(first.xml).surfaces[0];
    assert.deepEqual(ours.points.map((p) => p.text.split(' ').map(Number)), twin.points.map((p) => p.text.split(' ').map(Number)));
    assert.deepEqual(ours.faces, twin.faces);
  });

  it('synthetic terrains: rotated map conversion, rotated placement, PnIndex, TIN', { skip: NEEDS_WASM }, async () => {
    await assertRoundTrip(SYNTHETIC_IFC, SYNTHETIC_IDS, 'synthetic');
  });

  it('ifc-lite\'s own LandXML→IFC output of the sample TIN', { skip: NEEDS_WASM }, async () => {
    const source = await sampleWithCrs();
    const ifc = await landXmlToIfcThroughViewer(source, 'terrain-tin-metric.xml');
    const ids = geographicElements(ifc);
    assert.equal(ids.length, 1);
    const { first } = await assertRoundTrip(ifc, ids, 'terrain-tin-metric');
    // And the positions are the sample's own, as authored.
    const authored = readLandXml(source).surfaces[0];
    const exported = readLandXml(first.xml).surfaces[0];
    assert.deepEqual(exported.points.map((p) => p.text.split(' ').map(Number)), authored.points.map((p) => p.text.split(/\s+/).map(Number)));
    assert.deepEqual(exported.faces, authored.faces);
    assert.equal(first.crsName, 'EPSG:2056');
  });

  for (const [variant, record, coordinateSystem] of NON_EPSG_CRS) {
    it(`a non-EPSG IfcProjectedCRS ${variant} keeps its name and map conversion (#7604)`, { skip: NEEDS_WASM }, async () => {
      const ifc = syntheticWithCrs(record);
      const { first, second, reimported } = await assertRoundTrip(ifc, SYNTHETIC_IDS, `non-EPSG ${variant}`);
      assert.equal(readLandXml(first.xml).coordinateSystem, coordinateSystem, 'the IFC CRS name is CoordinateSystem@name, and no epsgCode is invented');
      assert.deepEqual(projectedCrs(reimported), { ...projectedCrs(ifc), conversions: 1 }, 'LandXML → IFC keeps the CRS name and datum, with its IfcMapConversion');
      assert.equal(first.crsName, 'CH1903+ / LV95');
      assert.equal(second.crsName, 'CH1903+ / LV95');
    });
  }

  it('a LandXML CoordinateSystem with only a name converts to that IfcProjectedCRS (#7604)', { skip: NEEDS_WASM }, async () => {
    const source = await sampleWithCrs('<CoordinateSystem name="CH1903+ / LV95"/>');
    // The viewer's real parser, through the wasm: the name is decoded at the source.
    const parsed = await parseLandXmlSourceInCurrentRealm(new TextEncoder().encode(source).buffer);
    assert.deepEqual(parsed.coordinateSystem, { name: 'CH1903+ / LV95' });
    const ifc = await landXmlToIfcThroughViewer(source, 'terrain-tin-metric.xml');
    assert.deepEqual(projectedCrs(ifc), { name: 'CH1903+ / LV95', geodeticDatum: '$', conversions: 1 });
    const { first } = await assertRoundTrip(ifc, geographicElements(ifc), 'name-only LandXML CRS');
    assert.equal(readLandXml(first.xml).coordinateSystem, '<CoordinateSystem name="CH1903+ / LV95"/>');
  });
});
