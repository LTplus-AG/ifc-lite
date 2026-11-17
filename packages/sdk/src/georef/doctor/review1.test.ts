/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { openModel } from '../../headless.js';
import { planGeorefFixes } from './plan.js';
import type { GeorefCheckReport, GeorefPlannedFix } from './types.js';
const fixture = (n: string) => new Uint8Array(readFileSync(new URL(`../../../../georef-check/fixtures/${n}.ifc`, import.meta.url)));
const LV95 = { ProjectedCRS: { Name: 'EPSG:2056', MapUnit: 'METRE', VerticalDatum: 'EPSG:5728' }, MapConversion: { Eastings: 2600000, Northings: 1199650, OrthogonalHeight: 400000 } };

// PR #10537 review: invalid user values must not become real coordinates or CRS names.
it.each([null, '', ' ', false, [], {}])('keeps invalid supplied latitude %j open', async (bad) => {
  const m = await openModel(fixture('site-default-revit-boston'), { disableWorkerScan: true });
  try {
    const r = await m.bim.georef.check();
    const p = m.bim.georef.planFixes(r, { values: { 'IfcSite.RefLatitude': bad as never, 'IfcSite.RefLongitude': 8 } });
    const f = p.fixes.find((f) => f.code === 'SITE_LOCATION_DEFAULT')!;
    expect(f.status).toBe('needs-value');
    expect(f.needs).toContainEqual(expect.objectContaining({ path: 'IfcSite.RefLatitude' }));
  } finally { m.close(); }
});

it('does not apply a site elevation derived from a height that another ready fix changes (#10537)', async () => {
  const m = await openModel(fixture('site-default-revit-boston'), { disableWorkerScan: true });
  try {
    m.bim.georef.set(LV95);
    const report = await m.bim.georef.check();
    expect(report.findings.map((f) => f.code)).toContain('ORTHOGONAL_HEIGHT_IMPLAUSIBLE');
    const plan = m.bim.georef.planFixes(report);
    expect(plan.fixes.find((f) => f.code === 'ORTHOGONAL_HEIGHT_IMPLAUSIBLE')?.status).toBe('ready');
    expect(plan.fixes.find((f) => f.code === 'SITE_LOCATION_DEFAULT')?.status).toBe('review');
    m.bim.georef.fix(plan);
    const bytes = new TextEncoder().encode(String(m.bim.export.ifc()));
    const reopened = await openModel(bytes, { disableWorkerScan: true });
    try { expect(reopened.bim.georef.get().MapConversion?.OrthogonalHeight).toBe(400); }
    finally { reopened.close(); }
  } finally { m.close(); }
});

it('cannot derive a site position from a dangling ObjectPlacement (#10537)', async () => {
  const text = new TextDecoder().decode(fixture('site-default-revit-boston')).replace(/(IFCSITE\([^;]*?,\$,\$,)(#\d+|\$)/, '$1#999999');
  const m = await openModel(new TextEncoder().encode(text), { disableWorkerScan: true });
  try {
    m.bim.georef.set({ ...LV95, MapConversion: { ...LV95.MapConversion, OrthogonalHeight: 540 } });
    const report = await m.bim.georef.check();
    expect(report.facts.coordinates?.sitePlacementId).toBe(999999);
    expect(report.siteDerivation.latitude).toBeUndefined();
    expect(report.siteDerivation.blockedBy).toContainEqual(expect.objectContaining({ reason: 'unavailable' }));
  } finally { m.close(); }
});

it.each([{ rotationDegrees: 30 }, { replace: true }])('refuses top-level options it cannot apply: %j (#10537)', async (input) => {
  const m = await openModel(fixture('clean-lv95-mm'), { disableWorkerScan: true });
  try {
    const before = String(m.bim.export.ifc());
    const f: GeorefPlannedFix = { id: 'manual', code: 'NO_GEOREFERENCE', severity: 'warning', summary: '', reason: '', status: 'ready', changes: [], write: { via: 'georef.update', input: { ...input, MapConversion: { Eastings: 2600000 } } } };
    expect(() => m.bim.georef.fix({ fixes: [f] })).toThrow(/Fix manual.*(rotationDegrees|replace)/);
    expect(String(m.bim.export.ifc())).toBe(before);
  } finally { m.close(); }
});

it('marks slightly different numeric writes conflicting before apply (#10537)', async () => {
  const m = await openModel(fixture('zone-prefix'), { disableWorkerScan: true });
  try {
    const report = await m.bim.georef.check();
    const finding = report.findings[0];
    const base = finding.fixes[0];
    const second = { ...base, apply: { via: 'georef.update' as const, input: { MapConversion: { Eastings: 461000.0001 } }, userSupplied: [] } };
    const r: GeorefCheckReport = { ...report, findings: [finding, { ...finding, fixes: [second] }] };
    expect(planGeorefFixes(r).fixes.find((f) => f.id.includes('#2'))?.status).toBe('conflict');
  } finally { m.close(); }
});
