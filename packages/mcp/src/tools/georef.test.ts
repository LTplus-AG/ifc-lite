/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `georeferencing_write` + `georeferencing`: write through the tool, read the
 * session back through the read tool, save with `model_save`, reload the
 * saved file and read it again — the loop an agent runs instead of passing
 * the map origin around as a JSON side file.
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { GeoreferencingState } from '@ifc-lite/sdk';
import type { ToolContext } from '../context.js';
import { DEFAULT_CONFIG, InMemoryModelRegistry, NOOP_PROGRESS, SILENT_LOGGER } from '../context.js';
import { fullScope } from '../auth/scope.js';
import { loadIfcModel } from '../loader.js';
import { ToolExecutionError } from '../errors.js';
import { queryTools } from './query-tools.js';
import { mutationTools } from './mutate.js';
import { exportTools } from './export.js';

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

const ALL_TOOLS = [...queryTools, ...mutationTools, ...exportTools];
let tmp: string;
let ctx: ToolContext;

function tool(name: string) {
  const found = ALL_TOOLS.find((t) => t.name === name);
  if (!found) throw new Error(`${name} not registered`);
  return found;
}

async function structured<T>(name: string, input: Record<string, unknown>): Promise<T> {
  const result = await tool(name).handler(input, ctx);
  expect(result.isError, `${name}: ${JSON.stringify(result.structuredContent)}`).toBeUndefined();
  return result.structuredContent as unknown as T;
}

async function session(file: string): Promise<void> {
  ctx = {
    registry: new InMemoryModelRegistry(),
    scope: fullScope(),
    progress: NOOP_PROGRESS,
    log: SILENT_LOGGER,
    signal: new AbortController().signal,
    config: { ...DEFAULT_CONFIG, allowedPaths: [tmp] },
  };
  ctx.registry.add(await loadIfcModel(join(tmp, file), { modelId: 'm' }));
}

async function refused(input: Record<string, unknown>): Promise<ToolExecutionError> {
  try {
    await tool('georeferencing_write').handler(input, ctx);
  } catch (err) {
    if (err instanceof ToolExecutionError) return err;
    throw err;
  }
  throw new Error('expected georeferencing_write to refuse');
}

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'ifc-lite-mcp-georef-'));
  await writeFile(join(tmp, 'ifc4.ifc'), header('IFC4') + BODY, 'utf-8');
  await writeFile(join(tmp, 'ifc2x3.ifc'), header('IFC2X3') + BODY, 'utf-8');
  await writeFile(join(tmp, 'ifc4-georef.ifc'), header('IFC4') + BODY.replace('ENDSEC;', `#50= IFCPROJECTEDCRS('EPSG:2056',$,$,$,$,$,#31);
#51= IFCMAPCONVERSION(#20,#50,1.,2.,3.,$,$,$);
ENDSEC;`), 'utf-8');
});

afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe('georeferencing_write', () => {
  it('sets, reads back from the session, saves, and reads back from the saved file (IFC4)', async () => {
    await session('ifc4.ifc');
    expect((await structured<{ georef: GeoreferencingState }>('georeferencing', {})).georef.hasGeoreference).toBe(false);
    const written = await structured<{ storage: string; georef: GeoreferencingState }>('georeferencing_write', {
      action: 'set',
      epsg: 2056,
      ProjectedCRS: { GeodeticDatum: 'CH1903+', VerticalDatum: 'LN02', MapUnit: 'METRE' },
      MapConversion: { Eastings: 2600000.5, Northings: 1200000.25, OrthogonalHeight: 431 },
      rotationDegrees: 90,
    });
    expect(written.storage).toBe('entities');

    const read = await structured<{ georef: GeoreferencingState; georeferencing: unknown }>('georeferencing', {});
    expect(read.georef).toMatchObject({
      pending: true,
      source: 'IfcMapConversion',
      ProjectedCRS: { Name: 'EPSG:2056', GeodeticDatum: 'CH1903+', VerticalDatum: 'LN02', MapUnit: 'METRE' },
      MapConversion: { Eastings: 2600000.5, Northings: 1200000.25, OrthogonalHeight: 431, XAxisAbscissa: 0, XAxisOrdinate: 1 },
      rotationDegrees: 90,
    });
    // The parser's source-only reading stays what it was: nothing saved yet.
    expect(read.georeferencing).toMatchObject({ hasGeoreference: false });

    await structured('model_save', { file_path: join(tmp, 'ifc4-geo.ifc') });
    await session('ifc4-geo.ifc');
    const saved = await structured<{ georef: GeoreferencingState }>('georeferencing', {});
    expect(saved.georef).toMatchObject({
      pending: false,
      ProjectedCRS: { type: 'IfcProjectedCRS', Name: 'EPSG:2056', GeodeticDatum: 'CH1903+', VerticalDatum: 'LN02', MapUnit: 'METRE' },
      MapConversion: { type: 'IfcMapConversion', Eastings: 2600000.5, Northings: 1200000.25, OrthogonalHeight: 431, XAxisAbscissa: 0, XAxisOrdinate: 1 },
    });

    // The saved file now refuses a second set, and accepts an update.
    const again = await refused({ action: 'set', epsg: 2056, ProjectedCRS: { MapUnit: 'METRE' }, MapConversion: { Eastings: 1, Northings: 2, OrthogonalHeight: 3 } });
    expect(again.details).toMatchObject({ georefCode: 'ALREADY_GEOREFERENCED', missing: ['replace'] });
    const updated = await structured<{ georef: GeoreferencingState }>('georeferencing_write', { action: 'update', MapConversion: { OrthogonalHeight: 432 } });
    expect(updated.georef.MapConversion).toMatchObject({ Eastings: 2600000.5, OrthogonalHeight: 432 });
  });

  it('writes the IFC2X3 property-set convention and export_ifc carries it', async () => {
    await session('ifc2x3.ifc');
    const written = await structured<{ storage: string }>('georeferencing_write', {
      action: 'set',
      ProjectedCRS: { Name: 'EPSG:2056', MapUnit: 'METRE' },
      MapConversion: { Eastings: 2600000, Northings: 1200000, OrthogonalHeight: 400, XAxisAbscissa: 1, XAxisOrdinate: 0 },
    });
    expect(written.storage).toBe('propertySets');
    await structured('export_ifc', { file_path: join(tmp, 'ifc2x3-geo.ifc') });
    await session('ifc2x3-geo.ifc');
    const saved = await structured<{ georef: GeoreferencingState }>('georeferencing', {});
    expect(saved.georef).toMatchObject({
      source: 'ePSet_MapConversion',
      ProjectedCRS: { type: 'ePSet_ProjectedCRS', Name: 'EPSG:2056', MapUnit: 'METRE' },
      MapConversion: { Eastings: 2600000, Northings: 1200000, OrthogonalHeight: 400, XAxisAbscissa: 1, XAxisOrdinate: 0 },
    });
  });

  it('refuses with the missing input named, and queues nothing', async () => {
    await session('ifc4.ifc');
    const noUnit = await refused({ action: 'set', epsg: 2056, MapConversion: { Eastings: 1, Northings: 2, OrthogonalHeight: 3 } });
    expect(noUnit.code).toBe('INVALID_INPUT');
    expect(noUnit.details).toMatchObject({ georefCode: 'MISSING_INPUT', missing: ['ProjectedCRS.MapUnit'] });
    const factors = await refused({ action: 'set', epsg: 2056, ProjectedCRS: { MapUnit: 'METRE' }, MapConversion: { Eastings: 1, Northings: 2, OrthogonalHeight: 3, FactorX: 1, FactorY: 1, FactorZ: 1 } });
    expect(factors.code).toBe('UNSUPPORTED_OPERATION');
    const both = await refused({ action: 'set', epsg: 2056, ProjectedCRS: { Name: 'EPSG:2056', MapUnit: 'METRE' }, MapConversion: { Eastings: 1, Northings: 2, OrthogonalHeight: 3 } });
    expect(both.message).toContain('not both');
    expect(await refused({ action: 'remove', replace: true })).toBeInstanceOf(ToolExecutionError);
    const read = await structured<{ georef: GeoreferencingState }>('georeferencing', {});
    expect(read.georef).toMatchObject({ hasGeoreference: false, pending: false });
  });

  it('mutation_undo takes a replace back whole: the saved file and the read tool agree', async () => {
    await session('ifc4-georef.ifc');
    const before = (await structured<{ georef: GeoreferencingState }>('georeferencing', {})).georef;
    await structured('georeferencing_write', {
      action: 'set', replace: true, epsg: 2056, ProjectedCRS: { MapUnit: 'METRE' },
      MapConversion: { Eastings: 2600000, Northings: 1200000, OrthogonalHeight: 400 },
    });
    await structured('mutation_undo', { n: 1 });
    const after = (await structured<{ georef: GeoreferencingState }>('georeferencing', {})).georef;
    expect(after).toEqual(before);
    await structured('model_save', { file_path: join(tmp, 'ifc4-undone.ifc') });
    const text = await readFile(join(tmp, 'ifc4-undone.ifc'), 'utf-8');
    expect(text).toContain("IFCPROJECTEDCRS('EPSG:2056'");
    expect(text).toMatch(/IFCMAPCONVERSION\(#20,#50,1\.,2\.,3\./);
  });

  it('refuses keys bim.georef does not write, even when the call skips schema validation', async () => {
    await session('ifc4.ifc');
    const err = await refused({ action: 'set', epsg: 2056, ProjectedCRS: { MapUnit: 'METRE' }, MapConversion: { Eastings: 1, Northings: 2, OrthogonalHeight: 3, Rotation: 12 } });
    expect(err.details).toMatchObject({ georefCode: 'INVALID_INPUT', missing: ['MapConversion.Rotation'] });
  });
});
