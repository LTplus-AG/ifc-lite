/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #5942 — draped imagery carried into the IFC4X3 export (mapping spec
 * §15.5), through the REAL appearance planner (the wasm texture writer every
 * textured element goes through), and graded by IfcOpenShell.
 *
 * The data is the synthetic, known-georeferenced orthophoto + TIN (see the
 * fixture): it proves that the exported texture puts the marked pixel on the
 * marked vertex, and certifies no producer. The real orthophoto + TIN pair is
 * still owed (§15.6 item 4).
 *
 * Needs the wasm runtime (`pnpm build:wasm`) and, for the IfcOpenShell half,
 * `ifcopenshell` (IFCOPENSHELL_PYTHON or python3). Each half SKIPS loudly
 * without its dependency — reported skipped, never passed.
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { strFromU8, unzipSync } from 'fflate';
import { writeArrayBuffer } from 'geotiff';
import type { AppearancePlanRunner } from './landXmlIfcImagery.js';
import { landXmlToIfcArchive, plannerMapping, writtenCoveredFraction } from './landXmlIfcImagery.js';
import { landXmlIfcSource } from './landXmlIfcPlan.js';
import { drapeProjection } from '@/lib/terrain-imagery/drape-projection.js';
import type { TerrainImageryDrape } from '@/lib/terrain-imagery/drape-state.js';
import { parseWorldFile } from '@/lib/terrain-imagery/georaster.js';
import { FEATURE, ORTHO, orthoPng, orthoRgba, orthoTerrainDocument, orthoWorldFile } from '@/lib/terrain-imagery/synthetic-orthophoto.fixture.js';

const WASM = new URL('../../../../../packages/wasm/pkg/ifc-lite_bg.wasm', import.meta.url);
const CHECKER = fileURLToPath(new URL('../../../../../tools/ifcopenshell_reference/check_terrain_texture.py', import.meta.url));
const VALIDATOR = fileURLToPath(new URL('../../../../../tools/ifcopenshell_reference/validate_export.py', import.meta.url));
const PYTHON = process.env.IFCOPENSHELL_PYTHON || 'python3';
const HAS_IFCOPENSHELL = spawnSync(PYTHON, ['-c', 'import ifcopenshell, ifcopenshell.validate'], { stdio: 'ignore' }).status === 0;
/** Set by the conformance lane, where a missing dependency is a failure, not a skip. */
const REQUIRED = process.env.REQUIRE_TERRAIN_IMAGERY_CHECK === '1';
if (REQUIRED) assert.ok(HAS_IFCOPENSHELL, `ifcopenshell is required here and not importable via "${PYTHON}"`);

function drape(image: TerrainImageryDrape['image'], overrides: Partial<TerrainImageryDrape> = {}): TerrainImageryDrape {
  const affine = parseWorldFile(orthoWorldFile());
  assert.ok(affine.ok);
  const projection = drapeProjection(
    { width: ORTHO.width, height: ORTHO.height, affine: affine.value, crs: ORTHO.crs, crsSource: 'ortho.prj', placement: 'world file' },
    ORTHO.crs,
  );
  assert.ok(projection.ok);
  return {
    sourceName: 'ortho.png', source: 'file', placement: 'world file', imageCrs: ORTHO.crs, imageCrsSource: 'ortho.prj',
    projection: projection.value, reprojected: false, totalVertices: 105, coveredVertices: 67, displayedGsd: ORTHO.gsd,
    flatColour: [0.42, 0.62, 0.32], textureId: -1, ...(image ? { image } : {}), ...overrides,
  };
}

let plan: AppearancePlanRunner | null = null;
before(async () => {
  try { await access(WASM); } catch (error) {
    if (REQUIRED) throw new Error('The wasm runtime is required here and was not built', { cause: error });
    return;
  }
  const { default: init } = await import('@ifc-lite/wasm');
  await init({ module_or_path: await readFile(WASM) });
  const { runAppearancePlanning } = await import('../../workers/appearance.worker.js');
  plan = runAppearancePlanning;
});

async function exportOrtho(image: NonNullable<TerrainImageryDrape['image']>, overrides: Partial<TerrainImageryDrape> = {}) {
  const document = orthoTerrainDocument();
  const result = await landXmlToIfcArchive(
    document, landXmlIfcSource(document),
    { sourceFileName: 'terrain.xml', timestampMs: 0, crs: { Name: ORTHO.crs } },
    'terrain.ifc', drape(image, overrides), plan!,
  );
  assert.equal(result.status, 'exported');
  assert.ok(result.status === 'exported' && result.content instanceof Uint8Array, 'imagery makes an .ifcZIP');
  return result;
}

/** Run an IfcOpenShell tool on the archive; its JSON summary or the failure. */
function ifcopenshell(script: string, args: string[]): string {
  const run = spawnSync(PYTHON, [script, ...args], { encoding: 'utf8', timeout: 60_000 });
  assert.equal(run.status, 0, `${script} failed:\n${run.stdout}\n${run.stderr}`);
  return run.stdout;
}

describe('LandXML terrain imagery in the IFC4X3 export (#5942)', () => {
  it('computes the written covered fraction and the planner mapping in metres', () => {
    const projection = drape(undefined).projection;
    // 67 of the 105 written vertices lie on the image (see the fixture).
    assert.equal(writtenCoveredFraction(orthoTerrainDocument(), projection), 67 / 105);
    assert.deepEqual(plannerMapping(projection, 0.3048), {
      kind: 'planar', frame: 'world', origin: [2_600_000 * 0.3048, 1_200_000 * 0.3048, 0],
      axisU: [1, 0, 0], axisV: [0, 1, 0], metresPerTile: [100 * 0.3048, 50 * 0.3048],
    });
  });

  it('never exports a tile drape, and says so', async () => {
    const document = orthoTerrainDocument();
    const result = await landXmlToIfcArchive(document, landXmlIfcSource(document), { timestampMs: 0 }, 'terrain.ifc',
      drape(undefined, { source: 'tiles', placement: 'tiles' }), async () => { throw new Error('the planner must not run'); });
    assert.equal(result.status, 'exported');
    if (result.status !== 'exported') return;
    assert.equal(result.extension, '.ifc');
    assert.equal(typeof result.content, 'string');
    assert.equal(result.imagery.status, 'refused');
    assert.doesNotMatch(result.content as string, /IFCIMAGETEXTURE|ImagerySourceFileName/, 'no texture and no imagery claim');
  });

  it('ships the PNG beside the TIN, textured by the appearance planner, with its provenance', async (t) => {
    if (!plan) { t.skip('Build the wasm runtime (pnpm build:wasm) to run the real appearance planner'); return; }
    const png = orthoPng();
    const result = await exportOrtho({ bytes: png, mime: 'image/png', sha256: 'f'.repeat(64) });
    const entries = unzipSync(result.content as Uint8Array);
    assert.deepEqual(Object.keys(entries).sort(), ['ortho.png', 'terrain.ifc']);
    assert.deepEqual(entries['ortho.png'], png, 'the original bytes, not a re-encode');
    const step = strFromU8(entries['terrain.ifc']);
    assert.match(step, /IFCIMAGETEXTURE\(\.F\.,\.F\.,\$,\$,\$,'ortho\.png'\)/);
    const tin = /#(\d+)=IFCTRIANGULATEDIRREGULARNETWORK\(/.exec(step)?.[1];
    assert.ok(tin);
    assert.match(step, new RegExp(`IFCINDEXEDTRIANGLETEXTUREMAP\\(\\(#\\d+\\),#${tin},#\\d+,`));
    assert.match(step, new RegExp(`IFCSTYLEDITEM\\(#${tin},`));
    assert.match(step, /IFCPROPERTYSINGLEVALUE\('ImagerySourceFileName',\$,IFCLABEL\('ortho\.png'\)/);
    assert.match(step, /IFCPROPERTYSINGLEVALUE\('ImageryCoveredFraction',\$,IFCLABEL\('0\.638095238095238'\)/);
    assert.match(step, /IFCPROPERTYSINGLEVALUE\('MappingVersion',\$,IFCLABEL\('1\.4'\)/);
    assert.equal(result.imagery.status, 'exported');
  });

  it('IfcOpenShell reopens the .ifcZIP, validates it, and resolves the marked pixel on the marked TIN vertex', async (t) => {
    if (!plan) { t.skip('Build the wasm runtime (pnpm build:wasm) to run the real appearance planner'); return; }
    if (!HAS_IFCOPENSHELL) { t.skip(`ifcopenshell not importable via "${PYTHON}" — set IFCOPENSHELL_PYTHON`); return; }
    const result = await exportOrtho({ bytes: orthoPng(), mime: 'image/png', sha256: 'f'.repeat(64) });
    const path = join(await mkdtemp(join(tmpdir(), 'ifc-lite-5942-')), 'terrain.ifczip');
    await writeFile(path, result.content as Uint8Array);
    ifcopenshell(VALIDATOR, [path]);
    const summary = JSON.parse(ifcopenshell(CHECKER, [
      path, '--feature', String(FEATURE.easting), String(FEATURE.northing),
      '--expect-pixel', String(ORTHO.marked.col), String(ORTHO.marked.row), '--expect-rgb', '255,0,0',
    ]));
    assert.deepEqual(summary.pixel, [ORTHO.marked.col, ORTHO.marked.row]);
    assert.equal(summary.repeatS, false);
    // The checker has teeth: the neighbouring pixel is refused.
    const wrong = spawnSync(PYTHON, [CHECKER, path, '--feature', String(FEATURE.easting), String(FEATURE.northing),
      '--expect-pixel', String(ORTHO.marked.col + 1), String(ORTHO.marked.row), '--expect-rgb', '255,0,0'], { encoding: 'utf8' });
    assert.equal(wrong.status, 1, wrong.stderr);
  });

  it('ships a GeoTIFF as a lossless PNG transcode, and IfcOpenShell still finds the marked pixel', async (t) => {
    if (!plan) { t.skip('Build the wasm runtime (pnpm build:wasm) to run the real appearance planner'); return; }
    const rgba = orthoRgba();
    const rgb: number[] = [];
    for (let i = 0; i < rgba.length; i += 4) rgb.push(rgba[i], rgba[i + 1], rgba[i + 2]);
    const tiff = new Uint8Array(writeArrayBuffer(rgb, {
      width: ORTHO.width, height: ORTHO.height, ModelPixelScale: [ORTHO.gsd, ORTHO.gsd, 0],
      ModelTiepoint: [0, 0, 0, ORTHO.upperLeftCorner[0], ORTHO.upperLeftCorner[1], 0], ProjectedCSTypeGeoKey: 2056,
    }));
    const result = await exportOrtho({ bytes: tiff, mime: 'image/tiff', sha256: 'e'.repeat(64) }, { sourceName: 'ortho.tif', placement: 'GeoTIFF' });
    const entries = unzipSync(result.content as Uint8Array);
    assert.deepEqual(Object.keys(entries).sort(), ['ortho.png', 'terrain.ifc']);
    const step = strFromU8(entries['terrain.ifc']);
    assert.match(step, /IFCLABEL\('ortho\.tif'\)/, 'provenance names the supplied file');
    assert.match(step, /'ImageryShippedFileName',\$,IFCLABEL\('ortho\.png'\)/);
    assert.match(step, /'ImageryShippedHash',\$,IFCLABEL\('[0-9a-f]{64}'\)/);
    if (!HAS_IFCOPENSHELL) { t.skip('ifcopenshell not importable; the transcode was checked structurally only'); return; }
    const path = join(await mkdtemp(join(tmpdir(), 'ifc-lite-5942-')), 'terrain.ifczip');
    await writeFile(path, result.content as Uint8Array);
    ifcopenshell(CHECKER, [
      path, '--feature', String(FEATURE.easting), String(FEATURE.northing),
      '--expect-pixel', String(ORTHO.marked.col), String(ORTHO.marked.row), '--expect-rgb', '255,0,0',
    ]);
  });
});
