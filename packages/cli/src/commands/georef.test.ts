/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `ifc-lite georef` end to end: the command writes a file, `georef show
 * --json` and `info --json` read it back; a refusal exits 1 and writes
 * nothing.
 */

import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { GeoreferencingState } from '@ifc-lite/sdk';
import { georefCommand } from './georef.js';
import { infoCommand } from './info.js';

const header = (schema: string) => `ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('m','2026',(''),(''),'','','');
FILE_SCHEMA(('${schema}'));
ENDSEC;
DATA;
`;
const BODY = `#1= IFCPROJECT('0YvCT2_$X3_xJG3rzD8L_8',$,'Proj',$,$,$,$,(#20),#30);
#20= IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-5,#21,$);
#21= IFCAXIS2PLACEMENT3D(#22,$,$);
#22= IFCCARTESIANPOINT((0.,0.,0.));
#30= IFCUNITASSIGNMENT((#31));
#31= IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#40= IFCSITE('1Pbuu0tu59NfhrTsztVBK1',$,'Site',$,$,$,$,$,.ELEMENT.,$,$,$,$,$);
#41= IFCRELAGGREGATES('2Pbuu0tu59NfhrTsztVBK1',$,$,$,#1,(#40));
ENDSEC;
END-ISO-10303-21;
`;
const BUILDING_ARCHITECTURE = new URL('../../../../tests/models/buildingsmart/Building-Architecture.ifc', import.meta.url);

let dir: string;
let stdout: string;
let stderr: string;

class Exit extends Error {
  constructor(readonly code: number | undefined) { super(`exit ${code}`); }
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ifc-lite-cli-georef-'));
  await writeFile(join(dir, 'ifc4.ifc'), header('IFC4') + BODY);
  await writeFile(join(dir, 'ifc2x3.ifc'), header('IFC2X3') + BODY);
});
afterAll(async () => { await rm(dir, { recursive: true, force: true }); });

function capture() {
  stdout = '';
  stderr = '';
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => { stdout += String(chunk); return true; });
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => { stderr += String(chunk); return true; });
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => { throw new Exit(code); }) as never);
}
afterEach(() => { vi.restoreAllMocks(); });

async function run(args: string[]): Promise<void> {
  capture();
  await georefCommand(args);
}

async function exitCode(args: string[]): Promise<number | undefined> {
  capture();
  try {
    await georefCommand(args);
  } catch (err) {
    if (err instanceof Exit) return err.code;
    throw err;
  }
  return 0;
}

async function show(file: string): Promise<GeoreferencingState> {
  await run(['show', file, '--json']);
  return (JSON.parse(stdout) as { georeferencing: GeoreferencingState }).georeferencing;
}

const p = (name: string) => join(dir, name);

describe('ifc-lite georef', () => {
  it('set writes IfcProjectedCRS + IfcMapConversion that show and info read back', async () => {
    await run(['set', p('ifc4.ifc'), '--epsg', '2056', '--map-unit', 'METRE', '--geodetic-datum', 'CH1903+',
      '--eastings', '2600000', '--northings', '1200000', '--height', '400', '--rotation', '-15', '--scale', '0.9999',
      '--out', p('ifc4-geo.ifc')]);
    expect(stderr).toContain('MapUnit METRE (given explicitly)');
    const state = await show(p('ifc4-geo.ifc'));
    expect(state).toMatchObject({
      source: 'IfcMapConversion',
      ProjectedCRS: { Name: 'EPSG:2056', GeodeticDatum: 'CH1903+', MapUnit: 'METRE' },
      MapConversion: { Eastings: 2600000, Northings: 1200000, OrthogonalHeight: 400, Scale: 0.9999 },
    });
    expect(state.rotationDegrees).toBeCloseTo(-15, 10);

    capture();
    await infoCommand([p('ifc4-geo.ifc'), '--json']);
    expect(JSON.parse(stdout).georeferencing).toMatchObject({ ProjectedCRS: { Name: 'EPSG:2056' } });
    capture();
    await infoCommand([p('ifc4.ifc'), '--json']);
    expect(JSON.parse(stdout).georeferencing).toBeNull();
  });

  it('show and info do not present the reader\'s METRE fallback as the file\'s unit when MapUnit is unresolved', async () => {
    await writeFile(p('chain.ifc'), header('IFC4') + BODY.replace('ENDSEC;', `#60= IFCCONTEXTDEPENDENTUNIT(#61,.LENGTHUNIT.,'CHAIN');
#61= IFCDIMENSIONALEXPONENTS(1,0,0,0,0,0,0);
#50= IFCPROJECTEDCRS('EPSG:2056',$,$,$,$,$,#60);
#51= IFCMAPCONVERSION(#20,#50,1.,2.,3.,$,$,$);
ENDSEC;`));
    const state = await show(p('chain.ifc'));
    expect(state.ProjectedCRS?.mapUnitResolved).toBe(false);
    capture();
    await georefCommand(['show', p('chain.ifc')]);
    expect(stdout).toMatch(/MapUnit\s+\S+ \(unresolved in the file; reader fallback, not its unit\)/);
    capture();
    await infoCommand([p('chain.ifc')]);
    expect(stdout).toContain('(unresolved in the file; reader fallback, not its unit)');
  });

  it('update changes one value and keeps the rest; remove takes it out', async () => {
    await run(['update', p('ifc4-geo.ifc'), '--x-axis-abscissa', '0', '--x-axis-ordinate', '1', '--out', p('ifc4-upd.ifc'), '--json']);
    expect(JSON.parse(stdout)).toMatchObject({ action: 'update', mapUnit: { source: 'existing' } });
    expect(await show(p('ifc4-upd.ifc'))).toMatchObject({
      MapConversion: { Eastings: 2600000, XAxisAbscissa: 0, XAxisOrdinate: 1, Scale: 0.9999 },
      rotationDegrees: 90,
    });
    await run(['remove', p('ifc4-upd.ifc'), '--out', p('ifc4-rm.ifc')]);
    expect((await show(p('ifc4-rm.ifc'))).hasGeoreference).toBe(false);
  });

  it('writes the IFC2X3 ePSet convention', async () => {
    await run(['set', p('ifc2x3.ifc'), '--crs', 'EPSG:2056', '--map-unit', 'METRE', '--eastings', '1', '--northings', '2', '--height', '3', '--out', p('ifc2x3-geo.ifc')]);
    expect(await show(p('ifc2x3-geo.ifc'))).toMatchObject({
      source: 'ePSet_MapConversion',
      storage: 'propertySets',
      ProjectedCRS: { Name: 'EPSG:2056', MapUnit: 'METRE' },
      MapConversion: { Eastings: 1, Northings: 2, OrthogonalHeight: 3 },
    });
  });

  it.each([
    ['a missing map unit', ['set', 'ifc4.ifc', '--epsg', '2056', '--eastings', '1', '--northings', '2', '--height', '3'], /MapUnit is required/],
    ['an unknown flag', ['set', 'ifc4.ifc', '--epsg', '2056', '--map-unit', 'METRE', '--easting', '1'], /--easting/],
    ['a non-numeric value', ['set', 'ifc4.ifc', '--epsg', '2056', '--map-unit', 'METRE', '--eastings', 'east', '--northings', '2', '--height', '3'], /--eastings must be a number/],
    ['a hexadecimal value', ['set', 'ifc4.ifc', '--epsg', '2056', '--map-unit', 'METRE', '--eastings', '0x10', '--northings', '2', '--height', '3'], /--eastings must be a number/],
    ['a binary value', ['set', 'ifc4.ifc', '--epsg', '2056', '--map-unit', 'METRE', '--eastings', '0b11', '--northings', '2', '--height', '3'], /--eastings must be a number/],
    ['an octal value', ['set', 'ifc4.ifc', '--epsg', '2056', '--map-unit', 'METRE', '--eastings', '0o17', '--northings', '2', '--height', '3'], /--eastings must be a number/],
    ['--replace on update', ['update', 'ifc4-geo.ifc', '--height', '1', '--replace'], /--replace/],
    ['a second georeferencing', ['set', 'ifc4-geo.ifc', '--epsg', '2056', '--map-unit', 'METRE', '--eastings', '1', '--northings', '2', '--height', '3'], /already georeferenced/],
    ['--crs and --epsg together', ['set', 'ifc4.ifc', '--crs', 'EPSG:2056', '--epsg', '2056'], /not both/],
  ])('refuses %s, exits 1 and writes nothing', async (_name, args, message) => {
    const out = p(`refused-${Math.random().toString(36).slice(2)}.ifc`);
    const [sub, file, ...rest] = args;
    expect(await exitCode([sub, p(file), ...rest, '--out', out])).toBe(1);
    expect(stderr).toMatch(message);
    expect(existsSync(out)).toBe(false);
  });

  it('refuses --out followed by another flag instead of writing a file named after it', async () => {
    const cwdFile = '--json';
    expect(await exitCode(['set', p('ifc4.ifc'), '--epsg', '2056', '--map-unit', 'METRE', '--eastings', '1', '--northings', '2', '--height', '3', '--out', '--json'])).toBe(1);
    expect(stderr).toMatch(/--out needs a value/);
    expect(existsSync(cwdFile)).toBe(false);
  });

  it('show refuses --out, and an unknown subcommand is named', async () => {
    expect(await exitCode(['show', p('ifc4.ifc'), '--out', p('x.json')])).toBe(1);
    expect(await exitCode(['frobnicate', p('ifc4.ifc')])).toBe(1);
    expect(stderr).toContain('show, set, update, remove, check, fix');
  });

  it('prints its own help', async () => {
    await run(['--help']);
    expect(stdout).toContain('ifc-lite georef set');
    expect(stdout).toContain('--factor-x');
  });

  (existsSync(BUILDING_ARCHITECTURE) ? it : it.skip)('replaces a real IFC4 georeferencing, carrying the same-named CRS unit (MILLIMETRE)', async () => {
    const file = BUILDING_ARCHITECTURE.pathname;
    await run(['set', file, '--epsg', '32760', '--eastings', '729000000', '--northings', '9064000000', '--height', '1300', '--replace', '--out', p('ba.ifc'), '--json']);
    expect(JSON.parse(stdout)).toMatchObject({
      removed: ['IfcMapConversion #19', 'IfcProjectedCRS #18'],
      mapUnit: { value: 'MILLIMETRE', source: 'existing' },
    });
    expect(await show(p('ba.ifc'))).toMatchObject({
      ProjectedCRS: { Name: 'EPSG:32760', MapUnit: 'MILLIMETRE' },
      MapConversion: { Eastings: 729000000, Northings: 9064000000, OrthogonalHeight: 1300 },
    });
  });
});
