/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `model_diff` with `by_content` (issue #1891).
 *
 * The scenario throughout is the one the flag exists for: two models that
 * describe the same building, where the second was re-exported from scratch and
 * every GlobalId is new. Without the flag an agent is told the whole model was
 * deleted and re-added; with it, the elements are recognised by content.
 *
 * The fingerprint adapter is a second copy of the CLI's (see
 * `diff-fingerprints.ts` for why), so the behaviours the two must share are
 * pinned here as well as in `packages/cli/src/commands/diff-content.test.ts` —
 * a drift in either copy fails a build.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CallToolResult } from '../protocol/index.js';
import type { ToolContext } from '../context.js';
import { DEFAULT_CONFIG, InMemoryModelRegistry, NOOP_PROGRESS, SILENT_LOGGER } from '../context.js';
import { fullScope } from '../auth/scope.js';
import { loadIfcModel } from '../loader.js';
import { diffTools } from './diff.js';
import { buildModelFingerprints } from './diff-fingerprints.js';

/** A 22-character IFC GlobalId from a short mnemonic. */
function guid(mnemonic: string): string {
  return (mnemonic + '0'.repeat(22)).slice(0, 22);
}

/** Project, units, context, storey — the preamble every fixture shares. */
const PREAMBLE = `#1= IFCPROJECT('${guid('PROJ')}',$,'Proj',$,$,$,$,(#20),#30);
#20= IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-5,#21,$);
#21= IFCAXIS2PLACEMENT3D(#22,$,$);
#22= IFCCARTESIANPOINT((0.,0.,0.));
#30= IFCUNITASSIGNMENT((#31));
#31= IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#40= IFCLOCALPLACEMENT($,#21);
#41= IFCBUILDINGSTOREY('${guid('STOR')}',$,'L01',$,$,#40,$,$,.ELEMENT.,0.);`;

function step(body: string): string {
  return `ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('m','2026',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
${PREAMBLE}
${body}
ENDSEC;
END-ISO-10303-21;
`;
}

/** Two *distinguishable* walls. `a`/`b` are the GlobalIds, so a from-scratch
 *  re-export is the same call with different ones. */
function twoWallsBody(a: string, b: string): string {
  return `#72= IFCWALL('${a}',$,'Wall A',$,$,#40,$,'tagA',$);
#73= IFCWALL('${b}',$,'Wall B',$,$,#40,$,'tagB',$);`;
}

/** Two walls identical in every field the data hash can see. Nothing can tell
 *  which became which, which is the `ambiguous` case. */
function twinWallsBody(a: string, b: string): string {
  return `#74= IFCWALL('${a}',$,'Twin',$,$,#40,$,'tag',$);
#75= IFCWALL('${b}',$,'Twin',$,$,#40,$,'tag',$);`;
}

/**
 * One entity from each `IfcRoot` branch plus an `IfcMaterial`.
 *
 * `IfcTask` is an `IfcObjectDefinition` the columnar parser does not put in its
 * `EntityTable` (it is not an `IfcProduct` subtype), so its GlobalId has to come
 * from the STEP record. `IfcRelDefinesByProperties` and `IfcPropertySet` carry
 * GlobalIds and must stay out. `IfcMaterial` has no GlobalId at all — its first
 * attribute is a Name, which the parser's positional extraction stores in the
 * table's GlobalId column.
 */
function scheduleModel(taskGuid: string, psetGuid: string, relGuid: string): string {
  return step(`#70= IFCWALL('${guid('WALL')}',$,'Wall A',$,$,#40,$,'tagA',$);
#80= IFCMATERIAL('brick',$,$);
#81= IFCPROPERTYSET('${psetGuid}',$,'Pset_X',$,(#82));
#82= IFCPROPERTYSINGLEVALUE('P',$,IFCLABEL('v'),$);
#83= IFCRELDEFINESBYPROPERTIES('${relGuid}',$,$,$,(#70),#81);
#90= IFCTASK('${taskGuid}',$,'Pour slab',$,$,$,$,'ID1',$,.F.,$,$,.CONSTRUCTION.);`);
}

interface ContentDiffShape {
  scope: string;
  counts: { added: number; modified: number; deleted: number; unchanged: number };
  contentMatchCounts: Record<string, number>;
  contentMatches: Array<{
    kind: string;
    ifcType?: string;
    base: string[];
    baseCount: number;
    baseTruncated: boolean;
    head: string[];
    headCount: number;
    headTruncated: boolean;
  }>;
  truncatedMatches: number;
}

interface DiffShape {
  typeDiffs: Array<{ type: string; delta: number }>;
  entityDiff: { added: string[]; removed: string[]; common: number } | null;
  contentDiff: ContentDiffShape | null;
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

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'ifc-lite-mcp-diff-'));
  await load('base', step(twoWallsBody(guid('OLDA'), guid('OLDB'))));
  await load('head', step(twoWallsBody(guid('NEWA'), guid('NEWB'))));
  await load('twins-base', step(twinWallsBody(guid('TWA'), guid('TWB'))));
  await load('twins-head', step(twinWallsBody(guid('TWC'), guid('TWD'))));
  await load('sched-base', scheduleModel(guid('OLDT'), guid('PSTA'), guid('RELA')));
  await load('sched-head', scheduleModel(guid('NEWT'), guid('PSTB'), guid('RELB')));
}, 60_000);

afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe('model_diff by_content', () => {
  it('is off by default, and the GlobalId pass reads a re-export as churn', async () => {
    const out = await diff({ a: 'base', b: 'head' });

    // The pathology the flag exists for: nothing about the building changed,
    // and the naive set intersection says both walls were deleted and re-added.
    expect(out.entityDiff?.added.sort()).toEqual([guid('NEWA'), guid('NEWB')].sort());
    expect(out.entityDiff?.removed.sort()).toEqual([guid('OLDA'), guid('OLDB')].sort());
    // Default off: `counts` semantics under existing agent scripts are unchanged.
    expect(out.contentDiff).toBeNull();
  });

  it('recognises the re-GUIDed elements when asked', async () => {
    const out = await diff({ a: 'base', b: 'head', by_content: true });
    const content = out.contentDiff;
    if (!content) throw new Error('by_content produced no contentDiff');

    // Node has no geometry pipeline here; `data` is the honest scope, and it is
    // reported rather than assumed by the caller.
    expect(content.scope).toBe('data');
    // Both walls retired as renamed, so the re-export is no longer churn.
    expect(content.counts.added).toBe(0);
    expect(content.counts.deleted).toBe(0);
    expect(content.contentMatchCounts).toEqual({ renamed: 2 });
    expect(content.truncatedMatches).toBe(0);

    const renames = new Map(content.contentMatches.map((m) => [m.base[0], m.head[0]]));
    expect(renames.get(guid('OLDA'))).toBe(guid('NEWA'));
    expect(renames.get(guid('OLDB'))).toBe(guid('NEWB'));
    expect(content.contentMatches.every((m) => m.ifcType === 'IfcWall')).toBe(true);

    // The GlobalId pass is untouched by the flag: an agent that reads both
    // still sees exactly what each one measured.
    expect(out.entityDiff?.added).toHaveLength(2);
  });

  it('lists an ambiguous group as a group instead of guessing a pairing', async () => {
    const out = await diff({ a: 'twins-base', b: 'twins-head', by_content: true });
    const content = out.contentDiff;
    if (!content) throw new Error('by_content produced no contentDiff');

    expect(content.contentMatchCounts).toEqual({ ambiguous: 1 });
    const group = content.contentMatches[0];
    expect(group.base.sort()).toEqual([guid('TWA'), guid('TWB')].sort());
    expect(group.head.sort()).toEqual([guid('TWC'), guid('TWD')].sort());
    // Nothing was retired: an unresolved group leaves the added/deleted entries
    // standing, so the counts still say four entities need a human.
    expect(content.counts.added).toBe(2);
    expect(content.counts.deleted).toBe(2);
  });

  it('fingerprints every IfcObjectDefinition and nothing else', () => {
    const model = ctx.registry.get('sched-base');
    if (!model) throw new Error('sched-base not loaded');
    const fingerprints = buildModelFingerprints(model.store);
    const byKey = new Map(fingerprints.map((f) => [f.key, f.ifcType]));

    // `components` is populated, not just `dataHash`: it is the content pass's
    // only guard against a dataHash collision retiring an unrelated add/delete
    // pair, and the check is inert unless BOTH sides supply them.
    expect(fingerprints.every((f) => f.components?.['attr:core'] !== undefined)).toBe(true);

    // The IfcTask is an IfcObjectDefinition the columnar parser does not put in
    // its EntityTable (it is not an IfcProduct subtype), so `getGlobalId`
    // answers ''. Reading the table alone drops it from the comparison
    // entirely; the chain check sends it to its STEP record instead.
    expect(byKey.get(guid('OLDT'))).toBe('IfcTask');
    // And with a real class name, not the table's 'Unknown': ifcType is hashed
    // into the fingerprint and cross-checked on every content match, so
    // 'Unknown' would let a task pair with an actor.
    expect([...byKey.values()]).not.toContain('Unknown');

    // 'brick' is an IfcMaterial *Name*. The parser fills the table's GlobalId
    // column positionally and slot 0 of a resource entity is not a GlobalId, so
    // without the IfcRoot check a material enters the comparison under its name
    // — and collides with any surface style or classification of the same name.
    expect(byKey.has('brick')).toBe(false);
    // The other two IfcRoot branches stay out even though both carry GlobalIds.
    expect(byKey.has(guid('PSTA'))).toBe(false);
    expect(byKey.has(guid('RELA'))).toBe(false);

    expect([...byKey.keys()].sort()).toEqual(
      [guid('PROJ'), guid('STOR'), guid('WALL'), guid('OLDT')].sort(),
    );
  });

  it('inherits the chain-checked extractor: IfcTask in, pset/rel/material out', async () => {
    const out = await diff({ a: 'sched-base', b: 'sched-head', by_content: true });
    const content = out.contentDiff;
    if (!content) throw new Error('by_content produced no contentDiff');

    // The IfcTask is an IfcObjectDefinition the EntityTable does not hold. Read
    // from the store alone it reports an empty GlobalId and drops out of the
    // comparison entirely; read from its STEP record it is matched by content.
    expect(content.contentMatchCounts).toEqual({ renamed: 1 });
    expect(content.contentMatches[0]).toMatchObject({
      kind: 'renamed',
      ifcType: 'IfcTask',
      base: [guid('OLDT')],
      head: [guid('NEWT')],
    });

    // The IfcPropertySet and the IfcRelDefinesByProperties were re-GUIDed too,
    // and neither is reported: a pset's content is already folded into its
    // owner's data hash, and a relationship's identity is its endpoints.
    expect(content.counts.added).toBe(0);
    expect(content.counts.deleted).toBe(0);
    const touched = content.contentMatches.flatMap((m) => [...m.base, ...m.head]);
    expect(touched).not.toContain(guid('PSTA'));
    expect(touched).not.toContain(guid('RELB'));
    // 'brick' is an IfcMaterial Name sitting in the table's GlobalId column. It
    // is not an IfcRoot, so the chain check keeps it out of the key set.
    expect(touched).not.toContain('brick');
  });

  it('caps the listed matches without hiding anything', async () => {
    const out = await diff({ a: 'base', b: 'head', by_content: true, max_matches: 1 });
    const content = out.contentDiff;
    if (!content) throw new Error('by_content produced no contentDiff');

    expect(content.contentMatches).toHaveLength(1);
    expect(content.truncatedMatches).toBe(1);
    // The per-kind totals are computed before the cap, so the cap can never be
    // what makes a model look cleanly matched.
    expect(content.contentMatchCounts).toEqual({ renamed: 2 });
  });

  it('caps the members of one group, and still reports its whole size', async () => {
    // `max_matches` bounds how many groups come back, not how big one is. A
    // single ambiguous group in a repetitive model can hold thousands of
    // GlobalIds per side, so a cap of 1 could still return a model-sized
    // payload — the exact overflow the cap exists to prevent.
    const triplets = (a: string, b: string, c: string): string =>
      `#74= IFCWALL('${a}',$,'Triplet',$,$,#40,$,'tag',$);
#75= IFCWALL('${b}',$,'Triplet',$,$,#40,$,'tag',$);
#76= IFCWALL('${c}',$,'Triplet',$,$,#40,$,'tag',$);`;
    await load('trip-base', step(triplets(guid('TPA'), guid('TPB'), guid('TPC'))));
    await load('trip-head', step(triplets(guid('TPD'), guid('TPE'), guid('TPF'))));

    const out = await diff({ a: 'trip-base', b: 'trip-head', by_content: true, max_group_members: 2 });
    const group = out.contentDiff?.contentMatches[0];
    if (!group) throw new Error('by_content produced no group');

    expect(group.kind).toBe('ambiguous');
    expect(group.base).toHaveLength(2);
    expect(group.head).toHaveLength(2);
    // The whole size is reported either way, computed before the cap for the
    // same reason `contentMatchCounts` is: a cut list must never be able to
    // make a three-way ambiguity read as a two-way one.
    expect(group.baseCount).toBe(3);
    expect(group.headCount).toBe(3);
    expect(group.baseTruncated).toBe(true);
    expect(group.headTruncated).toBe(true);
    // And the group is still a group: nothing was retired by the cap.
    expect(out.contentDiff?.counts.added).toBe(3);
    expect(out.contentDiff?.counts.deleted).toBe(3);
  }, 30_000);

  it('leaves a 1:1 pair whole and says it was not truncated', async () => {
    const out = await diff({ a: 'base', b: 'head', by_content: true });
    const match = out.contentDiff?.contentMatches[0];
    if (!match) throw new Error('by_content produced no match');

    expect(match.baseCount).toBe(1);
    expect(match.headCount).toBe(1);
    expect(match.baseTruncated).toBe(false);
    expect(match.headTruncated).toBe(false);
  });

  it('lists the groups a human must resolve before the ones already resolved', async () => {
    // One ambiguous twin group plus two renamed walls in one comparison: the
    // cap must not be what drops the "we could not tell" answer. The twins are
    // written LAST (and carry the higher express ids) so the engine's own
    // bucket order puts the ambiguous group at the end — only the sort can
    // bring it to the front, which is what makes the assertion below bite.
    await load('mixed-base', step(`${twoWallsBody(guid('MXC'), guid('MXD'))}
${twinWallsBody(guid('MXA'), guid('MXB'))}`));
    await load('mixed-head', step(`${twoWallsBody(guid('MXG'), guid('MXH'))}
${twinWallsBody(guid('MXE'), guid('MXF'))}`));

    const out = await diff({ a: 'mixed-base', b: 'mixed-head', by_content: true, max_matches: 1 });
    const content = out.contentDiff;
    if (!content) throw new Error('by_content produced no contentDiff');

    expect(content.contentMatchCounts).toEqual({ ambiguous: 1, renamed: 2 });
    expect(content.contentMatches).toHaveLength(1);
    expect(content.contentMatches[0].kind).toBe('ambiguous');
    expect(content.truncatedMatches).toBe(2);
  }, 30_000);
});
