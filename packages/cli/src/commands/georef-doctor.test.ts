/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `ifc-lite georef check` / `georef fix` end to end on `@ifc-lite/georef-check`'s
 * fixtures: the exit code follows --fail-on, `fix` writes only what the plan
 * marks ready, and its --json output (re-parsed here) carries the check of the
 * written file; the written file is read back again with `georef check --json`.
 */

import { copyFileSync, existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { GeorefCheckReport, GeorefFixPlan } from '@ifc-lite/sdk';
import { georefCommand } from './georef.js';

const FIXTURES = fileURLToPath(new URL('../../../georef-check/fixtures/', import.meta.url));
let dir: string;
let stdout: string;
let stderr: string;

class Exit extends Error {
  constructor(readonly code: number | undefined) { super(`exit ${code}`); }
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ifc-lite-cli-georef-doctor-'));
  for (const name of ['clean-lv95-mm', 'zone-prefix', 'lv03-numbers-in-lv95', 'scale-inverted', 'crs-only', 'double-site-placement', 'site-default-revit-boston', 'epset-on-site']) {
    copyFileSync(join(FIXTURES, `${name}.ifc`), join(dir, `${name}.ifc`));
  }
});
afterAll(async () => { await rm(dir, { recursive: true, force: true }); });
afterEach(() => { vi.restoreAllMocks(); process.exitCode = undefined; });

/** Run `ifc-lite georef ...`; the exit code from process.exit (fatal) or process.exitCode. */
async function run(args: string[]): Promise<number> {
  stdout = '';
  stderr = '';
  process.exitCode = undefined;
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => { stdout += String(chunk); return true; });
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => { stderr += String(chunk); return true; });
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => { throw new Exit(code); }) as never);
  try {
    await georefCommand(args);
  } catch (err) {
    if (err instanceof Exit) return err.code ?? 0;
    throw err;
  } finally {
    vi.restoreAllMocks();
  }
  return Number(process.exitCode ?? 0);
}

const p = (name: string) => join(dir, name);
const json = <T>() => JSON.parse(stdout) as T;
type CheckJson = { report: GeorefCheckReport; plan: GeorefFixPlan };
type FixJson = CheckJson & { output: string | null; applied: string[]; after?: CheckJson };
const codes = (r: { findings: Array<{ code: string }> }) => r.findings.map((f) => f.code);

describe('ifc-lite georef check', () => {
  it('a correct model: no findings, exit 0', async () => {
    expect(await run(['check', p('clean-lv95-mm.ifc'), '--json'])).toBe(0);
    expect(codes(json<CheckJson>().report)).toEqual([]);
  });

  it('exit 1 on an error finding; --fail-on chooses the threshold', async () => {
    expect(await run(['check', p('zone-prefix.ifc')])).toBe(1);
    expect(stdout).toContain('EASTING_ZONE_PREFIX');
    expect(stdout).toContain('EASTING_ZONE_PREFIX.1  [will apply]');
    expect(await run(['check', p('zone-prefix.ifc'), '--fail-on', 'none'])).toBe(0);
    // Warnings only: exit 0 by default, 1 with --fail-on warning.
    expect(await run(['check', p('site-default-revit-boston.ifc')])).toBe(0);
    expect(await run(['check', p('site-default-revit-boston.ifc'), '--fail-on', 'warning'])).toBe(1);
  });

  it('names the flag that supplies a missing value, and lists manual fixes as manual', async () => {
    await run(['check', p('crs-only.ifc')]);
    expect(stdout).toContain('supply: --value MapConversion.Eastings=<value>');
    await run(['check', p('double-site-placement.ifc')]);
    expect(stdout).toContain('MAP_POSITION_APPLIED_TWICE.1  [manual]');
    expect(stdout).toContain('MAP_POSITION_APPLIED_TWICE.2  [not applied: review]');
    expect(stdout).toContain('to apply it yourself: ifc-lite georef update');
  });

  it('refuses fix-only flags without --fix', async () => {
    expect(await run(['check', p('zone-prefix.ifc'), '--out', p('x.ifc')])).toBe(1);
    expect(stderr).toMatch(/belong to georef fix/);
  });
});

describe('ifc-lite georef fix', () => {
  it('zone prefix: applies the stripped Easting, writes --out, and the written file checks clean', async () => {
    expect(await run(['fix', p('zone-prefix.ifc'), '--out', p('zone-fixed.ifc'), '--json'])).toBe(0);
    const out = json<FixJson>();
    expect(out.applied).toEqual(['EASTING_ZONE_PREFIX.1']);
    expect(codes(out.after!.report)).toEqual([]);
    expect(await run(['check', p('zone-fixed.ifc'), '--json'])).toBe(0);
    expect(json<CheckJson>().report.facts.entities?.operation?.eastings).toBe(461_000);
  });

  it('scale slip and the IFC2X3 sets on IfcSite: fixed with no value; human output shows each change', async () => {
    expect(await run(['fix', p('scale-inverted.ifc'), '--out', p('scale-fixed.ifc')])).toBe(0);
    expect(stdout).toMatch(/MapConversion\.Scale: 1000 -> 0\.001/);
    expect(stdout).toContain('No findings.');
    expect(await run(['check', p('scale-fixed.ifc'), '--json'])).toBe(0);
    expect(codes(json<CheckJson>().report)).toEqual([]);

    expect(await run(['check', p('epset-on-site.ifc'), '--fix', '--out', p('epset-fixed.ifc'), '--json'])).toBe(0);
    expect(json<FixJson>().applied).toEqual(['EPSET_NOT_ON_PROJECT.1']);
    expect(await run(['check', p('epset-fixed.ifc'), '--json'])).toBe(0);
    expect(json<CheckJson>().report.facts.ePSetHosts).toEqual(['IfcProject']);
  });

  it('map conversion missing and LV03/LV95: fixed with the values only the user knows (check --fix)', async () => {
    expect(await run(['fix', p('crs-only.ifc'), '--out', p('crs-fixed.ifc'), '--json',
      '--value', 'MapConversion.Eastings=2600000', '--value', 'MapConversion.Northings=1199650', '--value', 'MapConversion.OrthogonalHeight=540'])).toBe(0);
    expect(codes(json<FixJson>().after!.report)).toEqual([]);

    expect(await run(['check', p('lv03-numbers-in-lv95.ifc'), '--fix', '--out', p('lv-fixed.ifc'), '--json',
      '--value', 'ProjectedCRS.Description=CH1903 / LV03', '--value', 'ProjectedCRS.GeodeticDatum=CH1903',
      '--value', 'ProjectedCRS.VerticalDatum=EPSG:5728', '--value', 'ProjectedCRS.MapUnit=METRE'])).toBe(0);
    const out = json<FixJson>();
    expect(out.applied).toEqual(['LV03_LV95_MIX.1']);
    expect(codes(out.after!.report)).toEqual([]);
    expect(await run(['check', p('lv-fixed.ifc'), '--json'])).toBe(0);
    expect(json<CheckJson>().report.facts.entities?.crs?.name).toBe('EPSG:21781');
  });

  it('applied twice, and a correct model: nothing applied, no file written', async () => {
    expect(await run(['fix', p('double-site-placement.ifc'), '--out', p('double-out.ifc')])).toBe(1);
    expect(stdout).toContain('Nothing the doctor can apply; no file written.');
    expect(existsSync(p('double-out.ifc'))).toBe(false);
    expect(await run(['fix', p('clean-lv95-mm.ifc'), '--out', p('clean-out.ifc'), '--json'])).toBe(0);
    expect(json<FixJson>()).toMatchObject({ applied: [], output: null });
    expect(existsSync(p('clean-out.ifc'))).toBe(false);
  });

  it('a tool-default site with a plausible map conversion: the site position is derived and written', async () => {
    expect(await run(['set', p('site-default-revit-boston.ifc'), '--out', p('boston-lv95.ifc'), '--epsg', '2056', '--map-unit', 'METRE',
      '--vertical-datum', 'EPSG:5728', '--eastings', '2600000', '--northings', '1199650', '--height', '540'])).toBe(0);
    expect(await run(['fix', p('boston-lv95.ifc'), '--out', p('boston-fixed.ifc'), '--json'])).toBe(0);
    const out = json<FixJson>();
    expect(out.applied).toContain('SITE_LOCATION_DEFAULT.1');
    expect(codes(out.after!.report)).not.toContain('SITE_LOCATION_DEFAULT');
    expect(readFileSync(p('boston-fixed.ifc'), 'utf8')).toMatch(/IFCSITE\([^;]*\(46,56,52,\d+\),\(7,26,19,\d+\),540\.,/);
  });

  it('--dry-run shows the plan and writes nothing; an unknown --apply id is refused', async () => {
    expect(await run(['fix', p('zone-prefix.ifc'), '--dry-run'])).toBe(1);
    expect(stdout).toContain('Dry run: 1 fix would apply; no file written.');
    expect(await run(['fix', p('zone-prefix.ifc'), '--out', p('z.ifc'), '--apply', 'NOPE.1'])).toBe(1);
    expect(stderr).toMatch(/Unknown fix id: NOPE\.1/);
  });
});
