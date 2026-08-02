/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Tests for `ifc-lite diff --by-content` and the identity-map sidecar
 * (issue #1891).
 *
 * The scenario throughout is the one the feature exists for: two files that
 * describe the same building, where the second was re-exported from scratch and
 * every GlobalId is new. Run 1 recognises the elements by content and writes the
 * claims down; run 2 replays them and the churn is gone.
 */

import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { diffPositionals } from './diff.js';
import { buildFileFingerprints, modelIdentityOf } from './diff-engine.js';
import { contentDiffCommand } from './diff-content.js';
import { loadIfcBytes } from '../loader.js';
import {
  BASE_MODEL,
  HEAD_MODEL,
  guid,
  scheduleModel,
} from './diff-test-helpers.js';

/** An incoming `created` a rewrite must carry forward rather than refresh. */
const STAMP = '2026-01-01T00:00:00.000Z';

describe('diffPositionals', () => {
  it('does not mistake a flag value for a third file', () => {
    expect(
      diffPositionals(['a.ifc', 'b.ifc', '--identity-out', 'map.json', '--json']),
    ).toEqual(['a.ifc', 'b.ifc']);
    expect(diffPositionals(['a.ifc', 'b.ifc', '--identity-in', 'map.json'])).toEqual([
      'a.ifc',
      'b.ifc',
    ]);
  });

  it('leaves the existing flag set behaving exactly as before', () => {
    expect(diffPositionals(['a.ifc', 'b.ifc', '--by-entity', '--json'])).toEqual([
      'a.ifc',
      'b.ifc',
    ]);
  });
});

describe('buildFileFingerprints', () => {
  it('fingerprints every IfcRoot and nothing else', async () => {
    const store = await loadIfcBytes(new TextEncoder().encode(BASE_MODEL), 'base');
    const fingerprints = buildFileFingerprints(store);
    const keys = fingerprints.map((f) => f.key).sort();

    expect(keys).toEqual([guid('OLDA'), guid('OLDB'), guid('PROJ'), guid('STOR')].sort());
    // Placements, profiles and representation items carry no GlobalId and have
    // no cross-file identity to diff. The IfcRelContainedInSpatialStructure has
    // one, but the columnar parser keeps relationships in the relationship
    // graph rather than the entity index, so it is not compared either — which
    // is why a re-GUIDed relationship object does not show up as churn.
    expect(fingerprints.every((f) => f.key.length === 22)).toBe(true);
    // `components` is populated: it is the content pass's only guard against a
    // dataHash collision retiring an unrelated pair.
    expect(fingerprints.every((f) => f.components?.['attr:core'] !== undefined)).toBe(true);
  });

  it('fingerprints the IfcObjectDefinitions the EntityTable does not hold', async () => {
    const store = await loadIfcBytes(
      new TextEncoder().encode(scheduleModel(guid('OLDT'))),
      'base',
    );
    const byKey = new Map(buildFileFingerprints(store).map((f) => [f.key, f.ifcType]));

    // An IfcTask and an IfcActor are IfcObjectDefinitions with GlobalIds, but
    // neither is an IfcProduct subtype, so the columnar parser leaves them out
    // of its EntityTable and `getGlobalId` answers ''. Reading the table alone
    // dropped them from the comparison entirely.
    expect(byKey.get(guid('OLDT'))).toBe('IfcTask');
    expect(byKey.get(guid('ACTR'))).toBe('IfcActor');
    // And with a real class name, not the table's 'Unknown': ifcType is hashed
    // into the fingerprint and cross-checked on every content match, so
    // 'Unknown' would let a task pair with an actor.
    expect([...byKey.values()]).not.toContain('Unknown');

    // The other two IfcRoot branches stay out. Both of these carry GlobalIds.
    expect(byKey.has(guid('RELP'))).toBe(false);
    expect(byKey.has(guid('RELC'))).toBe(false);
    expect(byKey.has(guid('PSET'))).toBe(false);
    // IfcMaterial is not an IfcRoot at all. The parser fills the table's
    // GlobalId column positionally, so slot 0 — the material Name — used to
    // read back as a GlobalId and enter the diff as a key.
    expect(byKey.has('brick')).toBe(false);
    // A class no schema registry knows keeps exactly the reach it had before:
    // whatever the EntityTable holds, and no source read. Treating an
    // unrecognised class as a possible IfcRoot instead would mean reading a
    // STEP record for every row of every unrecognised type in the file, which
    // on a vendor-extended model is the geometry buckets. The cost of that is
    // paid on every file to reach entities almost no file has; the price of
    // this line is that a vendor IfcRoot subtype stays uncompared.
    expect(byKey.has(guid('VEND'))).toBe(false);
    // Except where the table already reaches it: the parser's type-object
    // branch is name-based, so an unrecognised `…Type` class is in the table
    // with a real GlobalId and keeps being compared, as it was before.
    expect(byKey.has(guid('VTYP'))).toBe(true);
    // The parser's other name-based branch takes unrecognised `IfcRel…`
    // classes in too, and that one has to be shut here — otherwise it is the
    // single way a relationship still reaches the comparison.
    expect(byKey.has(guid('VREL'))).toBe(false);

    expect([...byKey.keys()].sort()).toEqual(
      [guid('PROJ'), guid('STOR'), guid('WALL'), guid('OLDT'), guid('ACTR'), guid('VTYP')].sort(),
    );
  }, 30_000);

  it('gives the same entity the same data hash across a re-GUID', async () => {
    const base = buildFileFingerprints(
      await loadIfcBytes(new TextEncoder().encode(BASE_MODEL), 'base'),
    );
    const head = buildFileFingerprints(
      await loadIfcBytes(new TextEncoder().encode(HEAD_MODEL), 'head'),
    );
    const oldA = base.find((f) => f.key === guid('OLDA'));
    const newA = head.find((f) => f.key === guid('NEWA'));

    expect(oldA?.dataHash).toBe(newA?.dataHash);
    expect(oldA?.dataHash).not.toBe(base.find((f) => f.key === guid('OLDB'))?.dataHash);
  });
});

describe('modelIdentityOf', () => {
  it('digests the bytes as they sit on disk', () => {
    const identity = modelIdentityOf('v1.ifc', new TextEncoder().encode('hello'));
    // sha256("hello"), i.e. what `shasum -a 256` prints for the same file.
    expect(identity.hash).toBe(
      'sha256:2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
    );
    expect(identity.path).toBe('v1.ifc');
  });
});

describe('ifc-lite diff --by-content', () => {
  let dir: string;
  let basePath: string;
  let headPath: string;
  let mapPath: string;
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ifclite-identity-'));
    basePath = join(dir, 'v1.ifc');
    headPath = join(dir, 'v2.ifc');
    mapPath = join(dir, 'renames.json');
    await writeFile(basePath, BASE_MODEL, 'utf-8');
    await writeFile(headPath, HEAD_MODEL, 'utf-8');
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
  });

  function stdoutJson(): {
    counts: { added: number; modified: number; deleted: number; unchanged: number };
    scope: string;
    contentMatches: { kind: string; base: string[]; head: string[] }[];
    identityMap: {
      in?: { path: string; applied: number; ignored: number };
      out?: { path: string; entries: number };
    };
  } {
    return JSON.parse(stdoutSpy.mock.calls.map((c) => String(c[0])).join(''));
  }

  it('pairs the re-GUIDed walls by content and writes them into a sidecar', async () => {
    await contentDiffCommand({ basePath, headPath, identityOut: mapPath, json: true });
    const result = stdoutJson();

    expect(result.scope).toBe('data');
    // The re-GUID is recognised, so it is NOT reported as two adds and two
    // deletes — which is exactly what a plain key diff would say.
    expect(result.counts).toEqual({ added: 0, modified: 0, deleted: 0, unchanged: 2 });
    expect(result.contentMatches.map((m) => m.kind).sort()).toEqual(['renamed', 'renamed']);

    const sidecar = JSON.parse(await readFile(mapPath, 'utf-8'));
    expect(sidecar.format).toBe('ifc-lite/identity-map');
    expect(sidecar.version).toBe(1);
    expect(sidecar.base.hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(sidecar.head.hash).not.toBe(sidecar.base.hash);
    expect(sidecar.entries).toEqual([
      { base: guid('OLDA'), here: guid('NEWA'), reason: 'content-match:renamed' },
      { base: guid('OLDB'), here: guid('NEWB'), reason: 'content-match:renamed' },
    ]);
  }, 30_000);

  it('replays the sidecar: the walls are matched by key and never reach the content pass', async () => {
    await contentDiffCommand({ basePath, headPath, identityOut: mapPath, json: true });
    stdoutSpy.mockClear();

    await contentDiffCommand({ basePath, headPath, identityIn: mapPath, json: true });
    const result = stdoutJson();

    expect(result.counts).toEqual({ added: 0, modified: 0, deleted: 0, unchanged: 4 });
    expect(result.contentMatches).toEqual([]);
    expect(result.identityMap.in).toEqual({ path: mapPath, applied: 2, ignored: 0 });
  }, 30_000);

  it('consuming and emitting the same map preserves the claims instead of eroding them', async () => {
    await contentDiffCommand({ basePath, headPath, identityOut: mapPath, json: true });
    stdoutSpy.mockClear();

    // An applied alias is matched by key, so the pair is no longer a content
    // match: deriving the output from the matches alone would empty the file.
    await contentDiffCommand({
      basePath,
      headPath,
      identityIn: mapPath,
      identityOut: mapPath,
      json: true,
    });

    const sidecar = JSON.parse(await readFile(mapPath, 'utf-8'));
    expect(sidecar.entries).toEqual([
      { base: guid('OLDA'), here: guid('NEWA'), reason: 'content-match:renamed' },
      { base: guid('OLDB'), here: guid('NEWB'), reason: 'content-match:renamed' },
    ]);
    expect(stdoutJson().identityMap.out).toEqual({ path: mapPath, entries: 2 });
  }, 30_000);

  it('writes byte-identical bytes on a rerun, so a checked-in sidecar stays quiet', async () => {
    await contentDiffCommand({ basePath, headPath, identityOut: mapPath, json: true });
    const first = await readFile(mapPath, 'utf-8');

    stdoutSpy.mockClear();
    await contentDiffCommand({ basePath, headPath, identityOut: mapPath, json: true });
    const second = await readFile(mapPath, 'utf-8');

    // A fresh `created` stamp on every run would defeat the builder's stable
    // sort: the file would show a diff whenever it was regenerated, saying
    // nothing about the claims.
    expect(second).toBe(first);
    expect(JSON.parse(first).created).toBeUndefined();
  }, 30_000);

  it('carry-forward is byte-stable too, and preserves an incoming `created`', async () => {
    await contentDiffCommand({ basePath, headPath, identityOut: mapPath, json: true });

    // A human (or another producer) dated the claims. Rewriting the map must
    // date the claims, not the rewrite.
    const stamped = { ...JSON.parse(await readFile(mapPath, 'utf-8')), created: STAMP };
    await writeFile(mapPath, `${JSON.stringify(stamped, null, 2)}\n`, 'utf-8');

    stdoutSpy.mockClear();
    await contentDiffCommand({
      basePath,
      headPath,
      identityIn: mapPath,
      identityOut: mapPath,
      json: true,
    });
    const once = await readFile(mapPath, 'utf-8');
    expect(JSON.parse(once).created).toBe(STAMP);

    stdoutSpy.mockClear();
    await contentDiffCommand({
      basePath,
      headPath,
      identityIn: mapPath,
      identityOut: mapPath,
      json: true,
    });
    expect(await readFile(mapPath, 'utf-8')).toBe(once);
  }, 30_000);

  it('refuses a sidecar that was verified against different files', async () => {
    await contentDiffCommand({ basePath, headPath, identityOut: mapPath, json: true });
    stdoutSpy.mockClear();

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((() => {
      throw new Error('process.exit called');
    }) as unknown) as (code?: number) => never);
    try {
      // Swapping the two files makes the pinned digests disagree — the claims
      // were never reviewed against THIS pair.
      await expect(
        contentDiffCommand({
          basePath: headPath,
          headPath: basePath,
          identityIn: mapPath,
          json: true,
        }),
      ).rejects.toThrow('process.exit called');
      const stderr = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
      expect(stderr).toContain('was not verified against these files');
    } finally {
      exitSpy.mockRestore();
    }
  }, 30_000);

  it('refuses a sidecar that is not one', async () => {
    await writeFile(mapPath, '{"renames":{"a":"b"}}', 'utf-8');
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((() => {
      throw new Error('process.exit called');
    }) as unknown) as (code?: number) => never);
    try {
      await expect(
        contentDiffCommand({ basePath, headPath, identityIn: mapPath, json: true }),
      ).rejects.toThrow('process.exit called');
      expect(stderrSpy.mock.calls.map((c) => String(c[0])).join('')).toContain(
        'Invalid identity-map sidecar',
      );
    } finally {
      exitSpy.mockRestore();
    }
  }, 30_000);

  it('drops a claim that no longer holds rather than carrying it forward', async () => {
    // A hand-edited map pointing at a base GlobalId this file does not contain.
    const identity = modelIdentityOf(basePath, await readFile(basePath));
    const headIdentity = modelIdentityOf(headPath, await readFile(headPath));
    await writeFile(
      mapPath,
      JSON.stringify({
        format: 'ifc-lite/identity-map',
        version: 1,
        base: identity,
        head: headIdentity,
        entries: [
          { base: guid('GONE'), here: guid('NEWA'), reason: 'hand-written' },
          { base: guid('OLDB'), here: guid('NEWB'), reason: 'hand-written' },
        ],
      }),
      'utf-8',
    );

    await contentDiffCommand({
      basePath,
      headPath,
      identityIn: mapPath,
      identityOut: mapPath,
      json: true,
    });

    const result = stdoutJson();
    expect(result.identityMap.in).toEqual({ path: mapPath, applied: 1, ignored: 1 });

    const sidecar = JSON.parse(await readFile(mapPath, 'utf-8'));
    // The stale claim is gone; the surviving one keeps its own provenance, and
    // the wall it stranded is re-derived by content matching.
    expect(sidecar.entries).toEqual([
      { base: guid('OLDA'), here: guid('NEWA'), reason: 'content-match:renamed' },
      { base: guid('OLDB'), here: guid('NEWB'), reason: 'hand-written' },
    ]);
  }, 30_000);

  it('matches a re-GUIDed IfcTask and writes it into the sidecar', async () => {
    // The schedule half of a model is exactly what a from-scratch re-export
    // re-GUIDs, and until the fingerprint pass could see an IfcTask at all it
    // was not compared, not matched, and not reported either way.
    await writeFile(basePath, scheduleModel(guid('OLDT')), 'utf-8');
    await writeFile(headPath, scheduleModel(guid('NEWT')), 'utf-8');

    await contentDiffCommand({ basePath, headPath, identityOut: mapPath, json: true });

    const result = stdoutJson();
    expect(result.contentMatches).toEqual([
      { kind: 'renamed', base: [guid('OLDT')], head: [guid('NEWT')] },
    ]);
    // Project, storey, wall, actor and the vendor type are matched by key; the
    // task is retired by the content pass and reported as a match rather than
    // as churn.
    expect(result.counts).toEqual({ added: 0, modified: 0, deleted: 0, unchanged: 5 });
    expect(JSON.parse(await readFile(mapPath, 'utf-8')).entries).toEqual([
      { base: guid('OLDT'), here: guid('NEWT'), reason: 'content-match:renamed' },
    ]);
  }, 30_000);

  it('prints a human-readable report without --json', async () => {
    await contentDiffCommand({ basePath, headPath, json: true });
    stdoutSpy.mockClear();
    await contentDiffCommand({ basePath, headPath, json: false });
    const text = stdoutSpy.mock.calls.map((c) => String(c[0])).join('');

    expect(text).toContain('Scope: data');
    expect(text).toContain('Content matches:');
    expect(text).toContain('renamed');
    expect(() => JSON.parse(text)).toThrow();
  }, 30_000);
});
