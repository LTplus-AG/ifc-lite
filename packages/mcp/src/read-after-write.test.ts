/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Edit, then read back — the loop #2004 was about.
 *
 * `MutablePropertyView` is an overlay; the parsed store's buffer and index are
 * never touched and the edits only materialise in `StepExporter`. Every read
 * that went to the store therefore answered about the file *as parsed*, so an
 * agent that edited and then read back to confirm was told its edit had not
 * happened — and the natural recovery from that is to edit again.
 *
 * Every test drives the real mutation tool and then the real read tool, in the
 * order an agent performs them. The reads fold; the payload says how many edits
 * are queued, so the agent can still tell "in the session" from "on disk".
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CallToolResult } from './protocol/index.js';
import type { ToolContext } from './context.js';
import { DEFAULT_CONFIG, InMemoryModelRegistry, NOOP_PROGRESS, SILENT_LOGGER } from './context.js';
import { fullScope } from './auth/scope.js';
import { loadIfcModel } from './loader.js';
import { discoveryTools } from './tools/discovery.js';
import { queryTools } from './tools/query.js';
import { mutationTools } from './tools/mutate.js';
import { validationTools } from './tools/validation.js';
import { findByGlobalId, resolveGlobalIds } from './tools/util.js';
import { buildDefaultResourceRegistry } from './resources/index.js';
import { diffTools } from './tools/diff.js';

/** A 22-character IFC GlobalId from a short mnemonic. */
function guid(mnemonic: string): string {
  return (mnemonic + '0'.repeat(22)).slice(0, 22);
}

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
#42= IFCBUILDING('${guid('BLDG')}',$,'B',$,$,#40,$,$,.ELEMENT.,$,$,$);
#43= IFCRELAGGREGATES('${guid('AGG1')}',$,$,$,#1,(#42));
#44= IFCRELAGGREGATES('${guid('AGG2')}',$,$,$,#42,(#41));
#45= IFCRELCONTAINEDINSPATIALSTRUCTURE('${guid('RELC')}',$,$,$,(#72),#41);
#72= IFCWALL('${guid('WALA')}',$,'Wall A',$,$,#40,$,'tagA',$);
#73= IFCWALL('${guid('WALB')}',$,'Wall B',$,$,#40,$,'tagB',$);
#81= IFCPROPERTYSET('${guid('PSET')}',$,'Pset_WallCommon',$,(#82,#83));
#82= IFCPROPERTYSINGLEVALUE('IsExternal',$,IFCBOOLEAN(.T.),$);
#83= IFCPROPERTYSINGLEVALUE('LoadBearing',$,IFCBOOLEAN(.F.),$);
#84= IFCRELDEFINESBYPROPERTIES('${guid('RELA')}',$,$,$,(#72),#81);
ENDSEC;
END-ISO-10303-21;
`;

interface EntityShape {
  globalId: string;
  name: string;
  type: string;
  attributes?: Array<{ name: string; value: string | number | boolean }>;
  properties?: Array<{ name: string; properties: Array<{ name: string; value: unknown }> }>;
  pendingMutations?: number;
}

interface QueryShape {
  count: number;
  entities: Array<{ expressId: number; globalId: string; name: string; type: string }>;
  pendingMutations?: number;
}

interface InfoShape {
  entityCount: number;
  typeCountsTop20: Array<{ type: string; count: number }>;
  pendingMutations?: number;
}

interface AuditShape {
  issues: Array<{ rule: string; message: string }>;
  scores: { structure: number; identity: number; dataQuality: number };
  totals: { products: number; unnamed: number; duplicateGlobalIds: number };
  pendingMutations?: number;
}

interface SpatialNode {
  expressId: number;
  globalId: string;
  type: string;
  name: string;
  elements?: number[];
  children: SpatialNode[];
}

/** First node in the tree matching `pred`, or null. */
function findNode(node: SpatialNode | null, pred: (n: SpatialNode) => boolean): SpatialNode | null {
  if (!node) return null;
  if (pred(node)) return node;
  for (const child of node.children) {
    const hit = findNode(child, pred);
    if (hit) return hit;
  }
  return null;
}

interface CountShape {
  total?: number;
  groups?: Array<{ key: string; count: number }>;
  pendingMutations?: number;
}

let tmp: string;
let ctx: ToolContext;

const ALL_TOOLS = [...discoveryTools, ...queryTools, ...mutationTools, ...validationTools, ...diffTools];

function tool(name: string) {
  const found = ALL_TOOLS.find((t) => t.name === name);
  if (!found) throw new Error(`${name} not registered`);
  return found;
}

async function call(name: string, input: Record<string, unknown>): Promise<CallToolResult> {
  const result = await tool(name).handler(input, ctx);
  expect(result.isError, `${name}: ${JSON.stringify(result.structuredContent)}`).toBeUndefined();
  return result;
}

async function structured<T>(name: string, input: Record<string, unknown>): Promise<T> {
  return (await call(name, input)).structuredContent as unknown as T;
}

/** One fresh session per test — a mutation overlay lives for the life of the
 *  session model, so tests must not share one. */
async function session(): Promise<void> {
  ctx = {
    registry: new InMemoryModelRegistry(),
    scope: fullScope(),
    progress: NOOP_PROGRESS,
    log: SILENT_LOGGER,
    signal: new AbortController().signal,
    config: { ...DEFAULT_CONFIG, allowedPaths: [tmp] },
  };
  ctx.registry.add(await loadIfcModel(join(tmp, 'm.ifc'), { modelId: 'm' }));
}

function propertyValue(entity: EntityShape, pset: string, name: string): unknown {
  return entity.properties?.find((p) => p.name === pset)?.properties.find((p) => p.name === name)?.value;
}

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'ifc-lite-mcp-read-after-write-'));
  await writeFile(join(tmp, 'm.ifc'), MODEL, 'utf-8');
});

afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe('an unedited session', () => {
  it('answers exactly as the file was parsed, and says nothing about mutations', async () => {
    await session();
    const entity = await structured<EntityShape>('get_entity', { global_id: guid('WALA') });
    expect(entity.name).toBe('Wall A');
    // Absent rather than zeroed: a read of an untouched model should not grow a
    // mutation vocabulary it has no use for.
    expect(entity).not.toHaveProperty('pendingMutations');

    const info = await structured<InfoShape>('model_info', {});
    expect(info.entityCount).toBe(18);
    expect(info).not.toHaveProperty('pendingMutations');

    const walls = await structured<QueryShape>('query_entities', { type: 'IfcWall' });
    expect(walls.count).toBe(2);
    expect(walls).not.toHaveProperty('pendingMutations');
  }, 30_000);
});

describe('get_entity after an edit', () => {
  it('returns the name that was just written, not the parsed one', async () => {
    await session();
    await call('entity_set_attribute', {
      global_id: guid('WALA'), attribute: 'Name', value: 'Wall A renamed',
    });

    const entity = await structured<EntityShape>('get_entity', { global_id: guid('WALA') });
    expect(entity.name).toBe('Wall A renamed');
    expect(entity.pendingMutations).toBe(1);
    // The named-attribute list has to move with the header, or `get_entity`
    // contradicts itself inside one payload.
    expect(entity.attributes?.find((a) => a.name === 'Name')?.value).toBe('Wall A renamed');
  }, 30_000);

  it('returns the property value that was just written, siblings intact', async () => {
    await session();
    await call('entity_set_property', {
      global_id: guid('WALA'), pset: 'Pset_WallCommon', name: 'IsExternal', value: false,
    });

    const entity = await structured<EntityShape>('get_entity', {
      global_id: guid('WALA'), include: ['properties'],
    });
    expect(propertyValue(entity, 'Pset_WallCommon', 'IsExternal')).toBe(false);
    // The overlay's base for a property read is the parser's on-demand
    // extraction, not `store.properties` (which the columnar parser leaves
    // empty). Without that wiring the edited wall would appear to have lost
    // LoadBearing.
    expect(propertyValue(entity, 'Pset_WallCommon', 'LoadBearing')).toBe(false);
    expect(entity.properties?.find((p) => p.name === 'Pset_WallCommon')?.properties).toHaveLength(2);
  }, 30_000);

  it('reports a deleted entity as gone rather than as present', async () => {
    await session();
    await call('entity_delete', { global_id: guid('WALB') });

    await expect(async () => tool('get_entity').handler({ global_id: guid('WALB') }, ctx))
      .rejects.toThrow(/No entity with GlobalId/);
  }, 30_000);

  it('finds a created entity by the GlobalId that was just written', async () => {
    await session();
    await call('entity_create', {
      type: 'IfcWall',
      attributes: [`'${guid('WALC')}'`, null, "'Wall C'", null, null, '#40', null, "'tagC'", null],
    });

    const entity = await structured<EntityShape>('get_entity', {
      global_id: guid('WALC'), include: ['attributes'],
    });
    expect(entity.type).toBe('IfcWall');
    expect(entity.name).toBe('Wall C');
    // Not in the store, so the attribute list is the authored positional payload
    // named from the schema. An empty list would be another way of saying the
    // entity is not really there.
    expect(entity.attributes?.find((a) => a.name === 'GlobalId')?.value).toBe(guid('WALC'));
    expect(entity.attributes?.find((a) => a.name === 'Tag')?.value).toBe('tagC');
  }, 30_000);
});

describe('query_entities after an edit', () => {
  it('matches a property filter against the value that was just written', async () => {
    await session();
    // Parsed value is IsExternal = true; a query for false must find nothing …
    const before = await structured<QueryShape>('query_entities', {
      type: 'IfcWall', property: { pset: 'Pset_WallCommon', name: 'IsExternal', op: '=', value: false },
    });
    expect(before.count).toBe(0);

    await call('entity_set_property', {
      global_id: guid('WALA'), pset: 'Pset_WallCommon', name: 'IsExternal', value: false,
    });

    // … and after the write, the same query must find the wall. This is the case
    // that rules out reporting the divergence instead of folding: a tool that
    // only said "1 mutation pending" would still hand back the empty row set.
    const after = await structured<QueryShape>('query_entities', {
      type: 'IfcWall', property: { pset: 'Pset_WallCommon', name: 'IsExternal', op: '=', value: false },
    });
    expect(after.count).toBe(1);
    expect(after.entities[0].globalId).toBe(guid('WALA'));
    expect(after.pendingMutations).toBe(1);

    const stillTrue = await structured<QueryShape>('query_entities', {
      type: 'IfcWall', property: { pset: 'Pset_WallCommon', name: 'IsExternal', op: '=', value: true },
    });
    expect(stillTrue.count).toBe(0);
  }, 30_000);

  it('returns created entities and drops deleted ones', async () => {
    await session();
    await call('entity_create', {
      type: 'IfcWall',
      attributes: [`'${guid('WALC')}'`, null, "'Wall C'", null, null, '#40', null, "'tagC'", null],
    });
    await call('entity_delete', { global_id: guid('WALB') });

    const walls = await structured<QueryShape>('query_entities', { type: 'IfcWall' });
    expect(walls.count).toBe(2);
    expect(walls.entities.map((e) => e.globalId).sort()).toEqual([guid('WALA'), guid('WALC')].sort());
    expect(walls.pendingMutations).toBe(2);
  }, 30_000);

  it('reports a renamed entity under its new name', async () => {
    await session();
    await call('entity_set_attribute', {
      global_id: guid('WALA'), attribute: 'Name', value: 'Wall A renamed',
    });
    const walls = await structured<QueryShape>('query_entities', { type: 'IfcWall' });
    expect(walls.entities.find((e) => e.globalId === guid('WALA'))?.name).toBe('Wall A renamed');
  }, 30_000);
});

describe('model_info and count_entities after an edit', () => {
  it('counts a created entity in and a deleted one out', async () => {
    await session();
    const before = await structured<InfoShape>('model_info', {});
    expect(before.entityCount).toBe(18);

    await call('entity_create', {
      type: 'IfcWall',
      attributes: [`'${guid('WALC')}'`, null, "'Wall C'", null, null, '#40', null, "'tagC'", null],
    });
    await call('entity_delete', { global_id: guid('STOR') });

    const after = await structured<InfoShape>('model_info', {});
    expect(after.entityCount).toBe(18);
    expect(after.pendingMutations).toBe(2);
    // The created wall lands on the existing IFCWALL row rather than opening a
    // second one, and the tombstoned storey leaves its row entirely.
    const counts = new Map(after.typeCountsTop20.map((t) => [t.type, t.count]));
    expect(counts.get('IfcWall')).toBe(3);
    expect(counts.get('IfcBuildingStorey')).toBe(0);
  }, 30_000);

  it('narrows count_entities group_by type to the requested type and its subtypes', async () => {
    await session();
    const filtered = await structured<CountShape>('count_entities', {
      type: 'IfcWall', group_by: 'type',
    });
    // `type` used to be ignored on this branch, so it answered with every type
    // in the model. And the filter has to expand subtypes the way `byType` does.
    expect(filtered.groups?.map((g) => g.key)).toEqual(['IfcWall']);
    expect(filtered.groups?.[0].count).toBe(2);
    const all = await structured<CountShape>('count_entities', { group_by: 'type' });
    expect((all.groups?.length ?? 0)).toBeGreaterThan(1);

    // …and the filter expands subtypes, as `byType('IfcWall')` does. Asking for
    // the parent and being told only about the parent's own rows is the same
    // wrong answer in a different place.
    await call('entity_create', {
      type: 'IfcWallStandardCase',
      attributes: [`'${guid('WSTD')}'`, null, "'Standard'", null, null, '#40', null, "'tagS'", null],
    });
    const expanded = await structured<CountShape>('count_entities', {
      type: 'IfcWall', group_by: 'type',
    });
    expect(new Map(expanded.groups?.map((g) => [g.key, g.count]))).toEqual(
      new Map([['IfcWall', 2], ['IfcWallStandardCase', 1]]),
    );
  }, 30_000);

  it('names only attributes the schema knows, never a synthetic slot', async () => {
    await session();
    // One attribute past the end of IfcWall's 9.
    const created = await structured<{ expressId: number }>('entity_create', {
      type: 'IfcWall',
      attributes: [`'${guid('WALC')}'`, null, "'Wall C'", null, null, '#40', null, "'tagC'", null, "'overflow'"],
    });
    const read = await structured<EntityShape>('get_entity', {
      express_id: created.expressId, include: ['attributes'],
    });
    for (const attr of read.attributes ?? []) expect(attr.name).not.toMatch(/^Attribute\d+$/);
    expect(read.attributes?.map((a) => a.value)).not.toContain('overflow');
  }, 30_000);

  it('applies the same fold to count_entities', async () => {
    await session();
    await call('entity_create', {
      type: 'IfcWall',
      attributes: [`'${guid('WALC')}'`, null, "'Wall C'", null, null, '#40', null, "'tagC'", null],
    });

    const total = await structured<CountShape>('count_entities', {});
    expect(total.total).toBe(19);
    expect(total.pendingMutations).toBe(1);

    const byType = await structured<CountShape>('count_entities', { group_by: 'type' });
    expect(byType.groups?.find((g) => g.key === 'IfcWall')?.count).toBe(3);
  }, 30_000);
});

describe('mutation_undo', () => {
  it('reverts the value a read-back sees, not just the history count', async () => {
    await session();
    await call('entity_set_attribute', {
      global_id: guid('WALA'), attribute: 'Name', value: 'Wall A renamed',
    });
    const edited = await structured<EntityShape>('get_entity', { global_id: guid('WALA') });
    expect(edited.name).toBe('Wall A renamed');

    const undone = await structured<{ undone: number }>('mutation_undo', { n: 1 });
    expect(undone.undone).toBe(1);

    // The tool reported the mutation undone; a caller relying on that has to
    // see the overlay actually revert, not just a shorter history list.
    const restored = await structured<EntityShape>('get_entity', { global_id: guid('WALA') });
    expect(restored.name).toBe('Wall A');
  }, 30_000);

  it('reverts an UPDATE_PROPERTY edit to the value it overwrote', async () => {
    await session();
    await call('entity_set_property', {
      global_id: guid('WALA'), pset: 'Pset_WallCommon', name: 'IsExternal', value: false,
    });
    await call('mutation_undo', { n: 1 });
    const entity = await structured<EntityShape>('get_entity', {
      global_id: guid('WALA'), include: ['properties'],
    });
    expect(propertyValue(entity, 'Pset_WallCommon', 'IsExternal')).toBe(true);
  }, 30_000);

  it('reverts a brand-new property (CREATE_PROPERTY) by removing it, not blanking it', async () => {
    await session();
    await call('entity_set_property', {
      global_id: guid('WALA'), pset: 'Pset_Custom', name: 'Rating', value: 'A',
    });
    let entity = await structured<EntityShape>('get_entity', {
      global_id: guid('WALA'), include: ['properties'],
    });
    expect(propertyValue(entity, 'Pset_Custom', 'Rating')).toBe('A');

    await call('mutation_undo', { n: 1 });
    entity = await structured<EntityShape>('get_entity', {
      global_id: guid('WALA'), include: ['properties'],
    });
    expect(entity.properties?.find((p) => p.name === 'Pset_Custom')).toBeUndefined();
  }, 30_000);

  it('reverts a CREATE_ENTITY by making the entity unreachable again', async () => {
    await session();
    const created = await structured<{ expressId: number }>('entity_create', {
      type: 'IfcWall',
      attributes: [`'${guid('WALD')}'`, null, "'Wall D'"],
    });
    await call('mutation_undo', { n: 1 });
    await expect(async () => tool('get_entity').handler({ express_id: created.expressId }, ctx))
      .rejects.toThrow();
  }, 30_000);

  it('reverts a DELETE_ENTITY by making the base entity reachable again', async () => {
    await session();
    await call('entity_delete', { global_id: guid('WALB') });
    await expect(async () => tool('get_entity').handler({ global_id: guid('WALB') }, ctx))
      .rejects.toThrow();

    await call('mutation_undo', { n: 1 });
    const restored = await structured<EntityShape>('get_entity', { global_id: guid('WALB') });
    expect(restored.name).toBe('Wall B');
  }, 30_000);

  it('undoes N mutations most-recent-first, unwinding a double edit to the original value', async () => {
    await session();
    await call('entity_set_attribute', { global_id: guid('WALA'), attribute: 'Name', value: 'First edit' });
    await call('entity_set_attribute', { global_id: guid('WALA'), attribute: 'Name', value: 'Second edit' });

    const undone = await structured<{ undone: number }>('mutation_undo', { n: 2 });
    expect(undone.undone).toBe(2);

    const restored = await structured<EntityShape>('get_entity', { global_id: guid('WALA') });
    expect(restored.name).toBe('Wall A');
  }, 30_000);
});

describe('addressing a created entity in the same session', () => {
  it('lets a batch create an entity and then set a property on it by GlobalId', async () => {
    await session();
    const batch = await structured<{ results: Array<{ ok: boolean; error?: string }> }>('mutation_batch', {
      operations: [
        {
          tool: 'entity_create',
          args: { type: 'IfcWall', attributes: [`'${guid('WALC')}'`, null, "'Wall C'", null, null, '#40', null, "'tagC'", null] },
        },
        {
          tool: 'entity_set_property',
          args: { global_id: guid('WALC'), pset: 'Pset_WallCommon', name: 'IsExternal', value: true },
        },
      ],
    });
    expect(batch.results.map((r) => r.ok)).toEqual([true, true]);

    const entity = await structured<EntityShape>('get_entity', {
      global_id: guid('WALC'), include: ['properties'],
    });
    expect(propertyValue(entity, 'Pset_WallCommon', 'IsExternal')).toBe(true);
  }, 30_000);
});

/**
 * The fold has to cover every path, because a fold that covers some of them
 * makes two answers from the same server disagree — which is worse than the
 * staleness it replaced (#2014). Each test below pins one pair of paths that
 * used to contradict each other.
 */
describe('one answer per question', () => {
  it('lists a created entity that has no GlobalId, because it counts it', async () => {
    await session();
    // `entity_create` takes `attributes` optionally, and an agent building
    // geometry creates plenty of entities that carry no GlobalId at all.
    const created = await structured<{ expressId: number }>('entity_create', { type: 'IfcWall' });

    const walls = await structured<QueryShape>('query_entities', { type: 'IfcWall' });
    const counted = await structured<CountShape>('count_entities', { group_by: 'type' });
    const info = await structured<InfoShape>('model_info', {});

    // PascalCase, as `model_diff` reports type names and as `count_entities`
    // and `model_info` now both do.
    const countedWalls = counted.groups?.find((g) => g.key === 'IfcWall')?.count;
    expect(countedWalls).toBe(3);
    expect(info.typeCountsTop20.find((t) => t.type === 'IfcWall')?.count).toBe(3);
    // The query has to agree with both, or the server contradicts itself about
    // what exists.
    expect(walls.count).toBe(3);
    expect(walls.entities.map((e) => e.expressId)).toContain(created.expressId);
  }, 30_000);

  it('gives every row an expressId, the only handle a GlobalId-less row has', async () => {
    await session();
    await call('entity_create', { type: 'IfcWall' });
    // `fields` spelled out, because that is the branch the server reaches: the
    // input schema defaults it to globalId/type/name and `validateInput` fills
    // it in before dispatch. Calling the handler bare leaves it undefined and
    // takes the full-shape branch instead, which would make this test pass
    // without exercising anything.
    const walls = await structured<QueryShape>('query_entities', {
      type: 'IfcWall', fields: ['globalId', 'type', 'name'],
    });
    expect(walls.entities.length).toBe(3);
    for (const entity of walls.entities) expect(typeof entity.expressId).toBe('number');
    // Without it, the queued wall is three empty strings and unaddressable.
    const anonymous = walls.entities.find((e) => e.globalId === '');
    expect(anonymous).toBeDefined();
    expect(typeof anonymous?.expressId).toBe('number');
  }, 30_000);

  it('reports the same entity count from model_info and model_list', async () => {
    await session();
    await call('entity_create', { type: 'IfcWall', attributes: [`'${guid('WALC')}'`] });

    const info = await structured<InfoShape>('model_info', {});
    const list = await structured<{ models: Array<{ entityCount: number; pendingMutations?: number }> }>('model_list', {});
    expect(list.models[0].entityCount).toBe(info.entityCount);
    expect(list.models[0].pendingMutations).toBe(1);
  }, 30_000);

  it('reads back every attribute the write tool accepts, Tag included', async () => {
    await session();
    // `entity_set_attribute`'s enum is Name|Description|ObjectType|Tag. The
    // projection used to carry three of the four.
    await call('entity_set_attribute', { global_id: guid('WALA'), attribute: 'Tag', value: 'tagA-edited' });

    const entity = await structured<EntityShape>('get_entity', {
      global_id: guid('WALA'), include: ['attributes'],
    });
    expect(entity.attributes?.find((a) => a.name === 'Tag')?.value).toBe('tagA-edited');
  }, 30_000);

  it('reads back an attribute that was unset in the file', async () => {
    await session();
    // Wall A's Description is `$`, so the base attribute list omits it entirely.
    // Overwriting in place could never surface it, and the top-level field moved
    // while the array denied it — one payload disagreeing with itself.
    await call('entity_set_attribute', { global_id: guid('WALA'), attribute: 'Description', value: 'now set' });

    const entity = await structured<EntityShape>('get_entity', {
      global_id: guid('WALA'), include: ['attributes'],
    });
    expect(entity.attributes?.find((a) => a.name === 'Description')?.value).toBe('now set');
  }, 30_000);

  it('reports a created entity\'s authored references, not just its text', async () => {
    await session();
    const created = await structured<{ expressId: number }>('entity_create', {
      type: 'IfcWall',
      attributes: [`'${guid('WALC')}'`, null, "'Wall C'", null, null, '#40', null, "'tagC'", null],
    });

    const entity = await structured<EntityShape>('get_entity', {
      express_id: created.expressId, include: ['attributes'],
    });
    // `ObjectPlacement` is a reference, and a reference is the value of a
    // structural attribute — dropping it hid every one of them.
    expect(entity.attributes?.find((a) => a.name === 'ObjectPlacement')?.value).toBe('#40');
    expect(entity.attributes?.find((a) => a.name === 'Tag')?.value).toBe('tagC');
  }, 30_000);
});

describe('one GlobalId resolves to one entity, whichever tool asks', () => {
  /** Queue a second wall carrying a GlobalId the file already uses. */
  async function createDuplicate(): Promise<number> {
    const created = await structured<{ expressId: number }>('entity_create', {
      type: 'IfcWall',
      attributes: [`'${guid('WALA')}'`, null, "'Queued twin'", null, null, '#40', null, "'tagDup'", null],
    });
    return created.expressId;
  }

  it('gives get_entity and get_entities_bulk the same answer for a duplicated id', async () => {
    await session();
    const twin = await createDuplicate();

    const single = await structured<EntityShape>('get_entity', { global_id: guid('WALA') });
    const bulk = await structured<{ entities: Record<string, EntityShape & { ref: { expressId: number } }> }>(
      'get_entities_bulk', { global_ids: [guid('WALA')] },
    );

    // Bulk keyed by GlobalId and let the last row it happened to visit win,
    // which was the parsed store's — so reading one entity and reading a
    // hundred disagreed about the same entity.
    expect(single.name).toBe('Queued twin');
    expect(bulk.entities[guid('WALA')].name).toBe('Queued twin');
    expect(bulk.entities[guid('WALA')].ref.expressId).toBe(twin);
    expect(single.name).toBe(bulk.entities[guid('WALA')].name);
  }, 30_000);

  it('says so rather than silently returning one of the two', async () => {
    await session();
    const twin = await createDuplicate();
    const bulk = await structured<{
      entities: Record<string, unknown>;
      ambiguousGlobalIds?: Array<{ globalId: string; expressIds: number[]; returned: number }>;
    }>('get_entities_bulk', { global_ids: [guid('WALA')] });

    expect(bulk.ambiguousGlobalIds).toEqual([
      { globalId: guid('WALA'), expressIds: [twin, 72], returned: twin },
    ]);
  }, 30_000);

  it('keeps the field absent when every requested id names one entity', async () => {
    await session();
    const bulk = await structured<Record<string, unknown>>('get_entities_bulk', {
      global_ids: [guid('WALA'), guid('WALB')],
    });
    expect(bulk).not.toHaveProperty('ambiguousGlobalIds');
    expect(Object.keys(bulk.entities as Record<string, unknown>).sort()).toEqual([guid('WALA'), guid('WALB')].sort());
  }, 30_000);

  it('reports the express id a GlobalId key displaced', async () => {
    await session();
    const twin = await createDuplicate();
    // #72 is the file's Wall A; the caller named it explicitly *and* asked for
    // the GlobalId both entities carry. The key belongs to what the GlobalId
    // resolves to, and the displaced entity is named rather than dropped.
    const bulk = await structured<{
      entities: Record<string, { ref: { expressId: number } }>;
      ambiguousGlobalIds?: Array<{ globalId: string; expressIds: number[]; returned: number }>;
    }>('get_entities_bulk', { global_ids: [guid('WALA')], express_ids: [72] });

    expect(bulk.entities[guid('WALA')].ref.expressId).toBe(twin);
    expect(bulk.ambiguousGlobalIds?.[0]).toMatchObject({ globalId: guid('WALA'), returned: twin });
    expect(bulk.ambiguousGlobalIds?.[0].expressIds).toContain(72);
  }, 30_000);

  it('stops calling a GlobalId ambiguous once one of its carriers is deleted', async () => {
    await session();
    const twin = await createDuplicate();
    // Two live carriers, so the key is genuinely ambiguous …
    const before = await structured<{ ambiguousGlobalIds?: unknown[] }>('get_entities_bulk', {
      global_ids: [guid('WALA')],
    });
    expect(before.ambiguousGlobalIds).toHaveLength(1);

    // … and after deleting the file's Wall A it is not. `bim.entity` returning
    // null for a tombstone cannot cover this: the ambiguity list is built from
    // the carrier scan, not from an entity lookup per carrier, so without the
    // tombstone check it would report a duplicate that no longer exists and
    // name a deleted expressId to the caller.
    await call('entity_delete', { express_id: 72 });
    const after = await structured<{
      entities: Record<string, { ref: { expressId: number } }>;
      ambiguousGlobalIds?: unknown[];
    }>('get_entities_bulk', { global_ids: [guid('WALA')] });
    expect(after).not.toHaveProperty('ambiguousGlobalIds');
    expect(after.entities[guid('WALA')].ref.expressId).toBe(twin);
  }, 30_000);

  it('never returns a deleted entity in bulk, as get_entity never does', async () => {
    await session();
    await call('entity_delete', { global_id: guid('WALB') });
    const bulk = await structured<{ entities: Record<string, unknown> }>('get_entities_bulk', {
      global_ids: [guid('WALA'), guid('WALB')],
    });
    expect(Object.keys(bulk.entities)).toEqual([guid('WALA')]);
  }, 30_000);

  it('resolves the same winner through findByGlobalId and resolveGlobalIds', async () => {
    await session();
    const twin = await createDuplicate();
    const model = ctx.registry.get('m');
    if (!model) throw new Error('model not loaded');
    // The two share a documented precedence but not an implementation —
    // `findByGlobalId` early-exits for the single-lookup path. This is what
    // stops them drifting apart.
    for (const gid of [guid('WALA'), guid('WALB'), guid('STOR'), 'no-such-globalid']) {
      expect(findByGlobalId(model, gid), gid).toBe(resolveGlobalIds(model, [gid]).get(gid)?.[0] ?? null);
    }
    expect(resolveGlobalIds(model, [guid('WALA')]).get(guid('WALA'))).toEqual([twin, 72]);
  }, 30_000);
});

describe('created attributes are named in the model\'s schema', () => {
  it('uses the IFC2X3 spelling for a class IFC4 renamed a slot on', async () => {
    // `IfcRelCoversSpaces` slot 4 is `RelatedSpace` in IFC2X3 and
    // `RelatingSpace` in IFC4. Naming a created one from the IFC4 pin reported
    // an attribute name the IFC2X3 file will never serialise.
    const dir = await mkdtemp(join(tmpdir(), 'ifc-lite-mcp-2x3-'));
    try {
      await writeFile(join(dir, 'm.ifc'), MODEL.replace("FILE_SCHEMA(('IFC4'))", "FILE_SCHEMA(('IFC2X3'))"), 'utf-8');
      ctx = {
        registry: new InMemoryModelRegistry(),
        scope: fullScope(),
        progress: NOOP_PROGRESS,
        log: SILENT_LOGGER,
        signal: new AbortController().signal,
        config: { ...DEFAULT_CONFIG, allowedPaths: [dir] },
      };
      ctx.registry.add(await loadIfcModel(join(dir, 'm.ifc'), { modelId: 'm' }));
      expect(ctx.registry.get('m')?.store.schemaVersion).toBe('IFC2X3');

      const created = await structured<{ expressId: number }>('entity_create', {
        type: 'IfcRelCoversSpaces',
        attributes: [`'${guid('COVR')}'`, null, null, null, '#41', ['#72']],
      });
      const read = await structured<EntityShape>('get_entity', {
        express_id: created.expressId, include: ['attributes'],
      });
      const names = read.attributes?.map((a) => a.name) ?? [];
      expect(names).toContain('RelatedSpace');
      expect(names).not.toContain('RelatingSpace');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 30_000);
});

describe('the positional header read is gated on IfcRoot', () => {
  it('does not turn a property value\'s Name into a GlobalId', async () => {
    await session();
    // Slot 0 of an IfcPropertySingleValue is its Name, not a GlobalId. Reading
    // it positionally put 'Width' into the identity space every tool shares.
    const created = await structured<{ expressId: number }>('entity_create', {
      type: 'IfcPropertySingleValue',
      attributes: ["'Width'", null, ['IFCLENGTHMEASURE', 200], null],
    });

    await expect(async () => tool('get_entity').handler({ global_id: 'Width' }, ctx))
      .rejects.toThrow(/No entity with GlobalId/);
    const bulk = await structured<{ entities: Record<string, unknown> }>('get_entities_bulk', {
      global_ids: ['Width'],
    });
    expect(bulk.entities).toEqual({});

    // It is still a real entity of the session: counted, and readable by id.
    const info = await structured<InfoShape>('model_info', {});
    // Two in the file plus the one just created.
    expect(info.typeCountsTop20.find((t) => t.type === 'IfcPropertySingleValue')?.count).toBe(3);
    const read = await structured<EntityShape>('get_entity', {
      express_id: created.expressId, include: ['attributes'],
    });
    expect(read.globalId).toBe('');
    // …and its authored Name is still reported under its real attribute name.
    expect(read.attributes?.find((a) => a.name === 'Name')?.value).toBe('Width');
  }, 30_000);

  it('still reads the header of a created IfcRoot subtype', async () => {
    await session();
    await call('entity_create', {
      type: 'IfcWall',
      attributes: [`'${guid('WALC')}'`, null, "'Wall C'", null, null, '#40', null, "'tagC'", null],
    });
    const wall = await structured<EntityShape>('get_entity', { global_id: guid('WALC') });
    expect(wall.name).toBe('Wall C');
  }, 30_000);

  it('keeps a non-IfcRoot creation out of model_diff\'s identity pass', async () => {
    await session();
    await call('entity_create', {
      type: 'IfcPropertySingleValue',
      attributes: ["'Width'", null, ['IFCLENGTHMEASURE', 200], null],
    });
    // `model_diff` compares GlobalIds; 'Width' must not appear as an addition.
    ctx.registry.add(await loadIfcModel(join(tmp, 'm.ifc'), { modelId: 'base' }));
    const out = await structured<{ entityDiff: { added: string[] } }>('model_diff', {
      a: 'base', b: 'm',
    });
    expect(out.entityDiff.added).toEqual([]);
  }, 30_000);
});

describe('spatial tree traversal', () => {
  it('terminates on a cyclic aggregation instead of recursing forever', async () => {
    await session();
    // Aggregate the building under the storey, which is already aggregated under
    // the building — a cycle the file cannot express but a session can queue.
    await call('entity_create', {
      type: 'IfcRelAggregates',
      attributes: [`'${guid('CYCL')}'`, null, null, null, '#41', ['#42']],
    });
    const out = await structured<{ tree: SpatialNode }>('spatial_hierarchy', {});
    // Building → storey → (building already placed, so the walk stops).
    const storey = findNode(out.tree, (n) => n.type === 'IfcBuildingStorey');
    expect(storey).not.toBeNull();
    expect(storey?.children).toEqual([]);
  }, 30_000);

  it('keeps contained elements out of children and in elements', async () => {
    await session();
    const out = await structured<{ tree: SpatialNode }>('spatial_hierarchy', { include_elements: true });
    const storey = findNode(out.tree, (n) => n.type === 'IfcBuildingStorey');
    // Wall A is contained in the storey, not aggregated under it: it belongs in
    // `elements` and nowhere else. It used to be in both.
    expect(storey?.elements).toContain(72);
    expect(storey?.children.map((c) => c.expressId)).not.toContain(72);
  }, 30_000);

  it('gives the tool and the resource the same tree', async () => {
    await session();
    await call('entity_delete', { global_id: guid('STOR') });
    const fromTool = await structured<{ tree: SpatialNode }>('spatial_hierarchy', {});
    // The resource used to run its own walk with its own root rule.
    const uri = 'ifc-lite://model/m/spatial-tree';
    const provider = buildDefaultResourceRegistry().matchProvider(uri);
    if (!provider) throw new Error('spatial-tree resource not registered');
    const contents = await provider.read(uri, ctx);
    const fromResource = JSON.parse((contents[0] as { text: string }).text);
    expect(fromResource).toEqual(fromTool.tree);
  }, 30_000);
});

describe('a deleted entity answers nothing about itself', () => {
  it('returns no attributes, properties, quantities or relationships', async () => {
    await session();
    await call('entity_set_property', {
      global_id: guid('WALA'), pset: 'Pset_WallCommon', name: 'IsExternal', value: false,
    });
    await call('entity_delete', { global_id: guid('WALA') });
    const model = ctx.registry.get('m');
    if (!model) throw new Error('model not loaded');
    const ref = { modelId: 'm', expressId: 72 };
    // `entityData` already answered null; these three kept answering, so a
    // deleted entity was still describing itself.
    expect(model.bim.attributes(ref)).toEqual([]);
    expect(model.bim.properties(ref)).toEqual([]);
    expect(model.bim.quantities(ref)).toEqual([]);
    expect(model.bim.related(ref, 'IfcRelContainedInSpatialStructure', 'inverse')).toEqual([]);
  }, 30_000);
});

describe('containment over queued relationships', () => {
  /** Create a wall and place it in the file's storey, the only way an agent can. */
  async function createPlacedWall(): Promise<number> {
    const created = await structured<{ expressId: number }>('entity_create', {
      type: 'IfcWall',
      attributes: [`'${guid('WALC')}'`, null, "'Wall C'", null, null, '#40', null, "'tagC'", null],
    });
    await call('entity_create', {
      type: 'IfcRelContainedInSpatialStructure',
      attributes: [`'${guid('RELZ')}'`, null, null, null, [`#${created.expressId}`], '#41'],
    });
    return created.expressId;
  }

  it('keeps a session-placed entity in an in_storey query', async () => {
    await session();
    const wallC = await createPlacedWall();

    const all = await structured<QueryShape>('query_entities', { type: 'IfcWall' });
    const inStorey = await structured<QueryShape>('query_entities', {
      type: 'IfcWall', in_storey: guid('STOR'),
    });
    // Returning an entity without the filter and dropping it with one reads as
    // a wrong storey rather than as a missing fold, which is why this is worse
    // than either behaviour alone.
    expect(all.entities.map((e) => e.expressId)).toContain(wallC);
    expect(inStorey.entities.map((e) => e.expressId)).toContain(wallC);
    expect(inStorey.count).toBe(2);
  }, 30_000);

  it('groups it under that storey rather than under (none)', async () => {
    await session();
    await createPlacedWall();
    const grouped = await structured<CountShape>('count_entities', { type: 'IfcWall', group_by: 'storey' });
    // Wall A comes from the file's own containment, Wall C from the queued one.
    expect(grouped.groups?.find((g) => g.key === 'L01')?.count).toBe(2);
    // Wall B is in the file and in no storey, so it stays the only '(none)' —
    // which is what shows the created wall left that bucket rather than the
    // bucket disappearing.
    expect(grouped.groups?.find((g) => g.key === '(none)')?.count).toBe(1);
  }, 30_000);

  it('walks the whole chain up to the project for it', async () => {
    await session();
    const wallC = await createPlacedWall();
    const chain = await structured<{ path: Array<{ type: string }> }>('containment_chain', { express_id: wallC });
    expect(chain.path.map((p) => p.type)).toEqual([
      'IfcProject', 'IfcBuilding', 'IfcBuildingStorey', 'IfcWall',
    ]);
  }, 30_000);

  it('shows it in the spatial hierarchy under that storey', async () => {
    await session();
    const wallC = await createPlacedWall();
    const out = await structured<{ tree: SpatialNode }>('spatial_hierarchy', { include_elements: true });
    const storey = findNode(out.tree, (n) => n.type === 'IfcBuildingStorey');
    expect(storey?.elements).toContain(wallC);
  }, 30_000);

  it('stops placing an entity whose placing relationship was deleted', async () => {
    await session();
    const wallC = await createPlacedWall();
    // Wall A is placed by the file's own IfcRelContainedInSpatialStructure.
    // Deleting that record has to unplace it — and only it. The graph carries a
    // relationshipId per edge, so this is exact rather than inferred.
    await call('entity_delete', { global_id: guid('RELC') });

    const inStorey = await structured<QueryShape>('query_entities', {
      type: 'IfcWall', in_storey: guid('STOR'),
    });
    expect(inStorey.entities.map((e) => e.expressId)).toEqual([wallC]);
  }, 30_000);

  it('re-places an entity whose new storey is queued and old storey deleted', async () => {
    await session();
    // Wall A is in L01 through the file's own relationship. Move it: queue a
    // storey, queue a relationship placing it there, delete L01.
    const l02 = await structured<{ expressId: number }>('entity_create', {
      type: 'IfcBuildingStorey',
      attributes: [`'${guid('STO2')}'`, null, "'L02'", null, null, '#40', null, null, '.ELEMENT.', 3000],
    });
    await call('entity_create', {
      type: 'IfcRelContainedInSpatialStructure',
      attributes: [`'${guid('RELY')}'`, null, null, null, ['#72'], `#${l02.expressId}`],
    });
    await call('entity_delete', { global_id: guid('STOR') });

    // The parsed edge to L01 is listed before the queued edge to L02, and the
    // SDK's `containedIn` reads only the first. Dropping the tombstoned endpoint
    // inside `related()` is what leaves L02 first — without it the wall answers
    // "no storey" while a live container exists.
    const inL02 = await structured<QueryShape>('query_entities', {
      type: 'IfcWall', in_storey: guid('STO2'),
    });
    expect(inL02.entities.map((e) => e.expressId)).toContain(72);
  }, 30_000);

  it('shows a storey under its new name after a queued rename', async () => {
    await session();
    await call('entity_set_attribute', { global_id: guid('STOR'), attribute: 'Name', value: 'Level One' });
    const out = await structured<{ tree: SpatialNode }>('spatial_hierarchy', {});
    expect(findNode(out.tree, (n) => n.type === 'IfcBuildingStorey')?.name).toBe('Level One');
    // …and the grouping keyed on that name moves with it.
    const grouped = await structured<CountShape>('count_entities', { type: 'IfcWall', group_by: 'storey' });
    expect(grouped.groups?.find((g) => g.key === 'Level One')?.count).toBe(1);
  }, 30_000);

  it('answers with no tree at all once the project itself is deleted', async () => {
    await session();
    await call('entity_delete', { global_id: guid('PROJ') });
    const out = await structured<{ tree: SpatialNode | null }>('spatial_hierarchy', {});
    expect(out.tree).toBeNull();
  }, 30_000);

  it('stops placing anything in a storey the session deleted', async () => {
    await session();
    await createPlacedWall();
    await call('entity_delete', { global_id: guid('STOR') });

    const inStorey = await structured<QueryShape>('query_entities', {
      type: 'IfcWall', in_storey: guid('STOR'),
    });
    expect(inStorey.count).toBe(0);
    const out = await structured<{ tree: SpatialNode }>('spatial_hierarchy', {});
    expect(findNode(out.tree, (n) => n.type === 'IfcBuildingStorey')).toBeNull();
  }, 30_000);
});

describe('model_audit over queued edits', () => {
  it('catches a duplicate GlobalId this session created', async () => {
    await session();
    await call('entity_create', {
      type: 'IfcWall',
      attributes: [`'${guid('WALA')}'`, null, "'dupe'", null, null, '#40', null, null, null],
    });
    const audit = await structured<AuditShape>('model_audit', {});
    expect(audit.issues.filter((i) => i.rule === 'duplicate-globalid').map((i) => i.message)).toEqual([
      `Duplicate GlobalId ${guid('WALA')} on 2 entities`,
    ]);
    expect(audit.pendingMutations).toBe(1);
  }, 30_000);

  it('applies the structure rules to the session, not to the parsed file', async () => {
    const structureMessages = async (): Promise<string[]> =>
      (await structured<AuditShape>('model_audit', {})).issues
        .filter((i) => i.rule === 'required-entity' || i.rule === 'has-storeys')
        .map((i) => i.message)
        .sort();

    await session();
    // The fixture has no IfcSite, so that one error is the baseline.
    // IfcPascalCase, like every other message this surface emits.
    expect(await structureMessages()).toEqual(['Missing required entity IfcSite']);

    await call('entity_delete', { global_id: guid('STOR') });
    await call('entity_delete', { global_id: guid('PROJ') });
    expect(await structureMessages()).toEqual([
      'Missing required entity IfcProject',
      'Missing required entity IfcSite',
      'No IfcBuildingStorey entities',
    ]);

    // And a second project queued into the session trips single-project.
    await session();
    await call('entity_create', { type: 'IfcProject', attributes: [`'${guid('PRJ2')}'`, null, "'Second'"] });
    expect((await structured<AuditShape>('model_audit', {})).issues.map((i) => i.rule))
      .toContain('single-project');
  }, 30_000);

  it('scores naming over products, not over every geometry primitive', async () => {
    await session();
    const audit = await structured<AuditShape>('model_audit', {});
    // The fixture's products are its two walls, the storey, the building and the
    // project. `IfcCartesianPoint`, `IfcLocalPlacement`, `IfcSIUnit` and the rest
    // used to be in the denominator — none of them carries a Name, so they all
    // counted as unnamed and `dataQuality` scored the file on how much geometry
    // it had rather than on how well its products were named.
    expect(audit.totals.products).toBe(5);
    expect(audit.totals.unnamed).toBe(0);
    expect(audit.scores.dataQuality).toBe(100);
  }, 30_000);

  it('scores the naming rule on the names the session wrote', async () => {
    await session();
    const before = await structured<AuditShape>('model_audit', {});

    // Clearing a name has to raise the unnamed count, and a rename has to
    // lower it again — the rule reads `bim.entity`, not the parsed store.
    await call('entity_set_attribute', { global_id: guid('WALA'), attribute: 'Name', value: '' });
    const cleared = await structured<AuditShape>('model_audit', {});
    expect(cleared.totals.unnamed).toBe(before.totals.unnamed + 1);
    expect(cleared.totals.products).toBe(before.totals.products);

    await call('entity_set_attribute', { global_id: guid('WALA'), attribute: 'Name', value: 'Wall A again' });
    const renamed = await structured<AuditShape>('model_audit', {});
    expect(renamed.totals.unnamed).toBe(before.totals.unnamed);

    // A created entity is scored too: leaving it unnamed is the mistake the
    // rule exists to report, and an audit that cannot see it reports a score
    // for a model that is not the one the session holds.
    await call('entity_create', { type: 'IfcWall', attributes: [`'${guid('WALC')}'`] });
    const withCreated = await structured<AuditShape>('model_audit', {});
    expect(withCreated.totals.products).toBe(before.totals.products + 1);
    expect(withCreated.totals.unnamed).toBe(before.totals.unnamed + 1);
  }, 30_000);

  it('stops reporting a duplicate whose store-side entity was deleted', async () => {
    await session();
    await call('entity_create', {
      type: 'IfcWall',
      attributes: [`'${guid('WALB')}'`, null, "'dupe'", null, null, '#40', null, null, null],
    });
    expect((await structured<AuditShape>('model_audit', {})).issues
      .filter((i) => i.rule === 'duplicate-globalid')).toHaveLength(1);

    // By express_id, deliberately. Two entities now share this GlobalId, so
    // `global_id` is ambiguous and `findByGlobalId` resolves queued-first —
    // deleting by GlobalId here would remove the created twin and never reach
    // the tombstone path this test is about.
    await call('entity_delete', { express_id: 73 });

    const audit = await structured<AuditShape>('model_audit', {});
    expect(audit.issues.filter((i) => i.rule === 'duplicate-globalid')).toEqual([]);
  }, 30_000);
});

describe('pendingMutations rides on every payload that folds', () => {
  const FOLDING: Array<[string, Record<string, unknown>]> = [
    ['get_entity', { global_id: guid('WALA') }],
    ['get_entities_bulk', { global_ids: [guid('WALA')] }],
    ['query_entities', { type: 'IfcWall' }],
    ['count_entities', {}],
    ['count_entities', { group_by: 'type' }],
    ['model_info', {}],
    ['properties_unique', { type: 'IfcWall', pset: 'Pset_WallCommon', property: 'IsExternal' }],
    ['materials_list', {}],
    ['classifications_list', {}],
    ['spatial_hierarchy', {}],
    ['containment_chain', { global_id: guid('WALA') }],
    ['model_audit', {}],
  ];

  /** Reads that answer from the parsed model and say so, rather than claiming a
   *  fold they do not perform. */
  const NOT_FOLDING: Array<[string, Record<string, unknown>]> = [
    // Voids/fills/groups/connections come from a parser-side extractor with no
    // overlay seam — unlike containment, which routes through the backend's
    // `related()`.
    ['relationships', { global_id: guid('WALA') }],
    ['units', {}],
    ['georeferencing', {}],
  ];

  it('is present on every folding payload once the session has edits', async () => {
    await session();
    await call('entity_set_attribute', { global_id: guid('WALA'), attribute: 'Name', value: 'edited' });
    for (const [name, args] of FOLDING) {
      const out = await structured<{ pendingMutations?: number }>(name, args);
      expect(out.pendingMutations, name).toBe(1);
    }
  }, 60_000);

  it('is absent on every payload before any edit', async () => {
    await session();
    for (const [name, args] of [...FOLDING, ...NOT_FOLDING]) {
      const out = await structured<Record<string, unknown>>(name, args);
      expect(out, name).not.toHaveProperty('pendingMutations');
    }
  }, 60_000);

  it('stays absent on the reads that do not fold, even with edits queued', async () => {
    await session();
    await call('entity_set_attribute', { global_id: guid('WALA'), attribute: 'Name', value: 'edited' });
    for (const [name, args] of NOT_FOLDING) {
      const out = await structured<Record<string, unknown>>(name, args);
      expect(out, name).not.toHaveProperty('pendingMutations');
    }
  }, 30_000);
});
