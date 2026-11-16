/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `ifc-lite site-context` end to end against a synthetic geodata client:
 * the centre read from a model's georeferencing (literal EPSG:2056, a name
 * that resolves to it, LV03 reprojected), the refusals, and proof that the
 * model's own rotation and millimetre units never reach the context. The
 * rotated millimetre model is the committed building-architecture sample,
 * its IfcProjectedCRS and IfcMapConversion rewritten to EPSG:2056.
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { attributionFor, type BBox, type ElevationGrid, type SwissParcel } from '@ifc-lite/geodata-ch';
import { resolveCrs } from '@ifc-lite/geo';
import { decodeSiteContextGlb, type BuildingsReader, type SiteContextGeodata } from '@ifc-lite/site-context';
import { geodeticToEcef, type SwissBuildingFeature } from '@ifc-lite/tiles3d';
import { siteContextCommand } from './site-context.js';
import { diskCache } from './site-context-cache.js';
import { METRE_MAP_UNIT_WARNING } from './site-context-model.js';

const ROTATED_MM_SAMPLE = new URL('../../../../apps/viewer/public/samples/building-architecture.ifc', import.meta.url);

/** IFC4, metres, with the given IfcProjectedCRS and IfcMapConversion arguments. */
function model(crs: string, conversion: string): string {
  return `ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('m','2026',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1= IFCPROJECT('0YvCT2_$X3_xJG3rzD8L_8',$,'Proj',$,$,$,$,(#20),#30);
#20= IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-5,#21,$);
#21= IFCAXIS2PLACEMENT3D(#22,$,$);
#22= IFCCARTESIANPOINT((0.,0.,0.));
#30= IFCUNITASSIGNMENT((#31));
#31= IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#50= IFCPROJECTEDCRS(${crs},#31);
#51= IFCMAPCONVERSION(#20,#50,${conversion});
ENDSEC;
END-ISO-10303-21;
`;
}

const CENTRE = { x: 2_600_000, y: 1_200_000 };
const height = (x: number, y: number) => 500 + 0.02 * (x - CENTRE.x) - 0.01 * (y - CENTRE.y);

function parcel(): SwissParcel {
  const [cx, cy, h] = [CENTRE.x + 5, CENTRE.y - 5, 15];
  const ring = [[cx - h, cy - h], [cx + h, cy - h], [cx + h, cy + h], [cx - h, cy + h], [cx - h, cy - h]];
  return {
    id: 'CH999999999999', egrid: 'CH999999999999', number: '123', region: 'BE', canton: 'BE', cadastralDistrict: null,
    realEstateType: null, geoportalUrl: null, geometry: { type: 'Polygon', coordinates: [ring] }, computedArea: 900,
    sourceLayer: 'ch.kantone.cadastralwebmap-farbe', properties: {}, crs: 'EPSG:2056', attribution: [attributionFor('cadastre')],
  };
}

function stub(): SiteContextGeodata & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    get requestCount() { return calls.length; },
    async elevationGrid(b: BBox, { resolution }) {
      calls.push(`grid ${b.minX},${b.minY}`);
      const width = Math.round((b.maxX - b.minX) / resolution) + 1;
      const rows = Math.round((b.maxY - b.minY) / resolution) + 1;
      const values = new Float32Array(width * rows);
      for (let r = 0; r < rows; r++) for (let c = 0; c < width; c++) values[r * width + c] = height(b.minX + c * resolution, b.maxY - r * resolution);
      const grid: ElevationGrid = {
        crs: 'EPSG:2056', verticalCrs: 'EPSG:5728', verticalReference: 'LN02', origin: { x: b.minX, y: b.maxY }, resolution, width, height: rows,
        values, noDataCount: 0, hasData: true, sources: [{ id: 'swissalti3d_2021_2599-1199', url: 'https://stub.test/t.tif', acquired: '2021-06-01T00:00:00Z', gsd: 0.5 }],
        missingTiles: [], attribution: [attributionFor('swissalti3d')],
      };
      return grid;
    },
    async parcelsAtPoint(x, y) { calls.push(`parcelsAtPoint ${x},${y}`); return [parcel()]; },
    async parcelById(egrid) { calls.push(`parcelById ${egrid}`); return egrid === 'CH999999999999' ? parcel() : null; },
    async oerebExtract(egrid) { calls.push(`oereb ${egrid}`); throw new Error('stub register offline'); },
  };
}

let dir: string;
let stdout: string;
let stderr: string;
class Exit extends Error { constructor(readonly code: number | undefined) { super(`exit ${code}`); } }

function capture() {
  stdout = '';
  stderr = '';
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => { stdout += String(chunk); return true; });
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => { stderr += String(chunk); return true; });
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => { throw new Exit(code); }) as never);
}
afterEach(() => { vi.restoreAllMocks(); });

const p = (name: string) => join(dir, name);

interface Report {
  output: string; bytes: number; requests: number; origin: number[]; crs: string;
  centre: { x: number; y: number; source: string };
  model?: { crs: { name: string; matched: string; epsg: number | null }; mapUnitToMetres: number; rotationDegrees: number | null; rotationApplied: boolean; verticalDatum: string | null };
  layers: Array<{ kind: string; complete: boolean; features: number; triangles: number; issues: Array<{ code: string }>; attribution: string[] }>;
  parcels: Array<{ egrid: string; number: string | null; canton: string | null; oerebExtractUrl: string | null }>;
  attribution: string[]; warnings: string[];
  buildings?: {
    count: number; withEgid: number; requests: number | null; bytes: number | null;
    subject: { id: string; egid: string | null; match: { method: string; overlap?: number } } | null;
    subjectFootprint: { elements: number; ring: Array<{ x: number; y: number }> } | null;
    issues: Array<{ code: string; message: string }>;
  };
}

async function siteContext(args: string[], geodata = stub(), buildingsReader?: BuildingsReader): Promise<Report> {
  capture();
  await siteContextCommand([...args, '--json', '--cache-dir', p('cache')], { geodata, buildingsReader });
  return JSON.parse(stdout) as Report;
}

/** A flat-roofed prism on an EPSG:2056 ring, encoded as the swisstopo tiles do (ECEF, wall and roof groups). */
async function prism(ring: Array<{ x: number; y: number }>, base: number, top: number, attributes: Record<string, unknown>, featureId: number): Promise<SwissBuildingFeature> {
  const lv95 = (await resolveCrs({ epsg: 2056 }))!;
  const verts: number[] = [];
  for (const z of [base, top]) {
    for (const q of ring) {
      const [lon, lat] = lv95.toWgs84([q.x, q.y])!;
      verts.push(...geodeticToEcef(lon, lat, z));
    }
  }
  const n = ring.length;
  const walls: number[] = [];
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    walls.push(i, j, n + j, i, n + j, n + i);
  }
  const roof: number[] = [];
  for (let i = 1; i < n - 1; i++) roof.push(n, n + i, n + i + 1);
  const url = 'https://3d.geo.admin.ch/ch.swisstopo.swissbuildings3d.3d/v1/20260520/stub.b3dm';
  return {
    featureId,
    positions: new Float64Array(verts),
    indices: new Uint32Array([...walls, ...roof]),
    groups: [
      { start: 0, count: walls.length, node: 0, mesh: 0, primitive: 0, baseColorFactor: [0.89, 0.85, 0.56, 1] },
      { start: walls.length, count: roof.length, node: 0, mesh: 0, primitive: 1, baseColorFactor: [0.81, 0.25, 0.25, 1] },
    ],
    attributes,
    tile: { url, tilesetUrl: url, tilesetChain: [url], assetVersion: '1.0' },
  };
}

function reader(features: SwissBuildingFeature[]): BuildingsReader {
  return async () => ({
    features, tiles: [], issues: [], truncated: false, complete: true, attribution: '© swisstopo (swissBUILDINGS3D)',
    stats: { requests: 7, bytes: 4096, cacheHits: 2, nodesVisited: 0, tilesetsLoaded: 0, contentsSelected: 0, featuresOutsideRegion: 0, decodedVertices: 0, decodedIndices: 0 },
  });
}

function square(cx: number, cy: number, h: number): Array<{ x: number; y: number }> {
  return [{ x: cx - h, y: cy - h }, { x: cx + h, y: cy - h }, { x: cx + h, y: cy + h }, { x: cx - h, y: cy + h }];
}

async function refusal(args: string[]): Promise<string> {
  capture();
  try {
    await siteContextCommand([...args, '--cache-dir', p('cache')], { geodata: stub() });
  } catch (err) {
    if (err instanceof Exit && err.code === 1) return stderr;
    throw err;
  }
  throw new Error(`expected a refusal, got: ${stdout}`);
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ifc-lite-cli-site-context-'));
  await writeFile(p('lv95.ifc'), model(`'EPSG:2056',$,'CH1903+',$,$,$`, '2600000.,1200000.,500.,$,$,$'));
  await writeFile(p('lv95-name.ifc'), model(`'CH1903+ / LV95',$,'CH1903+','LN02',$,$`, '2600000.,1200000.,500.,$,$,$'));
  await writeFile(p('lv03.ifc'), model(`'EPSG:21781',$,'CH1903','LN02',$,$`, '600000.,200000.,500.,$,$,$'));
  await writeFile(p('lhn95.ifc'), model(`'EPSG:2056',$,'CH1903+','LHN95',$,$`, '2600000.,1200000.,500.,$,$,$'));
  // MapUnit points at a record that is not a unit: the reader falls back to METRE.
  await writeFile(p('lv95-badunit.ifc'), model(`'EPSG:2056',$,'CH1903+','LN02',$,$`, '2600000.,1200000.,500.,$,$,$').replace("'LN02',$,$,#31);", "'LN02',$,$,#22);"));
  await writeFile(p('nogeoref.ifc'), model(`'EPSG:2056',$,$,$,$,$`, '0.,0.,0.,$,$,$').replace(/#5[01]=.*\n/g, ''));
  // The committed sample: millimetres (its MapUnit is the project's MILLI METRE unit #15),
  // rotated 60°, in UTM 60S. Re-georeference it to EPSG:2056 at the same centre as
  // lv95.ifc, keeping its rotation and units.
  const sample = await readFile(ROTATED_MM_SAMPLE, 'utf8');
  const crsLine = /^#18=IFCPROJECTEDCRS\(.*\);$/m;
  const conversionLine = /^#19=IFCMAPCONVERSION\(.*\);$/m;
  if (!crsLine.test(sample) || !conversionLine.test(sample)) throw new Error('the committed sample no longer has #18 IfcProjectedCRS / #19 IfcMapConversion');
  await writeFile(p('rotated-mm.ifc'), sample
    .replace(crsLine, "#18=IFCPROJECTEDCRS('EPSG:2056',$,'CH1903+','LN02',$,$,#15);")
    .replace(conversionLine, '#19=IFCMAPCONVERSION(#11,#18,2600000000.,1200000000.,500000.,0.5,0.8660254037844386,1.);'));
});
afterAll(async () => { await rm(dir, { recursive: true, force: true }); });

describe('ifc-lite site-context from a model', () => {
  it('writes a GLB and a JSON summary for a model in EPSG:2056', async () => {
    const r = await siteContext([p('lv95.ifc'), '--radius', '40', '--out', p('lv95.glb')]);
    expect(r.model?.crs).toMatchObject({ name: 'EPSG:2056', matched: 'literal', epsg: 2056 });
    expect(r.centre).toEqual({ ...CENTRE, source: 'model' });
    expect(r.origin).toEqual([2_600_000, 1_200_000, 500]);
    expect(r.crs).toBe('EPSG:2056');
    expect(r.requests).toBe(3); // grid, parcel, ÖREB
    const bytes = await readFile(p('lv95.glb'));
    expect(r.bytes).toBe(bytes.byteLength);
    const doc = decodeSiteContextGlb(new Uint8Array(bytes));
    expect(doc.layers.map((l) => l.kind)).toEqual(['terrain', 'parcel']);
    // Surface cells plus the skirt (a wall per edge segment and a two-triangle bottom).
    expect(r.layers[0]).toMatchObject({ kind: 'terrain', complete: true, triangles: 2 * 160 * 160 + 2 * 4 * 160 + 2 });
    expect(r.parcels).toEqual([{ egrid: 'CH999999999999', number: '123', canton: 'BE', oerebExtractUrl: null }]);
    // The ÖREB failure is reported on the parcel layer, not a failed run.
    expect(r.layers[1].complete).toBe(false);
    expect(r.layers[1].issues.map((i) => i.code)).toEqual(expect.arrayContaining(['oereb-lookup-failed', 'terms-unverified']));
    expect(r.attribution).toEqual(['© swisstopo', '© Cadastral surveying (CS) and the cantons']);
    expect(r.warnings.join()).toMatch(/no vertical datum/);
  });

  it('does not apply a rotated millimetre model\'s own conversion to the context', async () => {
    const plain = await siteContext([p('lv95.ifc'), '--radius', '40', '--out', p('plain.glb')]);
    const rotated = await siteContext([p('rotated-mm.ifc'), '--radius', '40', '--out', p('rotated.glb')]);
    expect(rotated.model).toMatchObject({ mapUnitToMetres: 0.001, rotationApplied: false, verticalDatum: 'LN02' });
    expect(rotated.model!.rotationDegrees).toBeCloseTo(60, 6);
    expect(rotated.centre).toMatchObject(CENTRE);
    expect(rotated.origin).toEqual(plain.origin);
    // Same site, same bytes: nothing of the model's rotation or scale got into the geometry.
    expect(Buffer.compare(await readFile(p('rotated.glb')), await readFile(p('plain.glb')))).toBe(0);
  });

  it('warns that an unreadable MapUnit is assumed to be metres, and not for a resolved millimetre unit', async () => {
    const bad = await siteContext([p('lv95-badunit.ifc'), '--radius', '20', '--layers', 'terrain', '--out', p('badunit.glb')]);
    expect(bad.model).toMatchObject({ mapUnitToMetres: 1, mapUnitSource: 'MapUnit' });
    expect(bad.warnings).toContain(METRE_MAP_UNIT_WARNING);
    const mm = await siteContext([p('rotated-mm.ifc'), '--radius', '20', '--layers', 'terrain', '--out', p('mm-unit.glb')]);
    expect(mm.model).toMatchObject({ mapUnitToMetres: 0.001 });
    expect(mm.warnings).not.toContain(METRE_MAP_UNIT_WARNING);
  });

  it('accepts a CRS name that resolves to EPSG:2056 and says which form matched', async () => {
    const r = await siteContext([p('lv95-name.ifc'), '--radius', '20', '--layers', 'terrain', '--out', p('name.glb')]);
    expect(r.model?.crs).toMatchObject({ name: 'CH1903+ / LV95', matched: 'name', epsg: 2056 });
    // Vertical datum stated, MapUnit a declared METRE: only the metre-assumption warning remains.
    expect(r.warnings).toEqual([METRE_MAP_UNIT_WARNING]);
  });

  it('reprojects only the centre of an LV03 model and says so', async () => {
    const r = await siteContext([p('lv03.ifc'), '--radius', '20', '--layers', 'terrain', '--out', p('lv03.glb')]);
    expect(r.model?.crs).toMatchObject({ matched: 'reprojected', epsg: 21781 });
    // LV03 → LV95 is a 2 000 000 / 1 000 000 m false-origin shift plus at most a couple of metres.
    expect(Math.abs(r.centre.x - 2_600_000)).toBeLessThan(3);
    expect(Math.abs(r.centre.y - 1_200_000)).toBeLessThan(3);
    expect(r.warnings.join()).toMatch(/only the centre point was reprojected/);
  });
});

describe('ifc-lite site-context refusals', () => {
  it('refuses a model without a map conversion and says how to proceed', async () => {
    expect(await refusal([p('nogeoref.ifc'), '--out', p('x.glb')])).toMatch(/needs an IfcMapConversion to EPSG:2056.*--centre E,N/);
  });

  it('refuses a vertical datum other than LN02', async () => {
    expect(await refusal([p('lhn95.ifc'), '--out', p('x.glb')])).toMatch(/LHN95.*refusing to mix height systems/);
  });

  it('refuses a model whose centre is outside Switzerland (the unmodified UTM 60S sample)', async () => {
    expect(await refusal([ROTATED_MM_SAMPLE.pathname, '--out', p('x.glb')])).toMatch(/outside the Swiss geodata coverage|could not be converted to EPSG:2056/);
  });

  it('refuses ambiguous or missing inputs', async () => {
    expect(await refusal([p('lv95.ifc'), '--centre', '2600000,1200000', '--out', p('x.glb')])).toMatch(/exactly one of/);
    expect(await refusal(['--centre', '2600000,1200000'])).toMatch(/--out/);
    expect(await refusal(['--centre', '2600000,1200000', '--layers', 'roads', '--out', p('x.glb')])).toMatch(/unknown layer/);
  });
});

describe('ifc-lite site-context without a model', () => {
  it('takes --centre E,N', async () => {
    const r = await siteContext(['--centre', '2600010,1199990', '--radius', '20', '--out', p('c.glb')]);
    expect(r.centre).toEqual({ x: 2_600_010, y: 1_199_990, source: '--centre' });
    expect(r.model).toBeUndefined();
  });

  it('takes --egrid and centres the site on the parcel', async () => {
    const geodata = stub();
    const r = await siteContext(['--egrid', 'ch999999999999', '--radius', '30', '--out', p('e.glb')], geodata);
    expect(r.centre).toEqual({ x: CENTRE.x + 5, y: CENTRE.y - 5, source: '--egrid' });
    expect(r.parcels[0].egrid).toBe('CH999999999999');
    expect(geodata.calls.filter((c) => c.startsWith('parcelById'))).toHaveLength(2);
  });
});

describe('ifc-lite site-context buildings', () => {
  it('reads buildings, marks the subject by --subject-egid and reports counts, requests and bytes', async () => {
    const features = [
      await prism(square(CENTRE.x, CENTRE.y, 8), 500, 510, { EGID: 190001, UUID: 'A' }, 0),
      await prism(square(CENTRE.x + 25, CENTRE.y, 5), 500, 506, { UUID: 'B' }, 1),
    ];
    const r = await siteContext(['--centre', `${CENTRE.x},${CENTRE.y}`, '--radius', '40', '--layers', 'terrain,parcel,buildings', '--subject-egid', '190001', '--out', p('b.glb')], stub(), reader(features));
    expect(r.buildings).toMatchObject({ count: 2, withEgid: 1, requests: 7, bytes: 4096, subject: { id: 'building:egid:190001', egid: '190001', match: { method: 'egid' } }, subjectFootprint: null });
    expect(r.buildings!.issues.map((i) => i.code)).toEqual(expect.arrayContaining(['buildings-subject-matched', 'buildings-missing-egid']));
    expect(r.requests).toBe(3 + 7);
    expect(r.attribution).toContain('© swisstopo (swissBUILDINGS3D)');
    const doc = decodeSiteContextGlb(new Uint8Array(await readFile(p('b.glb'))));
    const subject = doc.layers[2].features.find((f) => f.subject)!;
    expect(subject.mesh!.parts!.map((q) => q.name)).toEqual(['roof', 'wall']);
  });

  it('derives a footprint from a rotated millimetre model and matches the building it stands in by overlap', async () => {
    const first = await siteContext([p('rotated-mm.ifc'), '--radius', '40', '--layers', 'buildings', '--out', p('m0.glb')], stub(), reader([]));
    const ring = first.buildings!.subjectFootprint!.ring;
    expect(first.buildings!.subjectFootprint!.elements).toBeGreaterThan(0);
    // The model's 60° rotation carries into its footprint (not into the context): its edges run at 60° / 150°.
    const angle = (Math.atan2(ring[1].y - ring[0].y, ring[1].x - ring[0].x) * 180) / Math.PI;
    expect(((angle % 90) + 90) % 90).toBeCloseTo(60, 6);
    expect(first.buildings!.issues.map((i) => i.code)).toContain('buildings-subject-not-found');
    const own = await prism(ring, 500, 512, { UUID: 'OWN' }, 0);
    const other = await prism(square(CENTRE.x + 30, CENTRE.y + 30, 4), 500, 505, { UUID: 'OTHER' }, 1);
    const r = await siteContext([p('rotated-mm.ifc'), '--radius', '40', '--layers', 'buildings', '--out', p('m.glb')], stub(), reader([other, own]));
    expect(r.buildings!.subject).toMatchObject({ id: 'building:uuid:OWN', match: { method: 'footprint' } });
    expect(r.buildings!.subject!.match.overlap).toBeGreaterThan(0.99);
  });

  it('reprojects every footprint corner of a UTM 32N model to EPSG:2056, not just its origin (#10480 review)', async () => {
    // The same rotated millimetre sample, georeferenced in UTM 32N at the same ground point as rotated-mm.ifc.
    const lv95 = (await resolveCrs({ epsg: 2056 }))!;
    const utm = (await resolveCrs({ epsg: 32632 }))!;
    const [lon, lat] = lv95.toWgs84([CENTRE.x, CENTRE.y])!;
    const [ue, un] = utm.fromWgs84([lon, lat])!;
    const sample = await readFile(p('rotated-mm.ifc'), 'utf8');
    await writeFile(p('utm-mm.ifc'), sample
      .replace(/^#18=IFCPROJECTEDCRS\(.*\);$/m, "#18=IFCPROJECTEDCRS('EPSG:32632',$,'WGS 84','LN02',$,$,#15);")
      .replace(/^#19=IFCMAPCONVERSION\(.*\);$/m, `#19=IFCMAPCONVERSION(#11,#18,${(ue * 1000).toFixed(3)},${(un * 1000).toFixed(3)},500000.,0.5,0.8660254037844386,1.);`));
    const plain = await siteContext([p('rotated-mm.ifc'), '--radius', '40', '--layers', 'buildings', '--out', p('fp-lv95.glb')], stub(), reader([]));
    const viaUtm = await siteContext([p('utm-mm.ifc'), '--radius', '40', '--layers', 'buildings', '--out', p('fp-utm.glb')], stub(), reader([]));
    // Corner offsets in the model's own map axes (rotation applied), read off the LV95 model's ring.
    const offsets = plain.buildings!.subjectFootprint!.ring.map((q) => [q.x - CENTRE.x, q.y - CENTRE.y]);
    const expected = offsets.map(([dx, dy]) => {
      const [glon, glat] = utm.toWgs84([ue + dx, un + dy])!;
      const [x, y] = lv95.fromWgs84([glon, glat])!;
      return { x, y };
    });
    const got = viaUtm.buildings!.subjectFootprint!.ring;
    expect(got).toHaveLength(4);
    for (let i = 0; i < 4; i++) {
      expect(Math.abs(got[i].x - expected[i].x)).toBeLessThan(0.01);
      expect(Math.abs(got[i].y - expected[i].y)).toBeLessThan(0.01);
    }
  });

  it('turns an offline run without cached tiles into a failed buildings layer, not a failed run', async () => {
    capture();
    await siteContextCommand(['--centre', `${CENTRE.x},${CENTRE.y}`, '--radius', '20', '--layers', 'buildings', '--offline', '--json', '--cache-dir', p('empty-cache'), '--out', p('off.glb')], { geodata: stub() });
    const r = JSON.parse(stdout) as Report;
    expect(r.layers[0]).toMatchObject({ kind: 'buildings', complete: false, features: 0 });
    expect(r.buildings!.issues).toEqual([expect.objectContaining({ code: 'buildings-fetch-failed', message: expect.stringContaining('offline') })]);
  });

  it('refuses a non-numeric --subject-egid', async () => {
    expect(await refusal(['--centre', '2600000,1200000', '--layers', 'buildings', '--subject-egid', 'abc', '--out', p('x.glb')])).toMatch(/numeric EGID/);
  });
});

describe('response cache', () => {
  it('stores and returns responses by URL plus Range', async () => {
    const cache = diskCache(p('cache-unit'));
    const body = new Uint8Array([1, 2, 3, 4]).buffer;
    await cache.set('https://x.test/a|bytes=0-3', { status: 206, headers: { 'content-range': 'bytes 0-3/9' }, body });
    expect(await cache.get('https://x.test/a|bytes=0-4')).toBeUndefined();
    const hit = await cache.get('https://x.test/a|bytes=0-3');
    expect(hit?.status).toBe(206);
    expect([...new Uint8Array(hit!.body)]).toEqual([1, 2, 3, 4]);
  });
});

describe('ifc-lite site-context only contacts swisstopo', () => {
  /** A network fetch that records what reached it and answers with `respond`. */
  function recordingFetch(respond: (url: string) => Response) {
    const sent: Array<{ url: string; redirect: RequestInit['redirect'] }> = [];
    const fetch = async (url: string, init?: RequestInit) => { sent.push({ url, redirect: init?.redirect }); return respond(url); };
    return { sent, fetch };
  }
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  const onSwisstopo = (url: string) => /^https:\/\/(api3|data|wms|wmts|3d)\.geo\.admin\.ch\//.test(url);

  it('has no argument that names a URL: a tileset or endpoint override is an unknown option', async () => {
    for (const flag of ['--tileset', '--url', '--endpoint', '--base-url']) {
      expect(await refusal(['--centre', '2600000,1200000', flag, 'https://evil.test/tileset.json', '--out', p('x.glb')])).toMatch(new RegExp(`unknown option ${flag}`));
    }
  });

  it('does not follow a STAC page link to another host, and asks fetch not to follow redirects', async () => {
    const net = recordingFetch((url) => url.includes('/api/stac/v1/')
      ? json({ features: [], links: [{ rel: 'next', href: 'https://evil.test/stac/page2' }] })
      : new Response('{}', { status: 404 }));
    capture();
    // The real geodata client, not the stub: its URLs come from its fixed endpoints and from responses.
    await siteContextCommand(['--centre', `${CENTRE.x},${CENTRE.y}`, '--radius', '20', '--layers', 'terrain', '--rate', '1000',
      '--json', '--cache-dir', p('net-stac-cache'), '--out', p('net-stac.glb')], { fetch: net.fetch, sleep: async () => {} }).catch((err) => {
      if (!(err instanceof Exit)) throw err;
    });
    // The first STAC page was asked for; the off-host page it linked to never was.
    expect(net.sent.some((s) => s.url.startsWith('https://data.geo.admin.ch/api/stac/v1/'))).toBe(true);
    expect(net.sent.filter((s) => !onSwisstopo(s.url))).toEqual([]);
    expect(net.sent.every((s) => s.redirect === 'error')).toBe(true);
  });

  it('does not fetch a tileset content URI on another host', async () => {
    const lv95 = (await resolveCrs({ epsg: 2056 }))!;
    const [lon, lat] = lv95.toWgs84([CENTRE.x, CENTRE.y])!.map((d) => d * Math.PI / 180);
    const d = 0.0005;
    const net = recordingFetch((url) => url.endsWith('/tileset.json')
      ? json({
        asset: { version: '1.0' }, geometricError: 100,
        root: { boundingVolume: { region: [lon - d, lat - d, lon + d, lat + d, 0, 1000] }, geometricError: 0, refine: 'ADD', content: { uri: 'https://evil.test/stolen.b3dm' } },
      })
      : new Response('', { status: 404 }));
    const r = await (async () => {
      capture();
      await siteContextCommand(['--centre', `${CENTRE.x},${CENTRE.y}`, '--radius', '20', '--layers', 'buildings',
        '--json', '--cache-dir', p('net-tiles-cache'), '--out', p('net-tiles.glb')], { geodata: stub(), fetch: net.fetch });
      return JSON.parse(stdout) as Report;
    })();
    // Only the root tileset on 3d.geo.admin.ch was sent; its off-host content URI never was.
    expect(net.sent).toHaveLength(1);
    expect(net.sent[0].url).toMatch(/^https:\/\/3d\.geo\.admin\.ch\/.*tileset\.json$/);
    expect(net.sent.every((s) => onSwisstopo(s.url) && s.redirect === 'error')).toBe(true);
    expect(r.layers[0].complete).toBe(false);
    expect(JSON.stringify(r.buildings?.issues ?? r.layers[0].issues)).toMatch(/evil\.test/);
  });
});
