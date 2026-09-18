/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `ifc-lite diff --key-from / --lineage-out / --lineage-in / --accept` and
 * `ifc-lite rekey` (issue #4955): the authored-key path and the lineage loop,
 * end to end over real files.
 */

import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { diffPositionals } from './diff.js';
import { contentDiffCommand } from './diff-content.js';
import { buildFileFingerprints, modelIdentityOf } from './diff-engine.js';
import { parseCsv, rekeyCommand, serializeCsv } from './rekey.js';
import { loadIfcBytes } from '../loader.js';
import { BASE_MODEL, HEAD_MODEL, guid, model } from './diff-test-helpers.js';

describe('diffPositionals with the lineage flags', () => {
  it('never mistakes a flag value for a third file', () => {
    expect(
      diffPositionals([
        'a.ifc', 'b.ifc',
        '--lineage-out', 'l.json', '--lineage-in', 'l.json', '--accept', 'm.json', '--key-from', 'Tag',
      ]),
    ).toEqual(['a.ifc', 'b.ifc']);
  });
});

describe('buildFileFingerprints with an authored key', () => {
  /** BASE_MODEL with its storey aggregated under the project, so the wall has a container path. */
  const AGGREGATED = BASE_MODEL.replace(
    '#80= IFCRELCONTAINEDINSPATIALSTRUCTURE',
    `#42= IFCRELAGGREGATES('${guid('AGGR')}',$,$,$,#1,(#41));
#80= IFCRELCONTAINEDINSPATIALSTRUCTURE`,
  );

  it('keys on Tag where present and reports container paths', async () => {
    const store = await loadIfcBytes(new TextEncoder().encode(AGGREGATED), 'base');
    const byRef = new Map(buildFileFingerprints(store, { keyProperty: 'Tag' }).map((f) => [f.ref, f]));
    expect(byRef.get(70)?.key).toBe('prop:tagA');
    expect(byRef.get(71)?.key).toBe('prop:tagB');
    // The storey carries no Tag and keeps its GlobalId.
    expect(byRef.get(41)?.key).toBe(guid('STOR'));
    expect(byRef.get(70)?.container).toBe('Proj/L01');
    expect(byRef.get(41)?.container).toBeUndefined();
  });

  it('refuses a Tag two entities share, falling both back to GlobalId', async () => {
    const twins = model(guid('OLDA'), guid('OLDB')).replace("'tagB'", "'tagA'");
    const store = await loadIfcBytes(new TextEncoder().encode(twins), 'twins');
    const duplicateAuthoredKeys = new Map<string, number[]>();
    const byRef = new Map(
      buildFileFingerprints(store, { keyProperty: 'Tag', duplicateAuthoredKeys }).map((f) => [f.ref, f]),
    );
    expect(byRef.get(70)?.key).toBe(guid('OLDA'));
    expect(byRef.get(71)?.key).toBe(guid('OLDB'));
    expect(duplicateAuthoredKeys).toEqual(new Map([['tagA', [70, 71]]]));
  });
});

describe('ifc-lite diff --key-from and the lineage loop', () => {
  let dir: string;
  let basePath: string;
  let headPath: string;
  let lineagePath: string;
  let stdoutSpy: MockInstance<typeof process.stdout.write>;
  let stderrSpy: MockInstance<typeof process.stderr.write>;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ifclite-lineage-'));
    basePath = join(dir, 'v1.ifc');
    headPath = join(dir, 'v2.ifc');
    lineagePath = join(dir, 'lineage.json');
    await writeFile(basePath, BASE_MODEL, 'utf-8');
    await writeFile(headPath, HEAD_MODEL, 'utf-8');
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
  });

  function stdoutJson(): Record<string, any> {
    return JSON.parse(stdoutSpy.mock.calls.map((c) => String(c[0])).join(''));
  }

  it('under --key-from Tag the re-GUIDed walls match by key, not by content', async () => {
    await contentDiffCommand({ basePath, headPath, keyFrom: 'Tag', json: true });
    const result = stdoutJson();
    expect(result.keyProperty).toBe('Tag');
    // Same tags on both sides: the walls are unchanged by key. Only the
    // project/storey, which carry no Tag and kept their GlobalIds, are
    // matched by GlobalId — nothing is left for content matching.
    expect(result.counts).toMatchObject({ added: 0, deleted: 0 });
    expect(result.contentMatches).toEqual([]);
  });

  it('rejects a malformed --key-from', async () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('exit');
    });
    await expect(contentDiffCommand({ basePath, headPath, keyFrom: 'AssetId', json: true })).rejects.toThrow('exit');
    exit.mockRestore();
  });

  it('writes a lineage, replays it, and refuses it under a different key scheme', async () => {
    await contentDiffCommand({ basePath, headPath, lineageOut: lineagePath, json: true });
    expect(stdoutJson().lineage.out).toEqual({ path: lineagePath, entries: 2 });
    const lineage = JSON.parse(await readFile(lineagePath, 'utf-8'));
    expect(lineage.format).toBe('ifc-lite/lineage');
    expect(lineage.deleted).toEqual([]);
    expect(lineage.base.hash).toBe(modelIdentityOf(basePath, await readFile(basePath)).hash);
    expect(lineage.entries).toEqual([
      { base: [guid('OLDA')], head: [guid('NEWA')], relation: 'identity', reason: 'content-match:renamed' },
      { base: [guid('OLDB')], head: [guid('NEWB')], relation: 'identity', reason: 'content-match:renamed' },
    ]);

    // Replay: the pairs are now matched by key and the lineage round-trips
    // byte for byte instead of eroding.
    stdoutSpy.mockClear();
    const before = await readFile(lineagePath, 'utf-8');
    await contentDiffCommand({ basePath, headPath, lineageIn: lineagePath, lineageOut: lineagePath, json: true });
    expect(stdoutJson().contentMatches).toEqual([]);
    expect(await readFile(lineagePath, 'utf-8')).toBe(before);

    const exit = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('exit');
    });
    await expect(
      contentDiffCommand({ basePath, headPath, lineageIn: lineagePath, keyFrom: 'Tag', json: true }),
    ).rejects.toThrow('exit');
    expect(stderrSpy.mock.calls.map((c) => String(c[0])).join('')).toMatch(/key scheme does not match/);
    exit.mockRestore();
  });

  it('folds an accepted identity map into the lineage as replaced, only for pairs still add + delete', async () => {
    // Head wall B renamed, so content matching leaves OLDB/NEWB as add + delete
    // (B differs in data now; no geometry in the CLI to pair it on).
    await writeFile(headPath, HEAD_MODEL.replace("'Wall B'", "'Wall B (rebuilt)'"), 'utf-8');
    const acceptPath = join(dir, 'accepted.json');
    await writeFile(
      acceptPath,
      JSON.stringify({
        format: 'ifc-lite/identity-map',
        version: 1,
        base: modelIdentityOf(basePath, await readFile(basePath)),
        head: modelIdentityOf(headPath, await readFile(headPath)),
        entries: [
          { base: guid('OLDB'), here: guid('NEWB'), reason: 'successor:footprint' },
          // Stale: OLDA is matched by content already, so this is not a replacement.
          { base: guid('OLDA'), here: guid('NEWA'), reason: 'successor:position' },
        ],
      }),
      'utf-8',
    );
    await contentDiffCommand({ basePath, headPath, accept: acceptPath, lineageOut: lineagePath, json: true });
    const lineage = JSON.parse(await readFile(lineagePath, 'utf-8'));
    expect(lineage.entries).toEqual([
      { base: [guid('OLDA')], head: [guid('NEWA')], relation: 'identity', reason: 'content-match:renamed' },
      { base: [guid('OLDB')], head: [guid('NEWB')], relation: 'replaced', reason: 'successor:footprint' },
    ]);
  });

  it('lists a bare deletion in the lineage so rekey can orphan exactly that row', async () => {
    // Head without wall B at all: A is renamed by content, B is simply gone.
    const withoutB = HEAD_MODEL.replace(/#71= IFCWALL[^\n]*\n/, '').replace('(#70,#71)', '(#70)');
    await writeFile(headPath, withoutB, 'utf-8');
    await contentDiffCommand({ basePath, headPath, lineageOut: lineagePath, json: true });
    const lineage = JSON.parse(await readFile(lineagePath, 'utf-8'));
    expect(lineage.entries.map((e: { base: string[] }) => e.base[0])).toEqual([guid('OLDA')]);
    expect(lineage.deleted).toEqual([guid('OLDB')]);
  });

  it('refuses --lineage-out onto an input model', async () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('exit');
    });
    await expect(contentDiffCommand({ basePath, headPath, lineageOut: basePath, json: true })).rejects.toThrow('exit');
    expect(await readFile(basePath, 'utf-8')).toBe(BASE_MODEL);
    exit.mockRestore();
  });
});

describe('ifc-lite rekey', () => {
  let dir: string;
  let stdoutSpy: MockInstance<typeof process.stdout.write>;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ifclite-rekey-'));
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });
  afterEach(() => stdoutSpy.mockRestore());

  const lineage = {
    format: 'ifc-lite/lineage',
    version: 1,
    base: { hash: 'sha256:a' },
    head: { hash: 'sha256:b' },
    entries: [
      { base: ['w'], head: ['p0', 'p1'], relation: 'split', reason: 'split:verified', shares: [0.7, 0.3] },
      { base: ['r'], head: ['R'], relation: 'replaced', reason: 'successor:footprint' },
    ],
    deleted: ['x'],
  };

  it('parses and serializes CSV with quoting', () => {
    const text = 'GlobalId,Cost,Note\nw,"1,200","said ""hi"""\nr,5,\n';
    const { header, rows } = parseCsv(text);
    expect(header).toEqual(['GlobalId', 'Cost', 'Note']);
    expect(rows).toEqual([
      { GlobalId: 'w', Cost: '1,200', Note: 'said "hi"' },
      { GlobalId: 'r', Cost: '5', Note: '' },
    ]);
    expect(serializeCsv(header, rows)).toBe(text);
  });

  it('rekeys a CSV, duplicating a split row under copy-to-all and writing orphans aside', async () => {
    const lineagePath = join(dir, 'l.json');
    const tablePath = join(dir, 'costs.csv');
    const outPath = join(dir, 'costs-v2.csv');
    const orphansPath = join(dir, 'orphans.csv');
    await writeFile(lineagePath, JSON.stringify(lineage), 'utf-8');
    // `same` is in no lineage entry and not deleted: an unchanged element,
    // whose row keeps its key (review on #4967). `x` is in the deleted list.
    await writeFile(tablePath, 'GlobalId,Cost\nw,100\nr,5\nx,9\nsame,1\n', 'utf-8');

    await rekeyCommand([tablePath, '--lineage', lineagePath, '--out', outPath, '--orphans', orphansPath, '--json']);

    expect(JSON.parse(stdoutSpy.mock.calls.map((c) => String(c[0])).join('')).counts).toEqual({
      input: 4,
      rekeyed: 3,
      duplicated: 1,
      orphaned: 1,
    });
    expect(await readFile(outPath, 'utf-8')).toBe(
      'GlobalId,Cost,lineage_relation,lineage_from\np0,100,split,w\np1,100,split,w\nR,5,replaced,r\nsame,1,unchanged,same\n',
    );
    expect(await readFile(orphansPath, 'utf-8')).toBe('GlobalId,Cost,lineage_relation\nx,9,\n');
  });

  it('writes orphans to a default file beside the output when --orphans is absent', async () => {
    const lineagePath = join(dir, 'l.json');
    const tablePath = join(dir, 'costs.csv');
    const outPath = join(dir, 'costs-v2.csv');
    await writeFile(lineagePath, JSON.stringify(lineage), 'utf-8');
    await writeFile(tablePath, 'GlobalId,Cost\nx,9\n', 'utf-8');
    await rekeyCommand([tablePath, '--lineage', lineagePath, '--out', outPath, '--json']);
    expect(JSON.parse(stdoutSpy.mock.calls.map((c) => String(c[0])).join('')).orphans).toBe(join(dir, 'costs-v2.orphans.csv'));
    expect(await readFile(join(dir, 'costs-v2.orphans.csv'), 'utf-8')).toBe('GlobalId,Cost,lineage_relation\nx,9,\n');
  });

  it('follows the largest share under --policy largest-share, on a JSON table with a custom key column', async () => {
    const lineagePath = join(dir, 'l.json');
    const tablePath = join(dir, 'rows.json');
    const outPath = join(dir, 'rows-v2.json');
    await writeFile(lineagePath, JSON.stringify(lineage), 'utf-8');
    await writeFile(tablePath, JSON.stringify([{ id: 'w', v: 1 }]), 'utf-8');
    await rekeyCommand([tablePath, '--lineage', lineagePath, '--out', outPath, '--key-column', 'id', '--policy', 'largest-share']);
    expect(JSON.parse(await readFile(outPath, 'utf-8'))).toEqual([
      { id: 'p0', v: '1', lineage_relation: 'split', lineage_from: 'w' },
    ]);
  });
});
