/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** CLI read-only structural contract, Part of #9668. */
import { describe, it, expect } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadIfcFile } from './loader.js';
import { extractStructuralOnDemand, type StructuralExtraction } from '@ifc-lite/parser';

const entry = fileURLToPath(new URL('../dist/index.js', import.meta.url));
const fixture = fileURLToPath(new URL('../../../tests/models/ifcopenshell/generated_structural_coverage_ifc2x3.ifc', import.meta.url));
const run = (...args: string[]) => spawnSync(process.execPath, [entry, 'structural', ...args], { encoding: 'utf8', timeout: 120_000 });

describe('structural command (#9668)', () => {
  it('requires a model argument', () => {
    const result = run('--json');
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('Usage: ifc-lite structural');
  });
  it('rejects an unreadable file without JSON on stdout', () => {
    const result = run('/does-not-exist/structural.ifc', '--json');
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('Error');
  });
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
  });
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
    const table = execFileSync(process.execPath, [entry, 'structural', fixture], { encoding: 'utf8' });
    expect(table).toContain('Load groups / cases');
    expect(table).toContain('Physical links');
  }, 120_000);
});
