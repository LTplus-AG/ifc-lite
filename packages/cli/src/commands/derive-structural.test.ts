/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** `ifc-lite derive-structural` (#9668): writes a linked analytical model, and a re-run writes nothing. */

import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IfcParser, extractStructuralOnDemand, structuralCounterparts } from '@ifc-lite/parser';

const SAMPLE = fileURLToPath(new URL('../../../../apps/viewer/public/samples/hello-wall.ifc', import.meta.url));

/** The command, loaded so a missing implementation fails an assertion rather than the file load. */
async function derive(): Promise<(args: string[]) => Promise<void>> {
  const mod = await import('./derive-structural.js').catch(() => null);
  expect(mod, 'ifc-lite derive-structural exists (#9668)').not.toBeNull();
  return mod!.deriveStructuralCommand;
}

let dir = '';
let stdout = '';
let stderr = '';
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ifc-lite-derive-'));
  stdout = ''; stderr = '';
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => { stdout += String(chunk); return true; });
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => { stderr += String(chunk); return true; });
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => { throw new Error(`exit ${code}`); }) as never);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

describe.skipIf(!existsSync(SAMPLE))('ifc-lite derive-structural (#9668)', () => {
  it('writes a surface member linked to the wall, and a re-run on its output writes nothing', async () => {
    const run = await derive();
    const out = join(dir, 'derived.ifc');
    await run([SAMPLE, '--out', out, '--json']);
    const report = JSON.parse(stdout);
    expect(report).toMatchObject({ output: out, counts: { surfaceMembers: 1, curveMembers: 0, assumedLoadBearing: 1 } });

    const bytes = await readFile(out);
    const store = await new IfcParser().parseColumnar(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, { disableWorkerScan: true });
    const data = extractStructuralOnDemand(store);
    expect(data.analysisModels).toHaveLength(1);
    expect(data.members).toHaveLength(1);
    const wall = structuralCounterparts(data, data.members[0].expressId);
    expect(wall?.side).toBe('physical');
    expect(store.entities.getTypeName(wall!.expressIds[0])).toBe('IfcWall');

    stdout = '';
    const again = join(dir, 'again.ifc');
    await run([out, '--out', again, '--json']);
    expect(JSON.parse(stdout)).toMatchObject({
      output: null, counts: { surfaceMembers: 0 }, skipped: [{ reason: 'already-idealised' }],
      existingAnalysisModels: [{ expressId: data.analysisModels[0].expressId, derived: true }],
    });
    expect(stderr).toMatch(/already has 1 analysis model\(s\): #\d+ \(derived\)\. Nothing is written unless --analysis-model-exists add/);
    expect(existsSync(again)).toBe(false);
  });

  it('refuses, after its report, a file that already has an analysis model, and adds beside it with --analysis-model-exists add', async () => {
    const run = await derive();
    // hello-wall with an authored analysis model and nothing linked to the wall.
    const text = (await readFile(SAMPLE, 'utf8')).replace(/ENDSEC;\s*END-ISO-10303-21;\s*$/,
      "#99990=IFCSTRUCTURALANALYSISMODEL('0Ab1Cd2Ef3Gh4Ij5Kl6Mn7',$,'Authored',$,$,.LOADING_3D.,$,$,$,$);\nENDSEC;\nEND-ISO-10303-21;\n");
    expect(text).toContain('#99990=');
    const authored = join(dir, 'authored.ifc');
    await writeFile(authored, text);

    const refused = join(dir, 'refused.ifc');
    await expect(run([authored, '--out', refused, '--json'])).rejects.toThrow('exit 1');
    expect(JSON.parse(stdout)).toMatchObject({ output: null, refused: true, existingAnalysisModels: [{ expressId: 99990, derived: false }], counts: { surfaceMembers: 1 } });
    expect(stderr).toMatch(/Nothing written: the file already has an analysis model \(#99990\)\. Use --analysis-model-exists add/);
    expect(existsSync(refused)).toBe(false);

    stdout = '';
    const added = join(dir, 'added.ifc');
    await run([authored, '--out', added, '--json', '--analysis-model-exists', 'add']);
    expect(JSON.parse(stdout)).toMatchObject({ output: added, refused: false });
    const bytes = await readFile(added);
    const data = extractStructuralOnDemand(await new IfcParser().parseColumnar(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, { disableWorkerScan: true }));
    expect(data.analysisModels).toHaveLength(2);
  });

  it('applies the settings, and --dry-run writes nothing', async () => {
    const run = await derive();
    const out = join(dir, 'dry.ifc');
    await run([SAMPLE, '--dry-run', '--load-bearing-unknown', 'skip', '--tolerance', '0.1', '--support', 'fixed', '--out', out]);
    expect(stderr).toMatch(/0 surface member\(s\)/);
    expect(stderr).toMatch(/load-bearing-unknown/);
    expect(stderr).toMatch(/Dry run: nothing written/);
    expect(existsSync(out)).toBe(false);
  });

  it('refuses a value flag with no value instead of reading the next flag as it', async () => {
    const run = await derive();
    await expect(run([SAMPLE, '--out', '--json'])).rejects.toThrow('exit 1');
    expect(stderr).toMatch(/--out needs a value/);
    expect(existsSync('--json')).toBe(false);
  });

  it('refuses a joint reach or an analysis-model policy it does not know', async () => {
    const run = await derive();
    await expect(run([SAMPLE, '--dry-run', '--joint-reach', '-1'])).rejects.toThrow('exit 1');
    expect(stderr).toMatch(/jointReach must be null or a number of metres/);
    await expect(run([SAMPLE, '--dry-run', '--analysis-model-exists', 'replace'])).rejects.toThrow('exit 1');
    expect(stderr).toMatch(/whenAnalysisModelExists must be 'refuse' or 'add'/);
  });

  it('refuses a tolerance that is not a positive number of metres', async () => {
    const run = await derive();
    await expect(run([SAMPLE, '--dry-run', '--tolerance', 'abc'])).rejects.toThrow('exit 1');
    expect(stderr).toMatch(/tolerance must be a number of metres/);
  });
});
