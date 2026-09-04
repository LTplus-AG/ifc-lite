/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A write to an express id the model does not hold, through the MCP tools.
 *
 * `bim.mutate.*` refuses one; these tools do not go through `bim.mutate.*`.
 * They take `express_id` on faith and write straight into
 * `backend.getMutationView()`, so `entity_set_property {express_id: 999999}`
 * answered "Queued" and the exporter, which only visits entities the effective
 * model holds, dropped it with nothing said. That is the same phantom write
 * #3764 fixed on the SDK path, arriving by the door agents actually use.
 *
 * Asserted on the tool RESULT, not on a thrown error: an agent sees a
 * `CallToolResult`, and one that reads as success is the whole defect.
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

const MODEL = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('m','2026',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1= IFCPROJECT('PROJ00000000000000000X',$,'Proj',$,$,$,$,(#20),#30);
#20= IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-5,#21,$);
#21= IFCAXIS2PLACEMENT3D(#22,$,$);
#22= IFCCARTESIANPOINT((0.,0.,0.));
#30= IFCUNITASSIGNMENT((#31));
#31= IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#70= IFCWALL('WALL00000000000000000X',$,'Wall',$,$,$,$,'tag',$);
ENDSEC;
END-ISO-10303-21;
`;

const PHANTOM = 999999;

let tmp: string;
let ctx: ToolContext;

function tool(name: string) {
  const found = mutationTools.find((t) => t.name === name);
  if (!found) throw new Error(`${name} not registered`);
  return found;
}

/** The result an MCP client would see, including the one a throw turns into. */
async function call(name: string, input: Record<string, unknown>): Promise<CallToolResult> {
  try {
    return await tool(name).handler(input, ctx);
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

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'ifc-lite-mcp-phantom-'));
  await writeFile(join(tmp, 'm.ifc'), MODEL, 'utf-8');
});

afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe('the mutation tools over an express id the model does not hold', () => {
  it('entity_set_property refuses it, naming the id and the model', async () => {
    await session();
    const result = await call('entity_set_property', {
      express_id: PHANTOM, pset: 'Pset_Bogus', name: 'Foo', value: 'bar',
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent?.message).toMatch(/999999/);
    expect(result.structuredContent?.message).toMatch(/'m'/);
  });

  it('entity_delete_property refuses it', async () => {
    await session();
    const result = await call('entity_delete_property', {
      express_id: PHANTOM, pset: 'Pset_WallCommon', name: 'Reference',
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent?.message).toMatch(/999999.*'m'/);
  });

  it('entity_set_attribute refuses it', async () => {
    await session();
    const result = await call('entity_set_attribute', {
      express_id: PHANTOM, attribute: 'Name', value: 'Ghost',
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent?.message).toMatch(/999999.*'m'/);
  });

  it('entity_delete refuses it instead of reporting a no-op delete', async () => {
    // Same phantom-write class from the other end: a delete of an id nothing
    // holds answered `okResult` with `deleted: false`, so `mutation_batch`
    // counted the step as succeeded and the summary read "Batch 1/1 succeeded".
    await session();
    const result = await call('entity_delete', { express_id: PHANTOM });

    expect(result.isError).toBe(true);
    expect(result.structuredContent?.message).toMatch(/999999.*'m'/);
  });

  it('mutation_batch reports a failing entity_delete step as failed', async () => {
    await session();
    const result = await call('mutation_batch', {
      operations: [{ tool: 'entity_delete', args: { express_id: PHANTOM } }],
    });

    const steps = (result.structuredContent as { results: Array<{ ok: boolean }> }).results;
    expect(steps[0].ok).toBe(false);
    expect(result.content?.[0]).toMatchObject({ text: 'Batch 0/1 succeeded.' });
  });

  it('mutation_batch reports the failing step instead of counting it as applied', async () => {
    await session();
    const result = await call('mutation_batch', {
      operations: [
        { tool: 'entity_set_attribute', args: { express_id: 70, attribute: 'Name', value: 'Real' } },
        { tool: 'entity_set_property', args: { express_id: PHANTOM, pset: 'Pset_Bogus', name: 'Foo', value: 'bar' } },
      ],
    });

    const steps = (result.structuredContent as { results: Array<{ ok: boolean; error?: string }> }).results;
    expect(steps[0].ok).toBe(true);
    expect(steps[1].ok).toBe(false);
    expect(steps[1].error).toMatch(/999999/);

    // And the batch is PARTIAL, not atomic: step 1 stays queued. Pinned here
    // because the tool's own prose used to promise atomicity, so a reader had
    // to choose between the description and the loop. This is the loop.
    const diff = await call('mutation_diff', {});
    expect(diff.structuredContent?.count).toBe(1);
  });

  it('leaves the session untouched when a write is refused', async () => {
    // A refused write must not be half-done. `entity_delete_property` and
    // `entity_set_attribute` materialised the editor and the mutation view
    // BEFORE checking the id, so a refusal still left an empty overlay behind
    // and `mutation_diff` reported "0 pending mutation(s)" where an untouched
    // session says "No pending mutations." That is a small lie with a real
    // cost: it is the difference between "you edited nothing" and "your edits
    // are queued and empty".
    await session();
    for (const [name, args] of [
      ['entity_set_property', { express_id: PHANTOM, pset: 'P', name: 'F', value: 'v' }],
      ['entity_delete_property', { express_id: PHANTOM, pset: 'P', name: 'F' }],
      ['entity_set_attribute', { express_id: PHANTOM, attribute: 'Name', value: 'Ghost' }],
      ['entity_delete', { express_id: PHANTOM }],
    ] as const) {
      expect((await call(name, args)).isError, name).toBe(true);
    }

    const diff = await call('mutation_diff', {});
    expect(diff.content?.[0]).toMatchObject({ text: 'No pending mutations.' });
  });

  it('still queues a write to an id the model does hold', async () => {
    // Guards the four above: they have to refuse the phantom id, not every id.
    await session();
    const result = await call('entity_set_property', {
      express_id: 70, pset: 'Pset_WallCommon', name: 'Reference', value: 'W-01',
    });

    expect(result.isError).toBeUndefined();
  });
});
