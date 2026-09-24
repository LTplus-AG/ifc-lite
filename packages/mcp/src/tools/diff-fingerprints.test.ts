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
  quantityModel,
  railTypeModel,
  scheduleModel,
  typeTagModel,
} from '../../../cli/src/commands/diff-test-helpers.js';
import { UNIT_SCALE_MILLIMETRE_MODEL } from '../../../cli/src/commands/diff-unit-scale-fixtures.js';
import type { CallToolResult } from '../protocol/index.js';
import type { ToolContext } from '../context.js';
import { DEFAULT_CONFIG, InMemoryModelRegistry, NOOP_PROGRESS, SILENT_LOGGER } from '../context.js';
import { fullScope } from '../auth/scope.js';
import { loadIfcModel } from '../loader.js';
import { diffTools } from './diff.js';
import { mutationTools } from './mutate.js';
import { buildModelFingerprints } from './diff-fingerprints.js';
import { fallbackPairDuplicateAuthoredKeys } from './diff-authored-keys.js';
import type { PendingOverlay } from '../overlay.js';
import { extractPropertiesOnDemand, extractQuantitiesOnDemand } from '@ifc-lite/parser';
import { MutablePropertyView, StoreEditor } from '@ifc-lite/mutations';
import { overlayFromView } from '../overlay.js';

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
  await load('walls-head', model(guid('NEWA'), guid('NEWB')));
  await load('walls-head-twins', model(guid('NEWA'), guid('NEWB')).replace("'tagB'", "'tagA'"));
  await load('type-tags', typeTagModel());
  await load('rail-types', railTypeModel());
  await load('qty-mm', quantityModel('MILLIMETRE', 2000));
  await load('unit-scale', UNIT_SCALE_MILLIMETRE_MODEL);
}, 60_000);

afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe('buildModelFingerprints on an IFC2X3 file', () => {
  it('fingerprints an object class the IFC4 codegen pin does not carry', () => {
    // #4204 taught the parser's EntityTable to derive its IfcRoot set from the
    // schema instead of the IFC4_ADD2_TC1 codegen pin, so IFCMOVE — one of the
    // 23 IFC2X3-only IfcObjectDefinition classes IFC4 dropped — is now
    // recognized as an IfcRoot descendant and keeps its real GlobalId here.
    expect(store('legacy-base').entities.getGlobalId(
      store('legacy-base').entityIndex.byType.get('IFCMOVE')![0],
    )).toBe(guid('OLDM'));

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

  it('keys on an authored Tag under key_from, so re-GUIDed walls match by key (issue #4955)', async () => {
    const byContent = await diff({ a: 'walls', b: 'walls-head', by_content: true });
    expect(byContent.contentDiff?.contentMatchCounts).toEqual({ renamed: 2 });

    const byTag = await diff({ a: 'walls', b: 'walls-head', by_content: true, key_from: 'Tag' });
    const content = byTag.contentDiff as Record<string, unknown> | null;
    if (!content) throw new Error('by_content produced no contentDiff');
    expect(content.keyProperty).toBe('Tag');
    expect(content.duplicateAuthoredKeys).toEqual([]);
    expect(content.contentMatchCounts).toEqual({});
    expect((content.counts as { added: number; deleted: number })).toMatchObject({ added: 0, deleted: 0 });
  });

  it('falls back on both revisions when only the second has a duplicate authored key (#5005 review)', async () => {
    const byTag = await diff({
      a: 'walls',
      b: 'walls-head-twins',
      by_content: true,
      key_from: 'Tag',
    });
    const content = byTag.contentDiff as Record<string, unknown> | null;
    if (!content) throw new Error('by_content produced no contentDiff');

    expect(content.duplicateAuthoredKeys).toEqual(['tagA']);
    const matches = content.contentMatches as Array<{ base: string[]; head: string[] }>;
    const keys = matches.flatMap((match) => [...match.base, ...match.head]);
    expect(keys).toContain(guid('OLDA'));
    expect(keys).not.toContain('prop:tagA');
  });

  it('reads an authored key through the session overlay, and a tombstoned twin no longer contests it', async () => {
    // Both walls carry Tag 'tagA' in this model; a session that deletes one and
    // retags the other must see ONE unique authored key, not a collision.
    await load('walls-twins', model(guid('OLDA'), guid('OLDB')).replace("'tagB'", "'tagA'"));
    const before = buildModelFingerprints(store('walls-twins'), null, { keyProperty: 'Tag' });
    expect(before.filter((f) => f.key.startsWith('prop:'))).toHaveLength(0);

    const overlay = {
      deleted: new Set([71]),
      created: [],
      createdAll: [],
      pendingMutations: 2,
      createdEntity: () => null,
      attributes: (id: number) => new Map(id === 70 ? [['Tag', 'AST-1']] : []),
      attributesByEntity: () => new Map(),
      propertySets: (id: number) => extractPropertiesOnDemand(store('walls-twins'), id),
      quantitySets: (id: number) => extractQuantitiesOnDemand(store('walls-twins'), id),
      queuedRelations: () => [],
    } as unknown as PendingOverlay;
    const duplicateAuthoredKeys = new Map<string, number[]>();
    const after = new Map(
      buildModelFingerprints(store('walls-twins'), overlay, { keyProperty: 'Tag', duplicateAuthoredKeys }).map((f) => [f.ref, f.key]),
    );
    expect(after.get(70)).toBe('prop:AST-1');
    expect(after.has(71)).toBe(false);
    expect(duplicateAuthoredKeys.size).toBe(0);
  });

  it('counts an authored wall in Tag collisions and follows source retypes (#5249)', () => {
    const dataStore = store('walls');
    const view = new MutablePropertyView(dataStore.properties, 'walls');
    const editor = new StoreEditor(dataStore, view);
    const added = editor.addEntity('IfcWall', [
      guid('NEWC'), null, 'New wall', null, null, null, null, 'tagA', null,
    ]);
    const overlay = overlayFromView(view, dataStore);
    const duplicates = new Map<string, number[]>();
    const fingerprints = buildModelFingerprints(dataStore, overlay, {
      keyProperty: 'Tag', duplicateAuthoredKeys: duplicates,
    });
    const keys = new Map(fingerprints.map(f => [f.ref, f.key]));
    expect(keys.get(70)).toBe(guid('OLDA'));
    expect(keys.get(added.expressId)).toBe(guid('NEWC'));
    expect(duplicates.get('tagA')).toEqual([70, added.expressId]);
    const base = buildModelFingerprints(dataStore, null, { keyProperty: 'Tag' });
    fallbackPairDuplicateAuthoredKeys([
      { fingerprints: base, store: dataStore },
      { fingerprints, store: dataStore, overlay },
    ], duplicates);
    expect(base.find(f => f.ref === 70)?.key).toBe(guid('OLDA'));
    expect(fingerprints.find(f => f.ref === added.expressId)?.key).toBe(guid('NEWC'));

    view.setEntityType(70, 'IfcRelAggregates');
    view.setEntityType(80, 'IfcWall');
    view.setAttribute(80, 'GlobalId', guid('REID'));
    const changed = new Map(buildModelFingerprints(dataStore, overlayFromView(view, dataStore), {
      keyProperty: 'Tag', duplicateAuthoredKeys: new Map(),
    }).map(f => [f.ref, f]));
    expect(changed.has(70)).toBe(false);
    expect(changed.get(80)?.ifcType).toBe('IfcWall');
    expect(changed.get(80)?.key).toBe(guid('REID'));
    expect(changed.get(added.expressId)?.key).toBe('prop:tagA');
  });

  it('does not restore a parsed GlobalId after an explicit empty edit (#5249 review)', () => {
    const dataStore = store('walls');
    const view = new MutablePropertyView(dataStore.properties, 'walls');
    expect(dataStore.entities.getGlobalId(70)).toBe(guid('OLDA'));
    view.setAttribute(70, 'GlobalId', '');
    const fingerprints = buildModelFingerprints(dataStore, overlayFromView(view, dataStore), {
      keyProperty: 'Tag', duplicateAuthoredKeys: new Map(),
    });
    expect(fingerprints.some(fingerprint => fingerprint.ref === 70)).toBe(false);
    expect(fingerprints.some(fingerprint => fingerprint.ref === 71)).toBe(true);
  });

  it('reports a created Tag collision through model_diff (#5249)', async () => {
    await load('walls-created-tag', model(guid('OLDA'), guid('OLDB')));
    const create = mutationTools.find(tool => tool.name === 'entity_create');
    if (!create) throw new Error('entity_create not registered');
    const result = await create.handler({
      model_id: 'walls-created-tag', type: 'IfcWall',
      attributes: [guid('NEWC'), null, 'New wall', null, null, null, null, 'tagA', null],
    }, ctx);
    expect(result.isError).toBeUndefined();

    const out = await diff({ a: 'walls', b: 'walls-created-tag', by_content: true, key_from: 'Tag' });
    expect((out.contentDiff as Record<string, unknown>).duplicateAuthoredKeys).toEqual(['tagA']);
    expect(out.contentDiff?.counts).toMatchObject({ added: 1, deleted: 0 });
  });

  it('refuses a malformed key_from', async () => {
    const tool = diffTools.find((t) => t.name === 'model_diff');
    if (!tool) throw new Error('model_diff not registered');
    await expect(
      Promise.resolve().then(() => tool.handler({ a: 'walls', b: 'walls-head', by_content: true, key_from: 'AssetId' }, ctx)),
    ).rejects.toThrow(/key_from/);
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
  it.each(['legacy-base', 'sched', 'walls', 'type-tags', 'rail-types', 'qty-mm', 'unit-scale'])(
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
