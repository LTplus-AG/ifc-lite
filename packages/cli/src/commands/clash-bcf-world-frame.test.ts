/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `ifc-lite clash --bcf` writes BCF cameras in IFC world coordinates (#4879).
 *
 * The mesher shifts a georeferenced model towards the origin (wasm RTC
 * offset, then `CoordinateHandler`'s origin shift), so clash bounds are
 * render-frame values. Written raw, the `.bcfv` camera sat hundreds of
 * kilometres from the building in every other BCF tool. The model below is
 * the #4806 reporter's situation: an IfcSite placed at about
 * (41266, 308208, 126) with two overlapping boxes on it.
 */

import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readBCF, type BCFPoint, type BCFProject } from '@ifc-lite/bcf';
import { GeometryProcessor, type GeometryResult } from '@ifc-lite/geometry';
import { clashCommand } from './clash.js';

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI_ENTRY = join(__dirname, '../../dist/index.js');
const WASM_RUNTIME = join(__dirname, '../../../wasm/pkg/ifc-lite_bg.wasm');

const SITE = { x: 41266.679, y: 308208.972, z: 125.95 };

/**
 * Box A spans x [-1, 1], box B x [0, 2]; both y [-1, 1], z [0, 2] in site
 * coordinates. They overlap in x [0, 1], so every clash reading (overlap
 * box, union box, contact point) is centred within a metre or two of
 * SITE + (0.5, 0, 1).
 */
const WORLD_CLASH_CENTRE: BCFPoint = { x: SITE.x + 0.5, y: SITE.y, z: SITE.z + 1 };

function farSiteModel(): string {
  return [
    'ISO-10303-21;',
    'HEADER;',
    "FILE_DESCRIPTION(('ViewDefinition [DesignTransferView]'),'2;1');",
    "FILE_NAME('far-site.ifc','2026-09-16T00:00:00',(''),(''),'','','');",
    "FILE_SCHEMA(('IFC4'));",
    'ENDSEC;',
    'DATA;',
    "#1=IFCPROJECT('0YvctVUKr0kugbFTf53O9L',$,'Far site',$,$,$,$,(#20),#10);",
    '#10=IFCUNITASSIGNMENT((#11));',
    '#11=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);',
    "#20=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-05,#21,$);",
    '#21=IFCAXIS2PLACEMENT3D(#22,$,$);',
    '#22=IFCCARTESIANPOINT((0.,0.,0.));',
    "#30=IFCSITE('2VxD8pZ7X0ZuC5mW3Qm0aa',$,'Site',$,$,#31,$,$,.ELEMENT.,$,$,$,$,$);",
    '#31=IFCLOCALPLACEMENT($,#32);',
    '#32=IFCAXIS2PLACEMENT3D(#33,$,$);',
    `#33=IFCCARTESIANPOINT((${SITE.x},${SITE.y},${SITE.z}));`,
    "#40=IFCRELAGGREGATES('3x9sQ1mUj4Hh2Lr8Gf0Wbb',$,$,$,#1,(#30));",
    "#50=IFCBUILDINGELEMENTPROXY('1a2B3c4D5e6F7g8H9i0Jcc',$,'Box A',$,$,#51,#60,$,$);",
    '#51=IFCLOCALPLACEMENT(#31,#52);',
    '#52=IFCAXIS2PLACEMENT3D(#22,$,$);',
    "#60=IFCPRODUCTDEFINITIONSHAPE($,$,(#61));",
    "#61=IFCSHAPEREPRESENTATION(#20,'Body','SweptSolid',(#62));",
    '#62=IFCEXTRUDEDAREASOLID(#63,#21,#65,2.);',
    '#63=IFCRECTANGLEPROFILEDEF(.AREA.,$,$,2.,2.);',
    '#65=IFCDIRECTION((0.,0.,1.));',
    "#70=IFCBUILDINGELEMENTPROXY('2k3L4m5N6o7P8q9R0s1Tdd',$,'Box B',$,$,#71,#60,$,$);",
    '#71=IFCLOCALPLACEMENT(#31,#72);',
    '#72=IFCAXIS2PLACEMENT3D(#73,$,$);',
    '#73=IFCCARTESIANPOINT((1.,0.,0.));',
    "#90=IFCRELCONTAINEDINSPATIALSTRUCTURE('0u1V2w3X4y5Z6a7B8c9Dee',$,$,$,(#50,#70),#30);",
    'ENDSEC;',
    'END-ISO-10303-21;',
    '',
  ].join('\n');
}

async function readBcfFile(path: string): Promise<BCFProject> {
  const data = await readFile(path);
  const bytes = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
  return readBCF(bytes);
}

function distance(a: BCFPoint, b: BCFPoint): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

/** Every clash topic's camera: eye near the world clash, looking at it. */
function expectWorldCameras(project: BCFProject): void {
  const cameras = [...project.topics.values()].flatMap((topic) =>
    topic.viewpoints.map((vp) => vp.perspectiveCamera),
  );
  expect(cameras.length).toBeGreaterThan(0);
  for (const camera of cameras) {
    expect(camera).toBeDefined();
    const eye = camera!.cameraViewPoint;
    expect(distance(eye, WORLD_CLASH_CENTRE)).toBeLessThan(15);
    // The eye looks at the clash: the closest point on its view ray is
    // within a couple of metres of the world clash centre.
    const d = camera!.cameraDirection;
    const len = Math.hypot(d.x, d.y, d.z);
    const t = ((WORLD_CLASH_CENTRE.x - eye.x) * d.x + (WORLD_CLASH_CENTRE.y - eye.y) * d.y + (WORLD_CLASH_CENTRE.z - eye.z) * d.z) / (len * len);
    const closest = { x: eye.x + d.x * t, y: eye.y + d.y * t, z: eye.z + d.z * t };
    expect(t).toBeGreaterThan(0);
    expect(distance(closest, WORLD_CLASH_CENTRE)).toBeLessThan(2.5);
  }
}

describe('clash --bcf writes world-coordinate cameras for a far-from-origin site (#4879)', () => {
  beforeAll(() => {
    const missing = [CLI_ENTRY, WASM_RUNTIME].filter((path) => !existsSync(path));
    if (missing.length > 0) {
      throw new Error(`missing build artifacts ${missing.join(', ')}: run \`pnpm turbo run build --filter=@ifc-lite/cli\` (and \`bash scripts/build-wasm.sh\`) first`);
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('end to end through the built CLI: the .bcfv camera is at the world clash, not near 0,0,0', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ifc-lite-clash-world-'));
    const modelPath = join(dir, 'far-site.ifc');
    const bcfPath = join(dir, 'clashes.bcfzip');
    try {
      await writeFile(modelPath, farSiteModel());
      await execFileAsync(
        process.execPath,
        [CLI_ENTRY, 'clash', modelPath, '--group', 'rule', '--bcf', bcfPath],
        { timeout: 120_000, maxBuffer: 64 * 1024 * 1024 },
      );
      const project = await readBcfFile(bcfPath);
      expect(project.topics.size).toBeGreaterThan(0);
      expectWorldCameras(project);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 180_000);

  it('adds a CoordinateHandler origin shift on top of the RTC offset, not just the RTC offset', async () => {
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    // A large Y-up origin shift layered over the real RTC-shifted meshes: the
    // render frame moves by -shift, and `coordinateInfo` records it, exactly
    // as `CoordinateHandler.processMeshes` does for coordinates still large
    // after the wasm RTC pass.
    const shift = { x: 1800, y: -35, z: -2600 };
    const realProcess = GeometryProcessor.prototype.process;
    let rtcSeen = false;
    vi.spyOn(GeometryProcessor.prototype, 'process').mockImplementation(async function (
      this: GeometryProcessor,
      ...args: Parameters<GeometryProcessor['process']>
    ): Promise<GeometryResult> {
      const result = await realProcess.apply(this, args);
      rtcSeen = Boolean(result.coordinateInfo.wasmRtcOffset);
      for (const mesh of result.meshes) {
        if (mesh.origin) {
          mesh.origin = [mesh.origin[0] - shift.x, mesh.origin[1] - shift.y, mesh.origin[2] - shift.z];
        } else {
          for (let i = 0; i < mesh.positions.length; i += 3) {
            mesh.positions[i] -= shift.x;
            mesh.positions[i + 1] -= shift.y;
            mesh.positions[i + 2] -= shift.z;
          }
        }
      }
      result.coordinateInfo = { ...result.coordinateInfo, originShift: shift };
      return result;
    });

    const dir = await mkdtemp(join(tmpdir(), 'ifc-lite-clash-world-shift-'));
    // Unique basename: `meshModel` caches by basename within the process.
    const modelPath = join(dir, 'far-site-origin-shift.ifc');
    const bcfPath = join(dir, 'clashes.bcfzip');
    try {
      await writeFile(modelPath, farSiteModel());
      await clashCommand([modelPath, '--group', 'rule', '--bcf', bcfPath]);
      expect(rtcSeen).toBe(true);
      expectWorldCameras(await readBcfFile(bcfPath));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 120_000);
});
