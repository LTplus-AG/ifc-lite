/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `model.openFromSource` through `run_flow` (#5634): the opened model is
 * parsed by the MCP loader, the model read wired after it sees that model,
 * and the model stays registered for later tool calls. Goes through
 * `buildDefaultToolRegistry()` like `flow.test.ts`.
 */

import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { ToolContext } from '../context.js';
import { DEFAULT_CONFIG, InMemoryModelRegistry, NOOP_PROGRESS, SILENT_LOGGER } from '../context.js';
import { fullScope } from '../auth/scope.js';
import { loadIfcModel } from '../loader.js';
import { buildDefaultToolRegistry } from './index.js';

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, '../../../../');
const SAMPLE_IFC = resolve(REPO_ROOT, 'apps/viewer/public/samples/building-architecture.ifc');
const HELLO_WALL = resolve(REPO_ROOT, 'apps/viewer/public/samples/hello-wall.ifc');

async function context(): Promise<ToolContext> {
  const registry = new InMemoryModelRegistry();
  registry.add(await loadIfcModel(SAMPLE_IFC, { modelId: 'sample' }));
  return { registry, scope: fullScope(), progress: NOOP_PROGRESS, log: SILENT_LOGGER, signal: new AbortController().signal, config: { ...DEFAULT_CONFIG } };
}

function graph(data: string) {
  return {
    flowVersion: 1, id: 'open', name: 'open', capabilities: ['model.create', 'model.read'], inputs: [],
    outputs: [{ nodeId: 'open', port: 'modelId', label: 'model' }, { nodeId: 'n', port: 'count', label: 'walls' }],
    nodes: [
      { id: 'walls', type: 'model.byType', params: { type: 'IfcWall' } },
      { id: 'n', type: 'core.count' },
      { id: 'src', type: 'core.string', params: { value: data } },
      { id: 'open', type: 'model.openFromSource', params: { name: 'Hello Wall.ifc' } },
    ],
    edges: [
      { from: ['src', 'value'], to: ['open', 'data'] },
      { from: ['open', 'modelId'], to: ['walls', 'modelId'] },
      { from: ['walls', 'entities'], to: ['n', 'items'] },
    ],
  };
}

describe('run_flow: model.openFromSource', () => {
  it('opens IFC bytes as a new registered model that the following read queries', async () => {
    const runFlow = buildDefaultToolRegistry().get('run_flow');
    if (!runFlow) throw new Error('run_flow not registered');
    const ctx = await context();
    const data = (await readFile(HELLO_WALL)).toString('base64');
    const result = await runFlow.handler({ flow: graph(data), model_id: 'sample' }, ctx);
    const summary = result.structuredContent as { ok: boolean; errors: unknown[]; outputs: Array<{ key: string; data: unknown }> };
    expect(summary.errors).toEqual([]);
    expect(summary.ok).toBe(true);
    expect(summary.outputs.find((o) => o.key === 'open.modelId')?.data).toBe('hello_wall');
    // hello-wall.ifc holds one IfcWall; the command's model holds several.
    expect(summary.outputs.find((o) => o.key === 'n.count')?.data).toBe(1);
    expect(ctx.registry.list().map((m) => m.id)).toEqual(['sample', 'hello_wall']);
    expect(ctx.registry.get('hello_wall')?.bim.query().byType('IfcWall').count()).toBe(1);
  });

  it('never overwrites a registered model with the same derived id', async () => {
    const runFlow = buildDefaultToolRegistry().get('run_flow');
    if (!runFlow) throw new Error('run_flow not registered');
    const ctx = await context();
    const data = (await readFile(HELLO_WALL)).toString('base64');
    await runFlow.handler({ flow: graph(data), model_id: 'sample' }, ctx);
    const second = await runFlow.handler({ flow: graph(data), model_id: 'sample' }, ctx);
    const summary = second.structuredContent as { outputs: Array<{ key: string; data: unknown }> };
    expect(summary.outputs.find((o) => o.key === 'open.modelId')?.data).toBe('hello_wall_2');
    expect(ctx.registry.list().map((m) => m.id)).toEqual(['sample', 'hello_wall', 'hello_wall_2']);
  });
});
