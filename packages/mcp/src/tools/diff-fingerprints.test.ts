/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The comparison scope this server shares with the CLI (issue #1891).
 *
 * `diff-fingerprints.ts` is a deliberate copy of the CLI's adapter, and the
 * copies drifted within hours of the first one landing: the CLI's membership
 * check moved to the cross-schema inheritance lookup (#2001) and this one was
 * left on the IFC4 codegen pin, which silently drops the 23 IFC2X3 and 77
 * IFC4X3 `IfcObjectDefinition` classes that pin does not carry — and lets an
 * IFC2X3 *resource* class in under its Name.
 *
 * Two suites below, and the second is why this file exists. The first pins the
 * behaviour on an IFC2X3 file directly. The second runs **both copies over the
 * same bytes** and requires them to answer with the same entities under the
 * same type names, so a change to either copy alone fails here rather than
 * shipping. The paired suites the copies had before (`diff.test.ts` here,
 * `diff-content.test.ts` in the CLI) could not do that: they assert the same
 * behaviour separately, so fixing one and not the other passes both.
 *
 * The fixtures are the CLI's own (`diff-test-helpers.ts`), imported rather than
 * re-typed. Sharing them is the point: a parity assertion over two different
 * models proves nothing.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildFileFingerprints } from '../../../cli/src/commands/diff-engine.js';
import {
  guid,
  legacyScheduleModel,
  model,
  railTypeModel,
  scheduleModel,
  typeTagModel,
} from '../../../cli/src/commands/diff-test-helpers.js';
import type { CallToolResult } from '../protocol/index.js';
import type { ToolContext } from '../context.js';
import { DEFAULT_CONFIG, InMemoryModelRegistry, NOOP_PROGRESS, SILENT_LOGGER } from '../context.js';
import { fullScope } from '../auth/scope.js';
import { loadIfcModel } from '../loader.js';
import { diffTools } from './diff.js';
import { buildModelFingerprints } from './diff-fingerprints.js';

interface DiffShape {
  entityDiff: { added: string[]; removed: string[]; common: number } | null;
  contentDiff: {
    counts: { added: number; deleted: number };
    contentMatchCounts: Record<string, number>;
    contentMatches: Array<{ kind: string; ifcType?: string; base: string[]; head: string[] }>;
  } | null;
}

let tmp: string;
const ctx: ToolContext = {
  registry: new InMemoryModelRegistry(),
  scope: fullScope(),
  progress: NOOP_PROGRESS,
  log: SILENT_LOGGER,
  signal: new AbortController().signal,
  config: { ...DEFAULT_CONFIG },
};

/** Write a STEP string to disk and load it into the registry under `id`. */
async function load(id: string, content: string): Promise<void> {
  const path = join(tmp, `${id}.ifc`);
  await writeFile(path, content, 'utf-8');
  ctx.registry.add(await loadIfcModel(path, { modelId: id }));
}

async function diff(input: Record<string, unknown>): Promise<DiffShape> {
  const tool = diffTools.find((t) => t.name === 'model_diff');
  if (!tool) throw new Error('model_diff not registered');
  const result: CallToolResult = await tool.handler(input, ctx);
  expect(result.isError).toBeUndefined();
  return result.structuredContent as unknown as DiffShape;
}

function store(id: string) {
  const loaded = ctx.registry.get(id);
  if (!loaded) throw new Error(`${id} not loaded`);
  return loaded.store;
}

/** Every fingerprint's key mapped to the type name it was hashed under. */
function keyedTypes(id: string): Map<string, string> {
  return new Map(buildModelFingerprints(store(id)).map((f) => [f.key, f.ifcType]));
}

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'ifc-lite-mcp-scope-'));
  await load('legacy-base', legacyScheduleModel(guid('OLDM')));
  await load('legacy-head', legacyScheduleModel(guid('NEWM')));
  await load('sched', scheduleModel(guid('OLDT')));
  await load('walls', model(guid('OLDA'), guid('OLDB')));
  await load('type-tags', typeTagModel());
  await load('rail-types', railTypeModel());
}, 60_000);

afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe('buildModelFingerprints on an IFC2X3 file', () => {
  it('fingerprints an object class the IFC4 codegen pin does not carry', () => {
    // The parser's generated registry is pinned to IFC4_ADD2_TC1 and answers an
    // empty chain for the 23 IFC2X3 IfcObjectDefinition classes IFC4 dropped.
    // Judged `unknown`, every one the EntityTable does not hold left the
    // comparison entirely — silently, on the schema most files in the wild
    // still use.
    expect(store('legacy-base').entities.getGlobalId(
      store('legacy-base').entityIndex.byType.get('IFCMOVE')![0],
    )).toBe('');

    const byKey = keyedTypes('legacy-base');
    expect(byKey.get(guid('OLDM'))).toBe('IfcMove');
    expect(byKey.get(guid('SPGM'))).toBe('IfcSpaceProgram');
    // Under its own class name, not the EntityTable's 'Unknown': `ifcType` is
    // hashed into the fingerprint and cross-checked on every content match, so
    // 'Unknown' would let an IfcMove pair with an IfcSpaceProgram.
    expect([...byKey.values()]).not.toContain('Unknown');
  });

  it('does not key an IFC2X3 resource entity by its Name', () => {
    // The other half of the same defect. IfcSymbolStyle is a resource with a
    // Name in slot 0 and no GlobalId, but its class name ends in STYLE, one of
    // the parser's two name-based branches, so the EntityTable does hold it —
    // with `hatch` in the GlobalId column. Without an IFC2X3 chain to prove it
    // is not an IfcRoot, `hatch` was a fingerprint key, and any other resource
    // named `hatch` collided with it.
    expect(store('legacy-base').entities.getGlobalId(
      store('legacy-base').entityIndex.byType.get('IFCSYMBOLSTYLE')![0],
    )).toBe('hatch');

    const byKey = keyedTypes('legacy-base');
    expect(byKey.has('hatch')).toBe(false);
    expect([...byKey.keys()].sort()).toEqual(
      [guid('PROJ'), guid('STOR'), guid('WALL'), guid('OLDM'), guid('SPGM'), guid('GTTY')].sort(),
    );
  });

  it('matches a re-GUIDed IFC2X3 object through the tool surface', async () => {
    const out = await diff({ a: 'legacy-base', b: 'legacy-head', by_content: true });
    const content = out.contentDiff;
    if (!content) throw new Error('by_content produced no contentDiff');

    // The IfcMove was re-GUIDed and nothing else changed, so the content pass
    // recognises it. On the IFC4 pin it was not in the comparison at all, and
    // the tool reported a clean `renamed: 0` — the agent-facing failure this
    // whole scope exists to prevent, since nothing in the answer says an entity
    // was skipped.
    expect(content.contentMatchCounts).toEqual({ renamed: 1 });
    expect(content.contentMatches[0]).toMatchObject({
      kind: 'renamed',
      ifcType: 'IfcMove',
      base: [guid('OLDM')],
      head: [guid('NEWM')],
    });
    expect(content.counts.added).toBe(0);
    expect(content.counts.deleted).toBe(0);
    // And no candidate on either side is the IfcSymbolStyle's Name.
    const touched = content.contentMatches.flatMap((m) => [...m.base, ...m.head]);
    expect(touched).not.toContain('hatch');
  }, 30_000);
});

describe('fingerprint parity with the CLI copy', () => {
  // `packages/cli/src/commands/diff-engine.ts` + `diff-scope.ts` compute the
  // same answer for `ifc-lite diff`. A fingerprint means nothing unless both
  // producers compute it over the same entities AND hash them identically, and
  // the two copies cannot be shared (the CLI depends on this package, so the
  // import can only run the other way) — so the agreement is asserted rather
  // than assumed.
  //
  // The comparison is over the whole fingerprint, not just the scope. It used
  // to be keys and type names only, which left the two `buildDataInput`s free
  // to drift on what they hash — the exact drift #2021 could have introduced by
  // teaching one copy about `Tag` and not the other. `type-tags` is in the
  // fixture list for that reason: it is the only one carrying a type object
  // whose Tag is hashed and an occurrence whose Tag is not.
  //
  // `rail-types` covers the schema axis of the same risk. Its `IfcRailType` is
  // IFC4X3-only, so a copy that resolves attribute names through the IFC4
  // codegen pin silently reads no Tag at all while every IFC2X3 and IFC4
  // fixture above still agrees. Without this row, fixing one copy's attribute
  // lookup and not the other's would pass.
  it.each(['legacy-base', 'sched', 'walls', 'type-tags', 'rail-types'])(
    'answers as the CLI does on %s',
    (id) => {
      const mcp = new Map(
        buildModelFingerprints(store(id)).map((f) => [
          f.key,
          { ifcType: f.ifcType, dataHash: f.dataHash, components: f.components },
        ]),
      );
      const cli = new Map(
        buildFileFingerprints(store(id)).map((f) => [
          f.key,
          { ifcType: f.ifcType, dataHash: f.dataHash, components: f.components },
        ]),
      );

      expect([...mcp.keys()].sort()).toEqual([...cli.keys()].sort());
      for (const [key, fingerprint] of cli) expect(mcp.get(key)).toEqual(fingerprint);
      // A non-empty scope on every fixture: two empty maps are also equal.
      expect(mcp.size).toBeGreaterThan(0);
    },
  );
});
