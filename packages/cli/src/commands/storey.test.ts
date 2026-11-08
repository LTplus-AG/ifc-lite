/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #9025: `ifc-lite storey` on a real IFC (Bonsai's hello-wall). Each action
 * writes a file the parser reads back with the storeys, elevations and
 * contents the command reported; refusals exit non-zero and write nothing.
 */

import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IfcParser } from '@ifc-lite/parser';
import { MutablePropertyView } from '@ifc-lite/mutations';
import * as create from '@ifc-lite/create';

const SAMPLE = fileURLToPath(new URL('../../../../apps/viewer/public/samples/hello-wall.ifc', import.meta.url));

/** The command, loaded so a missing implementation fails an assertion rather than the file load. */
async function storey(): Promise<(args: string[]) => Promise<void>> {
  const mod = await import('./storey.js').catch(() => {
    console.error('ifc-lite storey: the command module is not available');
    return null;
  });
  expect(mod, 'ifc-lite storey exists (#9025)').not.toBeNull();
  return mod!.storeyCommand;
}

async function storeysOf(path: string): Promise<Array<[string, number, number | null]>> {
  const bytes = await readFile(path);
  const store = await new IfcParser().parseColumnar(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, { disableWorkerScan: true });
  expect(typeof create.readStoreyInventory).toBe('function');
  return create.readStoreyInventory(store, new MutablePropertyView(null, 'r')).storeys.map((s) => [s.Name, s.elevation, s.parentId]);
}

let dir = '';
let stdout = '';
let stderr = '';
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ifc-lite-storey-'));
  stdout = ''; stderr = '';
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => { stdout += String(chunk); return true; });
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => { stderr += String(chunk); return true; });
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => { throw new Error(`exit ${code}`); }) as never);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

describe.skipIf(!existsSync(SAMPLE))('ifc-lite storey (#9025)', () => {
  it('lists storeys as JSON', async () => {
    const run = await storey();
    await run([SAMPLE, 'list', '--json']);
    const rows = JSON.parse(stdout);
    expect(rows.map((row: { Name: string; elevation: number }) => [row.Name, row.elevation])).toEqual([['My Storey', 0]]);
  });

  it('list --out writes the listing to the file instead of stdout (#9121 review)', async () => {
    const run = await storey();
    const report = join(dir, 'report.json');
    stdout = '';
    await run([SAMPLE, 'list', '--json', '--out', report]);
    expect(stdout).toBe('');
    const rows = JSON.parse(await readFile(report, 'utf8'));
    expect(rows.map((row: { Name: string }) => row.Name)).toEqual(['My Storey']);
  });

  it('the plain listing goes to stdout, so it pipes (#9121 review)', async () => {
    const run = await storey();
    await run([SAMPLE, 'list']);
    expect(stdout).toMatch(/^#\d+\tMy Storey\t0\.000 m\t/m);
  });

  it('adds a storey from its neighbour, re-levels it and writes a file that reads back the same', async () => {
    const run = await storey();
    const added = join(dir, 'added.ifc');
    await run([SAMPLE, 'add', '--from', 'My Storey', '--out', added]);
    expect(await storeysOf(added)).toEqual([['My Storey', 0, 36], ['Level 2', 3, 36]]);

    const raised = join(dir, 'raised.ifc');
    stdout = '';
    await run([added, 'edit', '--storey', 'My Storey', '--floor-height', '3.4', '--out', raised, '--json']);
    const report = JSON.parse(stdout);
    expect(report.storeys.map((s: { Name: string; elevation: number }) => [s.Name, s.elevation])).toEqual([['Level 2', 3.4], ['My Storey', 0]]);
    expect(await storeysOf(raised)).toEqual([['My Storey', 0, 36], ['Level 2', 3.4, 36]]);

    const renamed = join(dir, 'renamed.ifc');
    await run([raised, 'rename', '--storey', 'Level 2', '--name', 'Upper', '--out', renamed]);
    expect((await storeysOf(renamed)).map(([name]) => name)).toEqual(['My Storey', 'Upper']);

    const deleted = join(dir, 'deleted.ifc');
    await run([renamed, 'delete', '--storey', 'Upper', '--out', deleted]);
    expect((await storeysOf(deleted)).map(([name]) => name)).toEqual(['My Storey']);
  });

  it('a dry run reports and writes nothing', async () => {
    const run = await storey();
    const out = join(dir, 'never.ifc');
    await run([SAMPLE, 'edit', '--storey', 'My Storey', '--elevation', '0.5', '--dry-run', '--out', out]);
    expect(stderr).toMatch(/Moves 1 storey\(s\) and \d+ element\(s\)/);
    expect(existsSync(out)).toBe(false);
  });

  it('a dry-run add is refused exactly as the real one, and a dry-run rename writes nothing (#9121 review)', async () => {
    const run = await storey();
    // My Storey is at 0 m: a second storey there is refused, dry run or not.
    await expect(run([SAMPLE, 'add', '--name', 'Duplicate', '--elevation', '0', '--dry-run'])).rejects.toThrow('exit 1');
    expect(stderr).toMatch(/My Storey is already at ±0\.00 m/);
    const out = join(dir, 'never.ifc');
    await run([SAMPLE, 'rename', '--storey', 'My Storey', '--name', 'Renamed', '--dry-run', '--out', out]);
    expect(existsSync(out)).toBe(false);
    expect(stderr).toMatch(/Dry run: .*"Name":"Renamed"/);
  });

  it('an exact storey name is not ambiguous with one that differs only in letter case (#9121 review)', async () => {
    const run = await storey();
    const two = join(dir, 'two.ifc');
    await run([SAMPLE, 'add', '--name', 'my storey', '--elevation', '3', '--out', two]);
    const renamed = join(dir, 'renamed.ifc');
    await run([two, 'rename', '--storey', 'My Storey', '--name', 'Ground', '--out', renamed]);
    expect((await storeysOf(renamed)).map(([name]) => name)).toEqual(['Ground', 'my storey']);
  });

  it('a storey named like another storey\'s id is refused as ambiguous; #<id> picks the id (#9121 review)', async () => {
    const run = await storey();
    stdout = '';
    await run([SAMPLE, 'list', '--json']);
    const [only] = JSON.parse(stdout) as Array<{ expressId: number }>;
    const named = join(dir, 'named.ifc');
    await run([SAMPLE, 'add', '--name', String(only.expressId), '--elevation', '3', '--out', named]);
    const out = join(dir, 'never.ifc');
    await expect(run([named, 'rename', '--storey', String(only.expressId), '--name', 'X', '--out', out])).rejects.toThrow('exit 1');
    expect(stderr).toMatch(/express id and also a storey name/);
    expect(existsSync(out)).toBe(false);
    const renamed = join(dir, 'renamed.ifc');
    await run([named, 'rename', '--storey', `#${only.expressId}`, '--name', 'Ground', '--out', renamed]);
    expect((await storeysOf(renamed)).map(([name]) => name)).toEqual(['Ground', String(only.expressId)]);
  });

  it('a blank length is refused, not read as 0 m (#9121 review)', async () => {
    const run = await storey();
    const out = join(dir, 'never.ifc');
    await expect(run([SAMPLE, 'edit', '--storey', 'My Storey', '--elevation', '', '--out', out])).rejects.toThrow('exit 1');
    expect(stderr).toMatch(/--elevation must be a number of metres/);
    expect(existsSync(out)).toBe(false);
  });

  it('a value flag typed with no value is refused, not read as absent (#9121 review)', async () => {
    const run = await storey();
    const out = join(dir, 'never.ifc');
    await expect(run([SAMPLE, 'add', '--out', out, '--from', 'My Storey', '--elevation'])).rejects.toThrow('exit 1');
    expect(stderr).toMatch(/--elevation needs a value/);
    expect(existsSync(out)).toBe(false);
    await expect(run([SAMPLE, 'edit', '--storey', 'My Storey', '--elevation', '--out', out])).rejects.toThrow('exit 1');
    expect(stderr).toMatch(/--elevation needs a value/);
  });

  it('a value flag given twice is refused, so a trailing copy with no value is never ignored (#9121 review)', async () => {
    const run = await storey();
    const out = join(dir, 'never.ifc');
    await expect(run([SAMPLE, 'add', '--from', 'My Storey', '--out', out, '--elevation', '3', '--elevation'])).rejects.toThrow('exit 1');
    expect(stderr).toMatch(/--elevation is given more than once/);
    expect(existsSync(out)).toBe(false);
  });

  it('a refused add reports JSON like edit and delete; delete refuses --move-to with --delete-contents (#9121 review)', async () => {
    const run = await storey();
    stdout = '';
    await expect(run([SAMPLE, 'add', '--name', 'Duplicate', '--elevation', '0', '--json', '--dry-run'])).rejects.toThrow('exit 1');
    const report = JSON.parse(stdout);
    expect(report.action).toBe('add');
    expect(report.refusals[0].message).toMatch(/My Storey is already at ±0\.00 m/);
    const two = join(dir, 'two.ifc');
    await run([SAMPLE, 'add', '--name', 'Upper', '--elevation', '3', '--out', two]);
    const out = join(dir, 'never.ifc');
    await expect(run([two, 'delete', '--storey', 'Upper', '--move-to', 'My Storey', '--delete-contents', '--out', out])).rejects.toThrow('exit 1');
    expect(stderr).toMatch(/not both/);
    expect(existsSync(out)).toBe(false);
  });

  it('in a model with two buildings, --building picks the one a new storey joins (#9121 review)', async () => {
    const run = await storey();
    const source = await readFile(SAMPLE, 'utf8');
    // A second building, so the model no longer has a sole building to add into.
    const twoBuildings = join(dir, 'two-buildings.ifc');
    // A second building with a storey of its own, so storeys belong to two buildings.
    const annex = [
      "#900001=IFCBUILDING('2O2Fr$t4X7Zf8NOew3FLOH',$,'Annex',$,$,$,$,$,$,$,$,$);",
      "#900002=IFCBUILDINGSTOREY('1kTvXnbbzCWw8lcMd1dR4o',$,'Annex L0',$,$,$,$,$,.ELEMENT.,0.);",
      "#900003=IFCRELAGGREGATES('0Fh0gWbKP0Mw9tYpUZ2Kq3',$,$,$,#900001,(#900002));",
    ].join('\n');
    await writeFile(twoBuildings, source.replace(/\nENDSEC;\s*\nEND-ISO-10303-21;/, `\n${annex}\nENDSEC;\nEND-ISO-10303-21;`));
    const out = join(dir, 'never.ifc');
    await expect(run([twoBuildings, 'add', '--name', 'Upper', '--elevation', '3', '--out', out])).rejects.toThrow('exit 1');
    expect(stderr).toMatch(/2 buildings/);
    const added = join(dir, 'added.ifc');
    await run([twoBuildings, 'add', '--name', 'Upper', '--elevation', '3', '--building', '36', '--out', added]);
    expect(await storeysOf(added)).toEqual([['My Storey', 0, 36], ['Annex L0', 0, 900001], ['Upper', 3, 36]]);
  });

  it('with --json every failure is a JSON document, even one found before the edit is planned (#9121 review)', async () => {
    const run = await storey();
    stdout = '';
    await expect(run([SAMPLE, 'edit', '--storey', 'Missing', '--elevation', '3', '--json'])).rejects.toThrow('exit 1');
    const report = JSON.parse(stdout);
    expect(report.action).toBe('edit');
    expect(report.refusals[0].message).toMatch(/Storey "Missing" not found/);
  });

  it('a delete dry run says where a move goes and what it moves, or what a delete removes (#9121 review)', async () => {
    const run = await storey();
    const two = join(dir, 'two.ifc');
    await run([SAMPLE, 'add', '--name', 'Upper', '--elevation', '3', '--out', two]);
    stdout = '';
    await run([two, 'list', '--json']);
    const ids = new Map((JSON.parse(stdout) as Array<{ Name: string; expressId: number }>).map((r) => [r.Name, r.expressId]));
    stdout = '';
    await run([two, 'delete', '--storey', 'My Storey', '--move-to', 'Upper', '--dry-run', '--json']);
    const move = JSON.parse(stdout);
    expect(move.moveTo).toBe(ids.get('Upper'));
    expect(move.moves.length).toBeGreaterThan(0);
    stdout = '';
    await run([two, 'delete', '--storey', 'My Storey', '--delete-contents', '--dry-run', '--json']);
    const removal = JSON.parse(stdout);
    // Everything the storey holds: at least the direct children a move would re-parent.
    expect(removal.deletes.length).toBeGreaterThanOrEqual(move.moves.length);
    expect(removal.moveTo).toBeUndefined();
  });

  it('storey --help lists the actions (#9121 review)', async () => {
    const { buildCommandHelp } = await import('../help.js');
    const help = buildCommandHelp('0.0.0', 'storey') ?? '';
    for (const action of ['list [--json]', 'add --from S', 'rename --storey S', 'delete --storey S']) expect(help).toContain(action);
  });

  it('refuses an invalid edit, exits non-zero and writes nothing', async () => {
    const run = await storey();
    const added = join(dir, 'added.ifc');
    await run([SAMPLE, 'add', '--name', 'Upper', '--elevation', '3', '--out', added]);
    const out = join(dir, 'never.ifc');
    await expect(run([added, 'edit', '--storey', 'Upper', '--elevation', '0', '--out', out])).rejects.toThrow('exit 1');
    expect(stderr).toMatch(/Refused: Upper at ±0\.00 m would leave no height between it and My Storey/);
    expect(existsSync(out)).toBe(false);
    await expect(run([SAMPLE, 'delete', '--storey', 'My Storey', '--out', out])).rejects.toThrow('exit 1');
    expect(stderr).toMatch(/only storey/);
  });
});
