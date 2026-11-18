/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Suggested fixes can be applied as written (PR #10386 review, findings 3, 4
 * and 15): every change names a real instance of a real EXPRESS entity and
 * one of its attributes, checked against the repository's schema tables and
 * the parsed file, and every fix says how it can be applied.
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ENTITIES_IFC2X3, ENTITIES_IFC4, ENTITIES_IFC4X3 } from '@ifc-lite/data';
import { IfcParser } from '@ifc-lite/parser';
import { collectGeorefFacts, storeEntityReader } from './facts-from-store.js';
import { diagnoseGeoreference } from './diagnose.js';
import { operationAttribute } from './context.js';
import type { CrsCatalog, DiagnoseOptions, FieldChange, GeorefReport, Reprojector } from './types.js';

const FIXTURES = new URL('../fixtures/', import.meta.url);

const stubReprojector: Reprojector = {
  toWgs84(code, [e, n]) {
    if (code === 3857) {
      const R = 6_378_137;
      return [(e / R) * (180 / Math.PI), (2 * Math.atan(Math.exp(n / R)) - Math.PI / 2) * (180 / Math.PI)];
    }
    if (code !== 2056) return undefined;
    const latitude = 46.9524056 + (n - 1_200_000) / 111_195;
    return [7.4395833 + (e - 2_600_000) / (111_195 * Math.cos((latitude * Math.PI) / 180)), latitude];
  },
};
const catalog: CrsCatalog = {
  lookup: (code) => (code === 3006 ? { code, kind: 'projected', unitScale: 1, areaOfUse: { west: 10.03, south: 54.96, east: 24.17, north: 69.07 } } : undefined),
  resolveName: (name) => (name === 'CH1903+ / LV95' ? 2056 : undefined),
};
const OPTIONS: DiagnoseOptions = { reprojector: stubReprojector, crsCatalog: catalog };

async function load(path: URL | string) {
  const bytes = new Uint8Array(readFileSync(path));
  const store = await new IfcParser().parseColumnar(bytes.buffer);
  const facts = collectGeorefFacts(store);
  const reader = storeEntityReader(store);
  if (!facts || !reader) throw new Error(`${String(path)}: no STEP source`);
  return { store, facts, reader };
}

async function diagnose(name: string, options: DiagnoseOptions = OPTIONS): Promise<GeorefReport> {
  const { facts } = await load(new URL(`${name}.ifc`, FIXTURES));
  return diagnoseGeoreference(facts, options);
}

function schemaFor(version: string) {
  const v = version.toUpperCase();
  if (v.startsWith('IFC2X')) return ENTITIES_IFC2X3;
  if (v.startsWith('IFC4X3')) return ENTITIES_IFC4X3;
  return ENTITIES_IFC4;
}

/** The ePSet conventions mirror the IFC4 entities' attributes (buildingSMART georeferencing user guide). */
function ePSetProperties(entity: 'IfcMapConversion' | 'IfcProjectedCRS'): string[] {
  const info = ENTITIES_IFC4.find((e) => e.name === entity);
  return (info?.attributes ?? []).filter((a) => a !== 'SourceCRS' && a !== 'TargetCRS');
}

describe('every structured fix names a real entity instance and EXPRESS attribute', () => {
  const files = readdirSync(FIXTURES).filter((f) => f.endsWith('.ifc')).sort();
  it('walks every fix of every fixture', async () => {
    const seen = new Set<string>();
    let walked = 0;
    for (const file of files) {
      const { store, facts, reader } = await load(new URL(file, FIXTURES));
      const report = diagnoseGeoreference(facts, OPTIONS);
      const schema = schemaFor(store.schemaVersion);
      for (const finding of report.findings) {
        for (const fix of finding.fixes) {
          const where = `${file} ${finding.code} "${fix.summary}"`;
          expect(fix.apply, where).toBeDefined();
          for (const change of fix.changes) {
            walked++;
            seen.add(change.entity);
            checkChange(change, where, schema, reader);
            if (change.entityId === undefined) {
              // Only a record the fix creates may leave the instance out, and
              // only georeferencing records are ever created.
              expect(['IfcMapConversion', 'IfcProjectedCRS', 'ePSet_MapConversion', 'ePSet_ProjectedCRS'], where).toContain(change.entity);
            }
          }
          if (fix.apply.via === 'georef.site') {
            const { input, userSupplied } = fix.apply;
            const nulls = (['RefLatitude', 'RefLongitude', 'RefElevation'] as const).filter((k) => input[k] === null).map((k) => `IfcSite.${k}`);
            expect(userSupplied.sort(), where).toEqual(nulls.sort());
          } else if (fix.apply.via !== 'manual') {
            const { input, userSupplied } = fix.apply;
            const nulls = [
              ...Object.entries(input.ProjectedCRS ?? {}).filter(([, v]) => v === null).map(([k]) => `ProjectedCRS.${k}`),
              ...Object.entries(input.MapConversion ?? {}).filter(([, v]) => v === null).map(([k]) => `MapConversion.${k}`),
            ];
            expect(userSupplied.sort(), where).toEqual(nulls.sort());
          }
        }
      }
    }
    expect(walked).toBeGreaterThan(40);
    for (const entity of ['IfcMapConversion', 'IfcMapConversionScaled', 'IfcProjectedCRS', 'IfcSite', 'IfcCartesianPoint', 'ePSet_MapConversion', 'ePSet_ProjectedCRS']) {
      expect(seen, entity).toContain(entity);
    }
  });
});

it('IfcRigidOperation fields map to its EXPRESS attributes', () => {
  const rigid = ENTITIES_IFC4X3.find((e) => e.name === 'IfcRigidOperation');
  const op = { source: 'IfcRigidOperation' as const, entityId: 1, eastings: 0, northings: 0, orthogonalHeight: 0 };
  for (const field of ['eastings', 'northings', 'orthogonalHeight'] as const) {
    expect(rigid?.attributes).toContain(operationAttribute(op, field));
  }
});

function checkChange(change: FieldChange, where: string, schema: typeof ENTITIES_IFC4, reader: NonNullable<ReturnType<typeof storeEntityReader>>) {
  if (change.entity === 'ePSet_MapConversion' || change.entity === 'ePSet_ProjectedCRS') {
    const props = ePSetProperties(change.entity === 'ePSet_MapConversion' ? 'IfcMapConversion' : 'IfcProjectedCRS');
    expect(props, where).toContain(change.attribute);
    if (change.entityId !== undefined) {
      const pset = reader.get(change.entityId);
      expect(pset?.type, where).toBe('IFCPROPERTYSET');
      expect(String(pset?.attributes[2]).toLowerCase(), where).toBe(change.entity.toLowerCase());
    }
    return;
  }
  const info = schema.find((e) => e.name === change.entity);
  expect(info, `${where}: ${change.entity} is not in the file's schema`).toBeDefined();
  expect(info?.abstract, where).toBe(false);
  expect(info?.attributes, `${where}: ${change.entity}.${change.attribute}`).toContain(change.attribute);
  if (change.entityId !== undefined) {
    expect(reader.get(change.entityId)?.type, `${where}: #${change.entityId}`).toBe(change.entity.toUpperCase());
  }
}

describe('fixes target what is actually wrong', () => {
  it('a bad FactorY is fixed on FactorY of the IfcMapConversionScaled, not on Scale', async () => {
    const [finding] = (await diagnose('scaled-factor-y-negative')).findings;
    expect(finding.code).toBe('SCALE_INVALID');
    expect(finding.fixes.map((f) => f.changes)).toEqual([[{ entity: 'IfcMapConversionScaled', entityId: 27, attribute: 'FactorY', value: 1 }]]);
    expect(finding.fixes[0].apply).toEqual({ via: 'georef.update', input: { MapConversion: { FactorY: 1 } }, userSupplied: [] });
  });

  it('the site placement fix edits the site Location point, composed into the parent frame', async () => {
    const [finding] = (await diagnose('double-site-placement')).findings;
    expect(finding.fixes[0].changes).toEqual([{ entity: 'IfcCartesianPoint', entityId: 10, attribute: 'Coordinates', value: [0, 0, 0] }]);
  });

  it('geometry carrying the doubled anchor gets the geometry message and no site move (finding 4)', async () => {
    const [finding] = (await diagnose('mixed-families-double')).findings;
    expect(finding.code).toBe('MAP_POSITION_APPLIED_TWICE');
    expect(finding.evidence).toMatchObject({ carrier: 'geometry', family: 'pointLists' });
    expect(finding.message).toMatch(/tessellated geometry/);
    expect(finding.message).not.toMatch(/site/);
    expect(finding.fixes.flatMap((f) => f.changes).some((c) => c.entity === 'IfcCartesianPoint')).toBe(false);
    expect(finding.fixes[0].changes.map((c) => [c.attribute, c.value])).toEqual([['Eastings', 0], ['Northings', 0], ['XAxisAbscissa', 1], ['XAxisOrdinate', 0], ['Scale', 1]]);
    const [site] = (await diagnose('double-site-placement')).findings;
    expect(site.message).toMatch(/site placement/);
  });

  it('the correct mixed-family model is measured per family (finding 1)', async () => {
    const { facts } = await load(new URL('mixed-families-zero-offset.ifc', FIXTURES));
    expect(facts.coordinates?.geometry?.cartesianPoints?.median.x).toBeLessThan(100);
    expect(facts.coordinates?.geometry?.pointLists?.median.x).toBeGreaterThan(2_500_000);
    expect(diagnoseGeoreference(facts, OPTIONS).indicators.geometryAtMapMagnitude).toBe(true);
  });
});

describe('how a fix is applied (finding 15)', () => {
  it('an offset fix is one georef.update', async () => {
    const [finding] = (await diagnose('zone-prefix')).findings;
    expect(finding.fixes[0].apply).toEqual({ via: 'georef.update', input: { MapConversion: { Eastings: 461_000 } }, userSupplied: [] });
  });

  it('a CRS rename lists the old fields the write API makes the caller restate', async () => {
    const [finding] = (await diagnose('zone-prefix')).findings;
    const apply = finding.fixes[1].apply;
    expect(apply.via).toBe('georef.update');
    if (apply.via !== 'georef.update') return;
    expect(apply.input.ProjectedCRS).toEqual({ Name: 'EPSG:4647', VerticalDatum: null, MapUnit: null });
    expect(apply.userSupplied.sort()).toEqual(['ProjectedCRS.MapUnit', 'ProjectedCRS.VerticalDatum']);
  });

  it('adding a map conversion to a model with nothing is one grouped set, user values marked', async () => {
    const [finding] = (await diagnose('no-georef')).findings;
    expect(finding.fixes[0].apply).toEqual({
      via: 'georef.set',
      input: { ProjectedCRS: { Name: null }, MapConversion: { Eastings: null, Northings: null, OrthogonalHeight: null } },
      userSupplied: ['ProjectedCRS.Name', 'MapConversion.Eastings', 'MapConversion.Northings', 'MapConversion.OrthogonalHeight'],
    });
  });

  it('a CRS without a conversion keeps its CRS and adds the conversion through update', async () => {
    const [finding] = (await diagnose('crs-only')).findings;
    expect(finding.code).toBe('CRS_WITHOUT_OPERATION');
    expect(finding.fixes[0].apply).toMatchObject({ via: 'georef.update', input: { MapConversion: { Eastings: null, Northings: null, OrthogonalHeight: null } } });
  });

  it('a site latitude/longitude fix is one setSite call; the values only the user knows are user-supplied', async () => {
    const site = (await diagnose('site-default-revit-boston')).findings.find((f) => f.code === 'SITE_LOCATION_DEFAULT');
    expect(site?.fixes[0].apply).toEqual({
      via: 'georef.site',
      input: { siteId: expect.any(Number), RefLatitude: null, RefLongitude: null },
      userSupplied: ['IfcSite.RefLatitude', 'IfcSite.RefLongitude'],
    });
    const swapped = (await diagnose('site-latlong-swapped')).findings[0];
    expect(swapped.fixes[0].apply).toMatchObject({ via: 'georef.site', userSupplied: [] });
  });

  it('rigid-operation and placement edits are manual, with the reason', async () => {
    const rigid = (await diagnose('rigid-operation-without-crs')).findings[0];
    expect(rigid.fixes[0].apply).toMatchObject({ via: 'manual', reason: expect.stringMatching(/IfcRigidOperation/) });
    const placement = (await diagnose('map-coordinates-in-placements')).findings[0];
    expect(placement.fixes[0].apply).toMatchObject({ via: 'manual', reason: expect.stringMatching(/Placements/) });
  });

  it('a file with two map conversions cannot be updated: manual', async () => {
    const report = await diagnose('two-map-conversions');
    expect(report.findings.flatMap((f) => f.fixes).every((f) => f.apply.via === 'manual')).toBe(true);
  });
});

describe('the site contradiction names its suspect (finding 2)', () => {
  it('a map conversion at E 0 / N 0 beside a real site: no "set the site to 0°, 0°"', async () => {
    const [finding] = (await diagnose('site-vs-false-origin-3857')).findings;
    expect(finding.code).toBe('SITE_LOCATION_CONTRADICTS_OPERATION');
    expect(finding.evidence.suspect).toBe('mapConversion');
    expect(finding.message).toMatch(/false origin of EPSG:3857/);
    const changes = finding.fixes.flatMap((f) => f.changes);
    expect(changes.some((c) => c.entity === 'IfcSite')).toBe(false);
    expect(changes.map((c) => [c.attribute, c.value])).toEqual([['Eastings', null], ['Northings', null]]);
  });

  const issue159 = new URL('../../../tests/models/ara3d/ISSUE_159_kleine_Wohnung_R22.ifc', import.meta.url);
  it.skipIf(!existsSync(issue159))('ISSUE_159 (EPSG:3857, E = N = 0, site in Vienna); run `pnpm fixtures` to fetch it', async () => {
    const { facts } = await load(issue159);
    const finding = diagnoseGeoreference(facts, OPTIONS).findings.find((f) => f.code === 'SITE_LOCATION_CONTRADICTS_OPERATION');
    expect(finding?.evidence.suspect).toBe('mapConversion');
    expect(finding?.fixes.flatMap((f) => f.changes).some((c) => c.entity === 'IfcSite')).toBe(false);
  });
});

describe('messages', () => {
  it('a model with only a postal address is not told it says nowhere where it is (finding 9)', async () => {
    const [withAddress] = (await diagnose('no-georef-address')).findings;
    expect(withAddress.message).toMatch(/only a postal address/);
    const [without] = (await diagnose('no-georef')).findings;
    expect(without.message).toMatch(/says nowhere where it is/);
  });
});
