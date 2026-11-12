/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** CLI read-only structural contract, Part of #9668. */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadIfcFile } from './loader.js';
import { extractStructuralOnDemand, type StructuralExtraction } from '@ifc-lite/parser';

const entry = fileURLToPath(new URL('./index.ts', import.meta.url));
const preload = createRequire(import.meta.url).resolve('tsx');
const fixture = fileURLToPath(new URL('../../../tests/models/ifcopenshell/generated_structural_coverage_ifc2x3.ifc', import.meta.url));
function run(...args: string[]) {
  const dir = mkdtempSync(join(tmpdir(), 'ifc-lite-structural-source-'));
  try {
    // Match doctor-command.test.ts: load the CLI source and resolve workspace
    // dependencies through package exports, without root tsconfig path aliases.
    const config = join(dir, 'tsconfig.json');
    writeFileSync(config, JSON.stringify({ compilerOptions: { module: 'NodeNext', moduleResolution: 'NodeNext', target: 'ES2022', paths: {} } }));
    return spawnSync(process.execPath, ['--import', preload, entry, 'structural', ...args], {
      encoding: 'utf8', timeout: 20_000,
      env: { ...process.env, TSX_TSCONFIG_PATH: config },
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('structural command (#9668)', () => {
  it('requires a model argument', () => {
    const result = run('--json');
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('Usage: ifc-lite structural');
  }, 30_000);
  it('rejects an unreadable file without JSON on stdout', () => {
    const result = run('/does-not-exist/structural.ifc', '--json');
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('Error');
  }, 30_000);
  it('reports an empty structural domain for a physical-only model', () => {
    const physical = fileURLToPath(new URL('../../../apps/viewer/public/samples/building-architecture.ifc', import.meta.url));
    const result = run(physical, '--json');
    expect(result.status, result.stderr).toBe(0);
    const got = JSON.parse(result.stdout);
    expect(got.hasStructural).toBe(false);
    for (const key of ['members', 'connections', 'loads', 'reactions', 'links', 'analysisModels', 'loadGroups', 'resultGroups']) expect(got[key]).toEqual([]);
  }, 120_000);
  it('describes its own command', () => {
    const result = run('--help');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('ifc-lite structural');
    expect(result.stdout).toContain('--json');
  }, 30_000);
  it('includes connection counterparts as well as member counterparts (#9922)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ifc-lite-structural-links-'));
    try {
      const file = join(dir, 'links.ifc');
      // Declared relationships: wall #1 idealised by member #3 AND connection #4;
      // slab #2 also idealised by member #3. The expected pairs are independent.
      writeFileSync(file, `ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('links.ifc','',(''),(''),'','','');
FILE_SCHEMA(('IFC4X3_ADD2'));
ENDSEC;
DATA;
#9=IFCPROJECT('0Project0000000000000a',$,'Project',$,$,$,$,$,$);
#1=IFCWALL('2Wall000000000000000001',$,'Wall',$,$,$,$,$,$);
#2=IFCSLAB('2Slab000000000000000001',$,'Slab',$,$,$,$,$,$);
#3=IFCSTRUCTURALSURFACEMEMBER('2Memb000000000000000001',$,'Shell',$,$,$,$,.SHELL.,0.2);
#4=IFCSTRUCTURALCURVECONNECTION('2Conn000000000000000001',$,'Edge',$,$,$,$,$,$);
#5=IFCRELASSIGNSTOPRODUCT('2Rel0000000000000000001',$,$,$,(#3,#4),$,#1);
#6=IFCRELASSIGNSTOPRODUCT('2Rel0000000000000000002',$,$,$,(#3),$,#2);
ENDSEC;
END-ISO-10303-21;`);
      const result = run(file, '--json');
      expect(result.status, result.stderr).toBe(0);
      const got = JSON.parse(result.stdout);
      expect(got.links).toEqual([
        { structuralItemId: 3, physicalElementId: 1 },
        { structuralItemId: 3, physicalElementId: 2 },
        { structuralItemId: 4, physicalElementId: 1 },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
  it.skipIf(!existsSync(fixture))('reports parser records and values (pnpm fixtures if absent)', async () => {
    const store = await loadIfcFile(fixture);
    const data = JSON.parse(JSON.stringify(extractStructuralOnDemand(store))) as StructuralExtraction;
    const result = run(fixture, '--json');
    expect(result.status, result.stderr).toBe(0);
    const got = JSON.parse(result.stdout);
    expect(data.members.length).toBeGreaterThan(0);
    expect(got.members).toEqual(data.members);
    expect(got.connections).toEqual(data.connections);
    expect(got.analysisModels).toEqual(data.analysisModels);
    expect(got.loadGroups).toEqual(data.loadGroups);
    expect(got.resultGroups).toEqual(data.resultGroups);
    expect(got.loads).toEqual(data.activities.filter((a) => a.kind === 'Action'));
    expect(got.reactions).toEqual(data.activities.filter((a) => a.kind === 'Reaction'));
    // Fixture #89 links physical IfcBeam #88 to analytical member #30 (#9922).
    // Pin the declared endpoints independently of the command's projection.
    expect(got.links).toEqual([{ structuralItemId: 30, physicalElementId: 88 }]);
    const table = run(fixture);
    expect(table.status, table.stderr).toBe(0);
    expect(table.stdout).toContain('Load groups / cases');
    expect(table.stdout).toContain('Physical links');
  }, 120_000);
});
