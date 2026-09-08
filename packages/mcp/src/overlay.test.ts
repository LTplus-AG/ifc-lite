/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `model_diff` over a session with queued mutations (#1891 review).
 *
 * A `model_id` names a session, not a file. The mutation tools queue their
 * edits in an overlay the parsed store never sees, so a diff read straight from
 * the store answered about the file as parsed: an agent that had just renamed,
 * created and deleted entities and then asked what changed was told "nothing".
 * Every test here drives the real mutation tools and then asks the real diff
 * tool, because that is the sequence an agent actually performs.
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CallToolResult } from './protocol/index.js';
import type { ToolContext } from './context.js';
import { DEFAULT_CONFIG, InMemoryModelRegistry, NOOP_PROGRESS, SILENT_LOGGER } from './context.js';
import { fullScope } from './auth/scope.js';
import { loadIfcModel } from './loader.js';
import { diffTools } from './tools/diff.js';
import { mutationTools } from './tools/mutate.js';
import { exportTools } from './tools/export.js';

/** A 22-character IFC GlobalId from a short mnemonic. */
function guid(mnemonic: string): string {
  return (mnemonic + '0'.repeat(22)).slice(0, 22);
}

/** One wall with two properties in one pset, plus the usual preamble. */
const MODEL = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('m','2026',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1= IFCPROJECT('${guid('PROJ')}',$,'Proj',$,$,$,$,(#20),#30);
#20= IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-5,#21,$);
#21= IFCAXIS2PLACEMENT3D(#22,$,$);
#22= IFCCARTESIANPOINT((0.,0.,0.));
#30= IFCUNITASSIGNMENT((#31));
#31= IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#40= IFCLOCALPLACEMENT($,#21);
#41= IFCBUILDINGSTOREY('${guid('STOR')}',$,'L01',$,$,#40,$,$,.ELEMENT.,0.);
#72= IFCWALL('${guid('WALA')}',$,'Wall A',$,$,#40,$,'tagA',$);
#73= IFCWALL('${guid('WALB')}',$,'Wall B',$,$,#40,$,'tagB',$);
#81= IFCPROPERTYSET('${guid('PSET')}',$,'Pset_WallCommon',$,(#82,#83));
#82= IFCPROPERTYSINGLEVALUE('IsExternal',$,IFCBOOLEAN(.T.),$);
#83= IFCPROPERTYSINGLEVALUE('LoadBearing',$,IFCBOOLEAN(.F.),$);
#84= IFCRELDEFINESBYPROPERTIES('${guid('RELA')}',$,$,$,(#72),#81);
ENDSEC;
END-ISO-10303-21;
`;

interface ContentDiffShape {
  counts: { added: number; modified: number; deleted: number; unchanged: number };
  contentMatchCounts: Record<string, number>;
  contentMatches: Array<{ kind: string; ifcType?: string; base: string[]; head: string[] }>;
  pendingMutations?: number;
  pendingMutationsBySide?: { base: number; head: number };
}

interface DiffShape {
  typeDiffs: Array<{ type: string; left: number; right: number; delta: number }>;
  entityDiff: { added: string[]; removed: string[]; common: number } | null;
  contentDiff: ContentDiffShape | null;
}

/**
 * One wall TYPE and one wall occurrence, each carrying a Tag. The Tag scoping
 * (#2021) is asymmetric, so a fixture that can show only one half of it would
 * let the other half rot.
 */
const TYPE_MODEL = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('m','2026',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1= IFCPROJECT('${guid('PROJ')}',$,'Proj',$,$,$,$,(#20),#30);
#20= IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-5,#21,$);
#21= IFCAXIS2PLACEMENT3D(#22,$,$);
#22= IFCCARTESIANPOINT((0.,0.,0.));
#30= IFCUNITASSIGNMENT((#31));
#31= IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#40= IFCLOCALPLACEMENT($,#21);
#50= IFCWALLTYPE('${guid('WTYP')}',$,'800 mm',$,$,$,$,'157200','800 mm',.STANDARD.);
#72= IFCWALL('${guid('WALA')}',$,'Wall A',$,$,#40,$,'tagA',$);
ENDSEC;
END-ISO-10303-21;
`;

let tmp: string;
let ctx: ToolContext;

const ALL_TOOLS = [...diffTools, ...mutationTools, ...exportTools];

async function call(name: string, input: Record<string, unknown>): Promise<CallToolResult> {
  const tool = ALL_TOOLS.find((t) => t.name === name);
  if (!tool) throw new Error(`${name} not registered`);
  const result = await tool.handler(input, ctx);
  expect(result.isError, `${name}: ${JSON.stringify(result.structuredContent)}`).toBeUndefined();
  return result;
}

async function diff(input: Record<string, unknown>): Promise<DiffShape> {
  const result = await call('model_diff', input);
  return result.structuredContent as unknown as DiffShape;
}

/**
 * A fresh registry with `base` and `head` loaded from the SAME bytes, so every
 * difference a test observes is one it queued itself. Per test, because a
 * mutation overlay lives for the life of the session model.
 */
async function session(): Promise<void> {
  ctx = {
    registry: new InMemoryModelRegistry(),
    scope: fullScope(),
    progress: NOOP_PROGRESS,
    log: SILENT_LOGGER,
    signal: new AbortController().signal,
    config: { ...DEFAULT_CONFIG, allowedPaths: [tmp] },
  };
  const path = join(tmp, 'm.ifc');
  ctx.registry.add(await loadIfcModel(path, { modelId: 'base' }));
  ctx.registry.add(await loadIfcModel(path, { modelId: 'head' }));
}

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'ifc-lite-mcp-overlay-'));
  await writeFile(join(tmp, 'm.ifc'), MODEL, 'utf-8');
  await writeFile(join(tmp, 'types.ifc'), TYPE_MODEL, 'utf-8');
});

/** {@link session}, over {@link TYPE_MODEL}. */
async function typeSession(): Promise<void> {
  ctx = {
    registry: new InMemoryModelRegistry(),
    scope: fullScope(),
    progress: NOOP_PROGRESS,
    log: SILENT_LOGGER,
    signal: new AbortController().signal,
    config: { ...DEFAULT_CONFIG, allowedPaths: [tmp] },
  };
  const path = join(tmp, 'types.ifc');
  ctx.registry.add(await loadIfcModel(path, { modelId: 'base' }));
  ctx.registry.add(await loadIfcModel(path, { modelId: 'head' }));
}

afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe('model_diff over queued mutations', () => {
  it('reads two unedited sessions as identical, and says nothing about mutations', async () => {
    await session();
    const out = await diff({ a: 'base', b: 'head', by_content: true });

    expect(out.typeDiffs).toEqual([]);
    // Six GlobalIds in the file; the content pass compares the four
    // IfcObjectDefinitions among them (the pset and the rel are excluded).
    expect(out.entityDiff).toEqual({ added: [], removed: [], common: 6 });
    expect(out.contentDiff?.counts).toEqual({ added: 0, modified: 0, deleted: 0, unchanged: 4 });
    // The field is absent rather than zeroed: a diff of two files as parsed
    // should not grow a mutation vocabulary it has no use for.
    expect(out.contentDiff).not.toHaveProperty('pendingMutations');
    expect(out.contentDiff).not.toHaveProperty('pendingMutationsBySide');
    expect(out).not.toHaveProperty('pendingMutations');
  }, 30_000);

  it('hashes a renamed entity at its new name', async () => {
    await session();
    await call('entity_set_attribute', {
      model_id: 'head', global_id: guid('WALA'), attribute: 'Name', value: 'Wall A renamed',
    });

    const out = await diff({ a: 'base', b: 'head', by_content: true });
    // The edit is invisible to a GlobalId comparison — which is exactly why the
    // content pass reading the same stale store was the damaging half.
    expect(out.entityDiff).toEqual({ added: [], removed: [], common: 6 });
    expect(out.contentDiff?.counts.modified).toBe(1);
    expect(out.contentDiff?.counts.unchanged).toBe(3);
    expect(out.contentDiff?.pendingMutations).toBe(1);
    expect(out.contentDiff?.pendingMutationsBySide).toEqual({ base: 0, head: 1 });
  }, 30_000);

  it('hashes an edited property at its new value, without losing its siblings', async () => {
    await session();
    await call('entity_set_property', {
      model_id: 'head', global_id: guid('WALA'), pset: 'Pset_WallCommon', name: 'IsExternal', value: false,
    });

    const out = await diff({ a: 'base', b: 'head', by_content: true });
    expect(out.contentDiff?.counts.modified).toBe(1);

    // The overlay's base for a property read is the columnar parser's on-demand
    // extraction, not `store.properties` (which the columnar parser leaves
    // empty). Without that wiring the edited wall would appear to have lost
    // LoadBearing as well, and this would report a second difference it made up.
    await call('entity_set_property', {
      model_id: 'base', global_id: guid('WALA'), pset: 'Pset_WallCommon', name: 'LoadBearing', value: false,
    });
    const same = await diff({ a: 'base', b: 'head', by_content: true });
    // base now has IsExternal=T, LoadBearing=F (unchanged value, re-set);
    // head has IsExternal=F, LoadBearing=F. Still exactly one difference.
    expect(same.contentDiff?.counts.modified).toBe(1);
  }, 30_000);

  it('adds a created entity and drops a deleted one, on all three passes', async () => {
    await session();
    await call('entity_create', {
      model_id: 'head',
      type: 'IfcWall',
      attributes: [`'${guid('WALC')}'`, null, "'Wall C'", null, null, '#40', null, "'tagC'", null],
    });
    await call('entity_delete', { model_id: 'head', global_id: guid('STOR') });

    const out = await diff({ a: 'base', b: 'head', by_content: true });

    // Type pass: the created wall lands on the existing IfcWall row rather than
    // opening a second one, and the tombstoned storey leaves.
    expect(out.typeDiffs).toEqual(expect.arrayContaining([
      { type: 'IfcWall', left: 2, right: 3, delta: 1 },
      { type: 'IfcBuildingStorey', left: 1, right: 0, delta: -1 },
    ]));
    // GlobalId pass.
    expect(out.entityDiff).toEqual({ added: [guid('WALC')], removed: [guid('STOR')], common: 5 });
    // Content pass. Nothing in base resembles the new wall and nothing in head
    // resembles the storey, so neither is retired by a content match.
    expect(out.contentDiff?.counts.added).toBe(1);
    expect(out.contentDiff?.counts.deleted).toBe(1);
    expect(out.contentDiff?.pendingMutations).toBe(2);
    expect(out.contentDiff?.pendingMutationsBySide).toEqual({ base: 0, head: 2 });
  }, 30_000);

  it('entity_create rejects an abstract IFC type (#2035)', async () => {
    await session();
    const tool = ALL_TOOLS.find((t) => t.name === 'entity_create');
    if (!tool) throw new Error('entity_create not registered');

    // `IfcProduct` is a real EXPRESS class (so a known-ness check alone
    // accepts it) but an ABSTRACT SUPERTYPE — instantiating it would write
    // `#N=IFCPRODUCT(...)` into the exported file, which is not valid IFC.
    // `entity_create` calls `StoreEditor.addEntity` directly (not through
    // the SDK's `bim.store.addEntity` wrapper), so it throws rather than
    // returning an `isError` result — the tool-call wrapper that would
    // catch this and shape it into a `CallToolResult` sits above the raw
    // handler invoked here.
    await expect(async () =>
      tool.handler({ model_id: 'head', type: 'IfcProduct', attributes: [] }, ctx),
    ).rejects.toThrow(/not in the IFC schema registry/);

    // A concrete subtype of the same abstract class still works.
    await call('entity_create', {
      model_id: 'head',
      type: 'IfcWall',
      attributes: [`'${guid('WALD')}'`, null, "'Wall D'", null, null, '#40', null, "'tagD'", null],
    });
  }, 30_000);

  it('content-matches a created entity against the one it replaces', async () => {
    await session();
    // The re-GUID the flag exists for, performed through the mutation tools:
    // delete Wall B and create the same wall under a fresh GlobalId.
    await call('entity_delete', { model_id: 'head', global_id: guid('WALB') });
    await call('entity_create', {
      model_id: 'head',
      type: 'IfcWall',
      attributes: [`'${guid('WALZ')}'`, null, "'Wall B'", null, null, '#40', null, "'tagB'", null],
    });

    const out = await diff({ a: 'base', b: 'head', by_content: true });

    // The GlobalId pass sees churn; the content pass recognises the wall. This
    // only works if the created entity is fingerprinted from real content —
    // a placeholder would leave it as an unmatched add plus an unmatched delete.
    expect(out.entityDiff?.added).toEqual([guid('WALZ')]);
    expect(out.entityDiff?.removed).toEqual([guid('WALB')]);
    expect(out.contentDiff?.contentMatchCounts).toEqual({ renamed: 1 });
    expect(out.contentDiff?.contentMatches[0]).toMatchObject({
      kind: 'renamed',
      ifcType: 'IfcWall',
      base: [guid('WALB')],
      head: [guid('WALZ')],
    });
    expect(out.contentDiff?.counts.added).toBe(0);
    expect(out.contentDiff?.counts.deleted).toBe(0);
  }, 30_000);

  it('hashes a created entity at its edited attributes, not its creation payload', async () => {
    await session();
    // base: give Wall B a description and an object type, so the head side has
    // all three hashed IfcRoot attributes to reproduce.
    await call('entity_set_attribute', {
      model_id: 'base', global_id: guid('WALB'), attribute: 'Description', value: 'Load-bearing',
    });
    await call('entity_set_attribute', {
      model_id: 'base', global_id: guid('WALB'), attribute: 'ObjectType', value: 'Exterior',
    });

    // head: the same re-GUID as above, but performed the way an agent actually
    // performs it — create the entity, then fill it in with entity_set_attribute.
    await call('entity_delete', { model_id: 'head', global_id: guid('WALB') });
    const created = await call('entity_create', {
      model_id: 'head',
      type: 'IfcWall',
      attributes: [`'${guid('WALZ')}'`, null, "'untitled'", null, null, '#40', null, "'tagB'", null],
    });
    const expressId = (created.structuredContent as { expressId: number }).expressId;
    for (const [attribute, value] of [
      ['Name', 'Wall B'], ['Description', 'Load-bearing'], ['ObjectType', 'Exterior'],
    ]) {
      await call('entity_set_attribute', { model_id: 'head', express_id: expressId, attribute, value });
    }

    const out = await diff({ a: 'base', b: 'head', by_content: true });
    // Fingerprinting a created entity from the frozen creation payload leaves it
    // hashed as an 'untitled' wall with no description and no object type, so
    // the wall it replaces reads as deleted and it reads as added. All three
    // attributes must reach the hash: dropping any one breaks the match.
    expect(out.contentDiff?.contentMatchCounts).toEqual({ renamed: 1 });
    expect(out.contentDiff?.contentMatches[0]).toMatchObject({
      kind: 'renamed',
      ifcType: 'IfcWall',
      base: [guid('WALB')],
      head: [guid('WALZ')],
    });
    expect(out.contentDiff?.counts.added).toBe(0);
    expect(out.contentDiff?.counts.deleted).toBe(0);
  }, 30_000);

  it('clears a created entity attribute the session cleared', async () => {
    await session();
    // The created entity is Wall B's twin as authored, so it content-matches
    // until the clear lands — which makes this the mirror of the rename: an
    // overlay read that fell back to the payload would keep matching.
    await call('entity_delete', { model_id: 'head', global_id: guid('WALB') });
    const created = await call('entity_create', {
      model_id: 'head',
      type: 'IfcWall',
      attributes: [`'${guid('WALZ')}'`, null, "'Wall B'", null, null, '#40', null, "'tagB'", null],
    });
    const expressId = (created.structuredContent as { expressId: number }).expressId;
    await call('entity_set_attribute', {
      model_id: 'head', express_id: expressId, attribute: 'Name', value: '',
    });

    const out = await diff({ a: 'base', b: 'head', by_content: true });
    expect(out.contentDiff?.contentMatchCounts).toEqual({});
    expect(out.contentDiff?.counts.added).toBe(1);
    expect(out.contentDiff?.counts.deleted).toBe(1);
  }, 30_000);

  it('keeps a created relationship out of the comparison', async () => {
    await session();
    await call('entity_create', {
      model_id: 'head',
      type: 'IfcRelAggregates',
      attributes: [`'${guid('RELZ')}'`, null, null, null, '#1', ['#41']],
    });

    const out = await diff({ a: 'base', b: 'head', by_content: true });
    // A relationship's identity is its endpoints, so it is excluded whether it
    // came out of the file or out of the overlay. The GlobalId pass, which has
    // no such rule, is what shows the entity really was created.
    expect(out.entityDiff?.added).toEqual([guid('RELZ')]);
    expect(out.contentDiff?.counts).toEqual({ added: 0, modified: 0, deleted: 0, unchanged: 4 });
  }, 30_000);

  it('exports the edited pset whole, siblings included', async () => {
    await session();
    await call('entity_set_property', {
      model_id: 'head', global_id: guid('WALA'), pset: 'Pset_WallCommon', name: 'IsExternal', value: false,
    });
    const out = join(tmp, 'out.ifc');
    await call('export_ifc', { model_id: 'head', file_path: out });
    const written = await readFile(out, 'utf-8');

    // The exporter re-emits the whole pset from the overlay and skips the
    // original records, so an overlay that cannot see the parsed properties
    // silently drops every property in that pset except the edited one.
    expect(written).toContain('LoadBearing');
    expect(written).toContain('IsExternal');
  }, 30_000);
});


describe('entity_set_attribute on Tag, which only a type object hashes (#2021)', () => {
  it('hashes a re-tagged TYPE object at its new Tag', async () => {
    await typeSession();
    await call('entity_set_attribute', {
      model_id: 'head', global_id: guid('WTYP'), attribute: 'Tag', value: '157607',
    });

    const out = await diff({ a: 'base', b: 'head', by_content: true });
    // Same GlobalId on both sides, so only the content pass can see this at
    // all — and it must, or an agent that re-tagged a type is told nothing
    // changed. This is the read-after-write shape of #2014, on the attribute
    // that had no fingerprint field until #2021 gave it one.
    expect(out.entityDiff).toEqual({ added: [], removed: [], common: 3 });
    expect(out.contentDiff?.counts.modified).toBe(1);
    expect(out.contentDiff?.pendingMutationsBySide).toEqual({ base: 0, head: 1 });
  }, 30_000);

  it('ignores a re-tagged OCCURRENCE, because its Tag is not hashed', async () => {
    await typeSession();
    await call('entity_set_attribute', {
      model_id: 'head', global_id: guid('WALA'), attribute: 'Tag', value: 'tagZ',
    });

    const out = await diff({ a: 'base', b: 'head', by_content: true });
    // Deliberate, not an oversight: an occurrence's Tag is the authoring tool's
    // element id, and hashing it would break matching across two exporters of
    // one design. The mutation is still queued and still reported as queued —
    // it just does not move the hash.
    expect(out.contentDiff?.counts.modified).toBe(0);
    expect(out.contentDiff?.counts.unchanged).toBe(3);
    expect(out.contentDiff?.pendingMutationsBySide).toEqual({ base: 0, head: 1 });
  }, 30_000);
});
