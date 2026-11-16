/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The georeferencing doctor end to end on `@ifc-lite/georef-check`'s
 * synthetic fixtures and real Revit exports, with the real EPSG catalogue
 * (`@ifc-lite/data`) and CRS engine (`@ifc-lite/geo`), offline:
 * check → plan → fix → export → re-parse → check again.
 */

import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { resolveCrs } from '@ifc-lite/geo';
import { deriveSitePosition } from './site-derivation.js';
import { openModel, type HeadlessModelSession } from '../../headless.js';
import type { GeorefCheckReport, GeorefFixPlanOptions, GeorefPlannedFix } from '../types.js';

const FIXTURES = new URL('../../../../georef-check/fixtures/', import.meta.url);
const REPO = new URL('../../../../../', import.meta.url);

async function open(bytes: Uint8Array): Promise<HeadlessModelSession> {
  return openModel(bytes, { disableWorkerScan: true });
}
const fixture = (name: string) => new Uint8Array(readFileSync(new URL(`${name}.ifc`, FIXTURES)));
const codes = (r: GeorefCheckReport) => r.findings.map((f) => f.code);
const fix = (plan: { fixes: GeorefPlannedFix[] }, id: string) => plan.fixes.find((f) => f.id === id) as GeorefPlannedFix;

/** Fix, export, re-open the written bytes and check them: what a saved file says. */
async function fixAndRecheck(model: HeadlessModelSession, options: GeorefFixPlanOptions = {}) {
  const report = await model.bim.georef.check();
  const plan = model.bim.georef.planFixes(report, options);
  const result = model.bim.georef.fix(plan);
  const text = String(model.bim.export.ifc());
  const reopened = await open(new TextEncoder().encode(text));
  try {
    return { report, plan, result, text, after: await reopened.bim.georef.check() };
  } finally { reopened.close(); }
}

describe('the taught failure modes: check → fix where fixable → check again', () => {
  it('map conversion missing (a CRS, nothing placed in it): fixed once the user supplies the map position', async () => {
    const model = await open(fixture('crs-only'));
    try {
      const report = await model.bim.georef.check();
      const planned = fix(model.bim.georef.planFixes(report), 'CRS_WITHOUT_OPERATION.1');
      expect(planned.status).toBe('needs-value');
      expect(planned.needs?.map((n) => n.path)).toEqual(['MapConversion.Eastings', 'MapConversion.Northings', 'MapConversion.OrthogonalHeight']);
      const { result, after } = await fixAndRecheck(model, { values: { 'MapConversion.Eastings': 2_600_000, 'MapConversion.Northings': 1_199_650, 'MapConversion.OrthogonalHeight': 540 } });
      expect(result.applied).toEqual(['CRS_WITHOUT_OPERATION.1']);
      expect(codes(after)).toEqual([]);
      expect(after.level).toBe(50);
    } finally { model.close(); }
  });

  it('scale/unit slip: Scale set to the unit conversion, no value needed', async () => {
    const model = await open(fixture('scale-inverted'));
    try {
      const { report, result, after } = await fixAndRecheck(model);
      expect(codes(report)).toEqual(['SCALE_UNIT_MISMATCH']);
      expect(result.applied).toEqual(['SCALE_UNIT_MISMATCH.1']);
      expect(codes(after)).toEqual([]);
    } finally { model.close(); }
  });

  it('map position applied twice: nothing the doctor may apply (a placement edit, and a fix with a checker caveat)', async () => {
    const model = await open(fixture('double-site-placement'));
    try {
      const { plan, result, after } = await fixAndRecheck(model);
      expect(plan.fixes.map((f) => [f.id, f.status])).toEqual([['MAP_POSITION_APPLIED_TWICE.1', 'manual'], ['MAP_POSITION_APPLIED_TWICE.2', 'review']]);
      expect(result.applied).toEqual([]);
      expect(codes(after)).toEqual(['MAP_POSITION_APPLIED_TWICE']);
      // Choosing the caveated fix does not make it applicable.
      const chosen = model.bim.georef.planFixes(await model.bim.georef.check(), { choose: ['MAP_POSITION_APPLIED_TWICE.2'] });
      expect(fix(chosen, 'MAP_POSITION_APPLIED_TWICE.2').status).toBe('review');
    } finally { model.close(); }
  });

  it('zone prefix on the Easting: stripped; the zone-prefixed CRS is the alternative', async () => {
    const model = await open(fixture('zone-prefix'));
    try {
      const { plan, result, after } = await fixAndRecheck(model);
      expect(fix(plan, 'EASTING_ZONE_PREFIX.1').write).toEqual({ via: 'georef.update', input: { MapConversion: { Eastings: 461_000 } } });
      expect(fix(plan, 'EASTING_ZONE_PREFIX.2').alternativeTo).toBe('EASTING_ZONE_PREFIX.1');
      expect(result.applied).toEqual(['EASTING_ZONE_PREFIX.1']);
      expect(codes(after)).toEqual([]);
    } finally { model.close(); }
  });

  it('LV03 numbers declared as LV95: EPSG:21781, once the user restates the CRS fields that belonged to LV95', async () => {
    const model = await open(fixture('lv03-numbers-in-lv95'));
    try {
      const report = await model.bim.georef.check();
      const planned = fix(model.bim.georef.planFixes(report), 'LV03_LV95_MIX.1');
      expect(planned.status).toBe('needs-value');
      expect(planned.needs).toContainEqual({ path: 'ProjectedCRS.GeodeticDatum', current: 'CH1903+' });
      const { result, after, text } = await fixAndRecheck(model, {
        values: { 'ProjectedCRS.Description': 'CH1903 / LV03', 'ProjectedCRS.GeodeticDatum': 'CH1903', 'ProjectedCRS.VerticalDatum': 'EPSG:5728', 'ProjectedCRS.MapUnit': 'METRE' },
      });
      expect(result.applied).toEqual(['LV03_LV95_MIX.1']);
      expect(text).toMatch(/IFCPROJECTEDCRS\('EPSG:21781','CH1903 \/ LV03','CH1903','EPSG:5728'/);
      expect(codes(after)).toEqual([]);
    } finally { model.close(); }
  });
});

describe('a correct model', () => {
  it.each(['clean-lv95-mm', 'clean-ifc2x3-epset', 'control-terrain-epsg3006'])('%s: no finding, nothing to apply, the export unchanged by fix()', async (name) => {
    const model = await open(fixture(name));
    try {
      const before = String(model.bim.export.ifc());
      const report = await model.bim.georef.check();
      expect(report.findings.filter((f) => f.severity !== 'info')).toEqual([]);
      const plan = model.bim.georef.planFixes(report);
      expect(plan.fixes.filter((f) => f.status === 'ready')).toEqual([]);
      expect(model.bim.georef.fix(plan)).toEqual({ applied: [], writes: [] });
      expect(String(model.bim.export.ifc())).toBe(before);
    } finally { model.close(); }
  });
});

describe('a tool-default site position', () => {
  const LV95 = { ProjectedCRS: { Name: 'EPSG:2056', MapUnit: 'METRE', VerticalDatum: 'EPSG:5728' }, MapConversion: { Eastings: 2_600_000, Northings: 1_199_650, OrthogonalHeight: 540 } };

  it('with a plausible map conversion: the site position is derived from it (and RefElevation, the vertical datum being stated)', async () => {
    const model = await open(fixture('site-default-revit-boston'));
    try {
      model.bim.georef.set(LV95);
      const report = await model.bim.georef.check();
      expect(report.includesSessionEdits).toBe(true);
      expect(codes(report)).toContain('SITE_LOCATION_DEFAULT');
      const planned = fix(model.bim.georef.planFixes(report), 'SITE_LOCATION_DEFAULT.1');
      expect(planned.status).toBe('ready');
      expect(planned.derived?.RefLatitude).toBeCloseTo(46.9479, 3);
      expect(planned.derived?.RefLongitude).toBeCloseTo(7.4386, 3);
      expect(planned.derived?.RefElevation).toBe(540); // project length unit: metre
      const { after } = await fixAndRecheck(model);
      expect(codes(after)).not.toContain('SITE_LOCATION_DEFAULT');
      expect(codes(after)).not.toContain('SITE_LOCATION_CONTRADICTS_OPERATION');
      expect(after.facts.siteLocation?.latitude).toBeCloseTo(46.9479345, 6);
    } finally { model.close(); }
  });

  it('without a map conversion: the user must supply it', async () => {
    const model = await open(fixture('site-default-revit-boston'));
    try {
      const planned = fix(model.bim.georef.planFixes(await model.bim.georef.check()), 'SITE_LOCATION_DEFAULT.1');
      expect(planned.status).toBe('needs-value');
      expect(planned.needs?.map((n) => n.path)).toEqual(['IfcSite.RefLatitude', 'IfcSite.RefLongitude']);
    } finally { model.close(); }
  });

  it('through a Helmert approximation (RD New offline): only when the user accepts it', async () => {
    const model = await open(fixture('site-default-revit-boston'));
    try {
      model.bim.georef.set({ ProjectedCRS: { Name: 'EPSG:28992', MapUnit: 'METRE' }, MapConversion: { Eastings: 155_000, Northings: 463_000, OrthogonalHeight: 0 } });
      const report = await model.bim.georef.check();
      expect(report.siteDerivation.datumShift).toBe('helmert-approximation');
      expect(report.siteDerivation.elevation).toBeUndefined(); // no VerticalDatum stated
      expect(fix(model.bim.georef.planFixes(report), 'SITE_LOCATION_DEFAULT.1').status).toBe('review');
      const accepted = fix(model.bim.georef.planFixes(report, { acceptApproximateDatum: true }), 'SITE_LOCATION_DEFAULT.1');
      expect(accepted.status).toBe('ready');
      expect(accepted.derived?.RefLatitude).toBeCloseTo(52.155, 2);
    } finally { model.close(); }
  });

  it('a Revit export with the default (issue_098_wall_W.ifc, Revit IFC exporter 22) gets the warning', async () => {
    const model = await open(new Uint8Array(readFileSync(new URL('rust/geometry/tests/fixtures/issue_098_wall_W.ifc', REPO))));
    try {
      expect(codes(await model.bim.georef.check())).toContain('SITE_LOCATION_DEFAULT');
    } finally { model.close(); }
  });

  const rvt01 = new URL('tests/models/various/rvt01.ifc', REPO);
  it.skipIf(!existsSync(rvt01))('rvt01.ifc (Revit 24) with a zero-offset conversion over its absolute placements: a derived site position (run `pnpm fixtures` to fetch it)', async () => {
    const model = await open(new Uint8Array(readFileSync(rvt01)));
    try {
      expect(codes(await model.bim.georef.check())).toContain('SITE_LOCATION_DEFAULT');
      // Not the model's real CRS: one where its placements (E 500 373, N 2 780 224 m) are a plausible place.
      model.bim.georef.set({ ProjectedCRS: { Name: 'EPSG:32617', MapUnit: 'METRE' }, MapConversion: { Eastings: 0, Northings: 0, OrthogonalHeight: 0 } });
      const { plan, after } = await fixAndRecheck(model);
      expect(fix(plan, 'SITE_LOCATION_DEFAULT.1').status).toBe('ready');
      expect(codes(after)).not.toContain('SITE_LOCATION_DEFAULT');
      expect(after.facts.siteLocation?.longitude).toBeCloseTo(-81, 0);
    } finally { model.close(); }
  });
});

describe('capabilities', () => {
  it('a map position east of the date line in EPSG:3460 (Fiji) is inside its area of use', async () => {
    const fiji = await resolveCrs({ epsg: 3460 });
    const point = fiji?.fromWgs84([-178.8, -18.2]);
    expect(point).toBeTruthy();
    const [e, n] = point as [number, number];
    const model = await open(fixture('no-georef'));
    try {
      model.bim.georef.set({ ProjectedCRS: { Name: 'EPSG:3460', MapUnit: 'METRE' }, MapConversion: { Eastings: e, Northings: n, OrthogonalHeight: 10, Scale: 0.001 } });
      const report = await model.bim.georef.check();
      expect(report.capabilities.crs).toEqual([expect.objectContaining({ epsg: 3460, resolved: true })]);
      expect(report.skipped.map((s) => s.code)).not.toContain('OUTSIDE_CRS_AREA');
      expect(codes(report)).not.toContain('OUTSIDE_CRS_AREA');
    } finally { model.close(); }
  });

  it('offline, a CRS the engine cannot resolve is reported as skipped with what would enable it', async () => {
    const model = await open(fixture('no-georef'));
    try {
      model.bim.georef.set({ ProjectedCRS: { Name: 'EPSG:999999', MapUnit: 'METRE' }, MapConversion: { Eastings: 500_000, Northings: 5_000_000, OrthogonalHeight: 0, Scale: 0.001 } });
      const report = await model.bim.georef.check();
      expect(report.capabilities.network).toBe(false);
      expect(report.capabilities.crs).toEqual([expect.objectContaining({ epsg: 999999, resolved: false })]);
      expect(report.skipped.find((s) => s.code === 'OUTSIDE_CRS_AREA')?.reason).toMatch(/allow network access/);
    } finally { model.close(); }
  });
});

// Doctor port: non-uniform factors scale the local axes before rotation.
it('derives the site from a rotated scaled conversion without exchanging the axis factors', async () => {
  const model = await open(fixture('clean-lv95-mm'));
  try {
    const report = await model.bim.georef.check();
    const transformer = await resolveCrs({ epsg: 2056 });
    expect(transformer).toBeTruthy();
    const facts = { ...report.facts, coordinates: { ...report.facts.coordinates!, siteOrigin: { x: 10, y: 20, z: 0 } }, entities: {
      ...report.facts.entities!, operation: { ...report.facts.entities!.operation!, eastings: 2600000, northings: 1200000,
        xAxisAbscissa: 0, xAxisOrdinate: 1, scale: 2, factorX: 3, factorY: 4 },
    } };
    const derived = deriveSitePosition(facts, report, { epsg: 2056 }, new Map([[2056, transformer!]]), { lookup: () => undefined });
    const expected = transformer!.toWgs84([2599840, 1200060])!;
    expect(derived.longitude).toBeCloseTo(expected[0], 6);
    expect(derived.latitude).toBeCloseTo(expected[1], 6);
  } finally { model.close(); }
});
