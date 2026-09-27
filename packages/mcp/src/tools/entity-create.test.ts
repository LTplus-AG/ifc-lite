/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `entity_create { global_id }` (#5634, #5167 Phase 2).
 *
 * The in-store builders and `bim.store.add*` accept a caller GlobalId; the MCP
 * creator now does too. Each case drives the real tool and reads the result
 * back through the real read tools, the way an agent would, and asserts on the
 * `CallToolResult` an MCP client sees (a thrown `ToolExecutionError` included).
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
import { ToolExecutionError } from '../errors.js';
import { mutationTools } from './mutate.js';
import { queryTools } from './query.js';

const PARSED_WALL = '0WALL00000000000000000';
const NEW_WALL = '1NewWa11GuidAbCdEf$_09';

const MODEL = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('m','2026',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1= IFCPROJECT('0PROJ0000000000000000X',$,'Proj',$,$,$,$,(#20),#30);
#20= IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-5,#21,$);
#21= IFCAXIS2PLACEMENT3D(#22,$,$);
#22= IFCCARTESIANPOINT((0.,0.,0.));
#30= IFCUNITASSIGNMENT((#31));
#31= IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#70= IFCWALL('${PARSED_WALL}',$,'Wall',$,$,$,$,'tag',$);
ENDSEC;
END-ISO-10303-21;
`;

let tmp: string;
let ctx: ToolContext;

const TOOLS = [...mutationTools, ...queryTools];

async function call(name: string, input: Record<string, unknown>): Promise<CallToolResult> {
  const found = TOOLS.find((t) => t.name === name);
  if (!found) throw new Error(`${name} not registered`);
  try {
    return await found.handler(input, ctx);
  } catch (err) {
    if (err instanceof ToolExecutionError) return err.toToolResult();
    throw err;
  }
}

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

/** Count of queued mutations: a refused create must leave it untouched. */
async function pending(): Promise<number> {
  const diff = await call('mutation_diff', {});
  return (diff.structuredContent as { count: number }).count;
}

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'ifc-lite-mcp-entity-create-gid-'));
  await writeFile(join(tmp, 'm.ifc'), MODEL, 'utf-8');
});

afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe('entity_create global_id', () => {
  it('creates the entity carrying the requested GlobalId, readable back by it', async () => {
    await session();
    const created = await call('entity_create', {
      type: 'IfcWall', global_id: NEW_WALL, attributes: [null, null, 'Pinned wall'],
    });
    expect(created.isError).toBeUndefined();
    const expressId = (created.structuredContent as { expressId: number }).expressId;
    expect(created.structuredContent).toMatchObject({ type: 'IfcWall', globalId: NEW_WALL });

    const read = await call('get_entity', { global_id: NEW_WALL });
    expect(read.isError).toBeUndefined();
    expect(read.structuredContent).toMatchObject({
      ref: { modelId: 'm', expressId }, globalId: NEW_WALL, name: 'Pinned wall', type: 'IfcWall',
    });
  });

  it('accepts attributes[0] that already names the same GlobalId', async () => {
    await session();
    const created = await call('entity_create', {
      type: 'IfcWall', global_id: NEW_WALL, attributes: [NEW_WALL, null, 'Same id'],
    });
    expect(created.isError).toBeUndefined();
    const read = await call('get_entity', { global_id: NEW_WALL });
    expect(read.structuredContent).toMatchObject({ globalId: NEW_WALL, name: 'Same id' });
  });

  it.each([
    ['too short', '1NewWa11Guid'],
    ['first character above 3', 'ZNewWa11GuidAbCdEf$_09'],
    ['character outside the IFC alphabet', '1NewWa11GuidAbCdEf-_09'],
  ])('refuses an invalid GUID (%s) with INVALID_INPUT and creates nothing', async (_label, bad) => {
    await session();
    const result = await call('entity_create', { type: 'IfcWall', global_id: bad });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ code: 'INVALID_INPUT' });
    expect(result.structuredContent?.message).toMatch(/not a valid IFC GlobalId/);
    expect(await pending()).toBe(0);
  });

  it('refuses a GlobalId a parsed entity already carries', async () => {
    await session();
    const result = await call('entity_create', { type: 'IfcWall', global_id: PARSED_WALL });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      code: 'INVALID_INPUT',
      details: { globalId: PARSED_WALL, expressId: 70, modelId: 'm' },
    });
    expect(result.structuredContent?.message).toMatch(/already used by #70/);
    expect(await pending()).toBe(0);
  });

  it('refuses a GlobalId an entity created earlier in the session carries', async () => {
    await session();
    const first = await call('entity_create', { type: 'IfcWall', global_id: NEW_WALL });
    expect(first.isError).toBeUndefined();
    const firstId = (first.structuredContent as { expressId: number }).expressId;

    const second = await call('entity_create', { type: 'IfcSlab', global_id: NEW_WALL });
    expect(second.isError).toBe(true);
    expect(second.structuredContent).toMatchObject({
      code: 'INVALID_INPUT', details: { globalId: NEW_WALL, expressId: firstId },
    });
    expect(await pending()).toBe(1);
  });

  it('refuses a class that has no GlobalId', async () => {
    await session();
    const result = await call('entity_create', {
      type: 'IfcCartesianPoint', global_id: NEW_WALL, attributes: [[1, 2, 3]],
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ code: 'INVALID_INPUT' });
    expect(result.structuredContent?.message).toMatch(/not an IfcRoot subtype/);
  });

  it('refuses attributes[0] naming a different GlobalId', async () => {
    await session();
    const result = await call('entity_create', {
      type: 'IfcWall', global_id: NEW_WALL, attributes: ['2Other0000000000000000'],
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ code: 'INVALID_INPUT' });
    expect(result.structuredContent?.message).toMatch(/conflicts with attributes\[0\]/);
  });

  it('works inside mutation_batch, and a duplicate there is a failed step', async () => {
    await session();
    const batch = await call('mutation_batch', {
      operations: [
        { tool: 'entity_create', args: { type: 'IfcWall', global_id: NEW_WALL } },
        { tool: 'entity_set_attribute', args: { global_id: NEW_WALL, attribute: 'Name', value: 'Batched' } },
        { tool: 'entity_create', args: { type: 'IfcWall', global_id: PARSED_WALL } },
      ],
    });
    const results = (batch.structuredContent as { results: Array<{ ok: boolean; error?: string }> }).results;
    expect(results.map((r) => r.ok)).toEqual([true, true, false]);
    expect(results[2].error).toMatch(/already used by #70/);

    const read = await call('get_entity', { global_id: NEW_WALL });
    expect(read.structuredContent).toMatchObject({ globalId: NEW_WALL, name: 'Batched' });
  });
});
