/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `ifc-lite diff --by-entity` and the comparison scope it now shares with
 * `--by-content` (issue #1891).
 *
 * The flag used to ask every row of the entity index for a GlobalId, which is
 * two different wrong questions at once: a resource entity answered with its
 * *Name*, and relationships and property sets answered with a GlobalId whose
 * identity is not their own. Both are pinned below.
 */

import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { comparableEntities, comparableGlobalIds } from './diff-scope.js';
import { diffCommand } from './diff.js';
import { loadIfcBytes } from '../loader.js';
import { guid, legacyScheduleModel, scheduleModel } from './diff-test-helpers.js';

async function scheduleStore(taskGuid: string): Promise<Awaited<ReturnType<typeof loadIfcBytes>>> {
  return loadIfcBytes(new TextEncoder().encode(scheduleModel(taskGuid)), 'model');
}

async function legacyStore(moveGuid: string): Promise<Awaited<ReturnType<typeof loadIfcBytes>>> {
  return loadIfcBytes(new TextEncoder().encode(legacyScheduleModel(moveGuid)), 'model');
}

describe('comparableGlobalIds', () => {
  it('keys every IfcObjectDefinition, and nothing that is not one', async () => {
    const keys = comparableGlobalIds(await scheduleStore(guid('OLDT')));

    expect([...keys].sort()).toEqual(
      [guid('PROJ'), guid('STOR'), guid('WALL'), guid('OLDT'), guid('ACTR'), guid('VTYP')].sort(),
    );
  }, 30_000);

  it('does not key an IfcMaterial by its Name', async () => {
    // The parser fills the EntityTable's GlobalId column positionally, and slot
    // 0 of an IfcMaterial is its Name — so `brick` used to enter the comparison
    // as an entity key. Two resource entities sharing a name then collided into
    // one key and were compared as one entity; on the bundled sample models
    // that was 4 to 9 collisions per file.
    const keys = comparableGlobalIds(await scheduleStore(guid('OLDT')));

    expect(keys.has('brick')).toBe(false);
    // Nothing else slipped in under a non-GlobalId either: every key is the
    // 22 characters an IFC GlobalId has.
    expect([...keys].every((key) => key.length === 22)).toBe(true);
  }, 30_000);

  it('leaves out the two dependent IfcRoot branches', async () => {
    // A relationship is identified by its endpoints and a property set travels
    // with its owner, so counting either reports churn that is not a change to
    // any thing in the model. On a real model these are most of the key set.
    const keys = comparableGlobalIds(await scheduleStore(guid('OLDT')));

    expect(keys.has(guid('RELP'))).toBe(false);
    expect(keys.has(guid('RELC'))).toBe(false);
    expect(keys.has(guid('PSET'))).toBe(false);
    // Including an unrecognised `IfcRel…` class, which the parser's name-based
    // branch does put in its table: the relationship branch is shut by name
    // when the registry cannot confirm it.
    expect(keys.has(guid('VREL'))).toBe(false);
  }, 30_000);

  it('reaches an IfcTask and an IfcActor, which the EntityTable does not hold', async () => {
    const store = await scheduleStore(guid('OLDT'));

    // Not a regression pin on the old flag — that path reached these too, via
    // the on-demand fallback in EntityNode — but on the shared walk, which
    // reads the STEP record only for the object types the table declines.
    expect(store.entities.getGlobalId(store.entityIndex.byType.get('IFCTASK')![0])).toBe('');
    expect(comparableGlobalIds(store).has(guid('OLDT'))).toBe(true);
    expect(comparableGlobalIds(store).has(guid('ACTR'))).toBe(true);
  }, 30_000);

  it('keeps a vendor class to exactly the reach the EntityTable gives it', async () => {
    const keys = comparableGlobalIds(await scheduleStore(guid('OLDT')));

    // A class no schema registry knows has no chain to judge, so it is not read
    // from source: doing that would cost one STEP extraction per row of every
    // unrecognised bucket in the file, on every file, to reach entities almost
    // no file has. The deliberate price is that a vendor IfcRoot subtype goes
    // uncompared — narrower than the old flag, which read slot 0 positionally
    // and so happened to see this one (while reading a Name for every vendor
    // class that is not an IfcRoot).
    expect(keys.has(guid('VEND'))).toBe(false);
    // Except where the table already reaches it: the parser's type-object
    // branch is name-based, so an unrecognised `…Type` class is in the table
    // with a real GlobalId and keeps being compared.
    expect(keys.has(guid('VTYP'))).toBe(true);
  }, 30_000);

  it('keys an IFC2X3 object class the IFC4 codegen pin does not carry', async () => {
    // The parser's generated registry is pinned to IFC4_ADD2_TC1, so it answers
    // an empty chain for the 23 IFC2X3 IfcObjectDefinition classes IFC4 dropped.
    // Judging those `unknown` left every one the EntityTable does not hold out
    // of the comparison entirely, silently, on a schema most files in the wild
    // still use. The chain has to come from every bundled schema.
    const store = await legacyStore(guid('MOVE'));

    expect(store.entities.getGlobalId(store.entityIndex.byType.get('IFCMOVE')![0])).toBe('');
    const keys = comparableGlobalIds(store);
    expect(keys.has(guid('MOVE'))).toBe(true);
    expect(keys.has(guid('SPGM'))).toBe(true);
    // Read from the STEP record under its own class name, not 'Unknown': the
    // content path hashes `ifcType` into the fingerprint and cross-checks it on
    // every match.
    const move = [...comparableEntities(store)].find((e) => e.globalId === guid('MOVE'));
    expect(move?.ifcType).toBe('IfcMove');
  }, 30_000);

  it('does not key an IFC2X3 resource entity by its Name', async () => {
    // The other half of the same defect. `IfcSymbolStyle` is a resource with a
    // Name in slot 0 and no GlobalId, but its class name ends in STYLE, so the
    // parser's name-based branch puts it in the EntityTable with `hatch` in the
    // GlobalId column. Without an IFC2X3 chain to prove it is not an IfcRoot,
    // `hatch` was an entity key.
    const store = await legacyStore(guid('MOVE'));

    expect(store.entities.getGlobalId(store.entityIndex.byType.get('IFCSYMBOLSTYLE')![0])).toBe(
      'hatch',
    );
    const keys = comparableGlobalIds(store);
    expect(keys.has('hatch')).toBe(false);
    // The IFC2X3 type object next to it is a real IfcTypeObject and stays in.
    expect(keys.has(guid('GTTY'))).toBe(true);
    expect([...keys].sort()).toEqual(
      [guid('PROJ'), guid('STOR'), guid('WALL'), guid('MOVE'), guid('SPGM'), guid('GTTY')].sort(),
    );
  }, 30_000);
});

describe('ifc-lite diff --by-entity', () => {
  let dir: string;
  let basePath: string;
  let headPath: string;
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ifclite-by-entity-'));
    basePath = join(dir, 'v1.ifc');
    headPath = join(dir, 'v2.ifc');
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
  });

  function stdout(): string {
    return stdoutSpy.mock.calls.map((call) => String(call[0])).join('');
  }

  it('counts the re-GUIDed task, and only the entities a diff can speak for', async () => {
    await writeFile(basePath, scheduleModel(guid('OLDT')), 'utf-8');
    await writeFile(headPath, scheduleModel(guid('NEWT')), 'utf-8');

    await diffCommand([basePath, headPath, '--by-entity', '--json']);
    const result = JSON.parse(stdout());

    // Project, storey, wall, actor and the vendor type are common; the task's
    // GlobalId changed. The old scope answered 12 keys here — the five above
    // plus the task, plus a property set, two relationships, an unrecognised
    // relationship, a vendor class and the string `brick`.
    expect(result.entityDiff).toEqual({
      added: [guid('NEWT')],
      removed: [guid('OLDT')],
      common: 5,
    });
  }, 60_000);

  it('says which entities the count is about', async () => {
    await writeFile(basePath, scheduleModel(guid('OLDT')), 'utf-8');
    await writeFile(headPath, scheduleModel(guid('NEWT')), 'utf-8');

    await diffCommand([basePath, headPath, '--by-entity']);
    const text = stdout();

    expect(text).toContain('Entity comparison (by GlobalId, every IfcObjectDefinition)');
    expect(text).toContain('Common:  5');
    expect(text).toContain('Added:   1');
    expect(text).toContain('Removed: 1');
  }, 60_000);

  it('counts a re-GUIDed IFC2X3 object the IFC4 pin does not know', async () => {
    await writeFile(basePath, legacyScheduleModel(guid('OLDM')), 'utf-8');
    await writeFile(headPath, legacyScheduleModel(guid('NEWM')), 'utf-8');

    await diffCommand([basePath, headPath, '--by-entity', '--json']);
    const result = JSON.parse(stdout());

    // The IfcMove moved; project, storey, wall, space program and gas terminal
    // type did not. Nothing here is keyed on the IfcSymbolStyle's name.
    expect(result.entityDiff).toEqual({
      added: [guid('NEWM')],
      removed: [guid('OLDM')],
      common: 5,
    });
  }, 60_000);

  it('reports no entity comparison at all without the flag', async () => {
    await writeFile(basePath, scheduleModel(guid('OLDT')), 'utf-8');
    await writeFile(headPath, scheduleModel(guid('NEWT')), 'utf-8');

    await diffCommand([basePath, headPath, '--json']);

    expect(JSON.parse(stdout()).entityDiff).toBeUndefined();
  }, 60_000);
});
