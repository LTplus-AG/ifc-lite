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

  it('writes back the attribute fields the read tool reports, and says the read-only members are not inputs', async () => {
    await session('ifc4-georef.ifc');
    const { georef } = await structured<{ georef: GeoreferencingState }>('georeferencing', {});
    expect(tool('georeferencing').description).toMatch(/read-only members \(type, expressId, mapUnitResolved/);
    // The whole state is not a valid input: its read-only members are refused by the schema.
    const schema = tool('georeferencing_write').inputSchema as { properties: Record<string, { properties?: Record<string, unknown> }> };
    expect(Object.keys(georef.ProjectedCRS ?? {}).filter((k) => !(k in (schema.properties.ProjectedCRS.properties ?? {})))).toEqual(
      expect.arrayContaining(['type', 'expressId', 'mapUnitResolved']),
    );
    // Its attribute fields are.
    const pick = (obj: object, allowed: Record<string, unknown>) => Object.fromEntries(Object.entries(obj).filter(([k]) => k in allowed));
    const crs = pick(georef.ProjectedCRS ?? {}, schema.properties.ProjectedCRS.properties ?? {});
    const mc = pick(georef.MapConversion ?? {}, schema.properties.MapConversion.properties ?? {});
    const updated = await structured<{ georef: GeoreferencingState }>('georeferencing_write', { action: 'update', ProjectedCRS: crs, MapConversion: mc });
    expect(updated.georef.MapConversion).toMatchObject({ Eastings: 1, Northings: 2, OrthogonalHeight: 3 });
  });

  it('refuses keys bim.georef does not write, even when the call skips schema validation', async () => {
    await session('ifc4.ifc');
    const err = await refused({ action: 'set', epsg: 2056, ProjectedCRS: { MapUnit: 'METRE' }, MapConversion: { Eastings: 1, Northings: 2, OrthogonalHeight: 3, Rotation: 12 } });
    expect(err.details).toMatchObject({ georefCode: 'INVALID_INPUT', missing: ['MapConversion.Rotation'] });
  });
});

describe('georeferencing_check / georeferencing_fix', () => {
  type Plan = { fixes: Array<{ id: string; status: string; needs?: Array<{ path: string }> }> };
  type Check = { report: { findings: Array<{ code: string }>; skipped: unknown[] }; plan: Plan };

  it('checks, refuses to apply what needs a value, applies it once supplied, and the saved file checks clean', async () => {
    await writeFile(join(tmp, 'zone.ifc'), header('IFC4') + BODY.replace('ENDSEC;', `#50= IFCPROJECTEDCRS('EPSG:25832',$,$,$,$,$,#31);
#51= IFCMAPCONVERSION(#20,#50,32461000.,5481000.,100.,$,$,$);
ENDSEC;`), 'utf-8');
    await session('zone.ifc');
    const check = await structured<Check>('georeferencing_check', {});
    expect(check.report.findings.map((f) => f.code)).toContain('EASTING_ZONE_PREFIX');
    expect(check.plan.fixes.find((f) => f.id === 'EASTING_ZONE_PREFIX.1')?.status).toBe('ready');

    const fixed = await structured<{ applied: string[]; after: Check }>('georeferencing_fix', {});
    expect(fixed.applied).toContain('EASTING_ZONE_PREFIX.1');
    expect(fixed.after.report.findings.map((f) => f.code)).not.toContain('EASTING_ZONE_PREFIX');

    await structured('model_save', { file_path: join(tmp, 'zone-fixed.ifc') });
    await session('zone-fixed.ifc');
    const reread = await structured<Check>('georeferencing_check', {});
    expect(reread.report.findings.map((f) => f.code)).not.toContain('EASTING_ZONE_PREFIX');
  });

  it('a fix waiting for a value is not applied until values carries it', async () => {
    await writeFile(join(tmp, 'crs-only.ifc'), header('IFC4') + BODY.replace('ENDSEC;', `#50= IFCPROJECTEDCRS('EPSG:2056',$,$,$,$,$,#31);
ENDSEC;`), 'utf-8');
    await session('crs-only.ifc');
    const nothing = await structured<{ applied: string[]; plan: Plan }>('georeferencing_fix', {});
    expect(nothing.applied).toEqual([]);
    expect(nothing.plan.fixes.find((f) => f.id === 'CRS_WITHOUT_OPERATION.1')?.needs?.map((n) => n.path)).toEqual(['MapConversion.Eastings', 'MapConversion.Northings', 'MapConversion.OrthogonalHeight']);
    const done = await structured<{ applied: string[]; after: Check }>('georeferencing_fix', {
      values: { 'MapConversion.Eastings': 2600000, 'MapConversion.Northings': 1199650, 'MapConversion.OrthogonalHeight': 540 },
    });
    expect(done.applied).toEqual(['CRS_WITHOUT_OPERATION.1']);
    expect(done.after.report.findings.map((f) => f.code)).not.toContain('CRS_WITHOUT_OPERATION');
  });

  it('georeferencing_write action "site" writes the IfcSite position', async () => {
    await session('ifc4.ifc');
    const written = await structured<{ site: { siteId: number; after: { RefLatitude: number } } }>('georeferencing_write', { action: 'site', Site: { RefLatitude: 46.948, RefLongitude: 7.4474 } });
    expect(written.site).toMatchObject({ siteId: 40, after: { RefLatitude: 46.948 } });
    const read = await structured<{ georef: GeoreferencingState }>('georeferencing', {});
    expect(read.georef.site).toMatchObject({ expressId: 40 });
  });
});

// PR #10537: MCP values objects can reach the handler without entry validation.
it('does not turn a null user coordinate into latitude zero', async () => {
  const file = join(tmp, 'null-values.ifc');
  await writeFile(file, header('IFC4') + BODY.replace('.ELEMENT.,$,$,$,$,$)', '.ELEMENT.,(42,21,30,240000),(-71,-3,-35,-280000),0.,$,$)'));
  await session('null-values.ifc');
  const result = await structured<{ applied: string[]; plan: { fixes: Array<{ code: string; status: string }> } }>('georeferencing_fix', { values: { 'IfcSite.RefLatitude': null, 'IfcSite.RefLongitude': 8 } });
  expect(result.applied).toEqual([]);
  expect(result.plan.fixes.find((f) => f.code === 'SITE_LOCATION_DEFAULT')?.status).toBe('needs-value');
});
