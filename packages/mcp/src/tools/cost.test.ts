/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { IfcParser } from '@ifc-lite/parser';
import { createBimContext } from '@ifc-lite/sdk';
import { HeadlessLikeBackend } from '../headless-backend.js';
import { DEFAULT_CONFIG, InMemoryModelRegistry, NOOP_PROGRESS, SILENT_LOGGER, type ToolContext } from '../context.js';
import { fullScope } from '../auth/scope.js';
import { buildDefaultToolRegistry } from './index.js';
import { costTools } from './cost.js';

const path = fileURLToPath(new URL('../../../../tests/models/cost/buildingsmart-cost-composition.ifc', import.meta.url));
const available = existsSync(path);
if (!available) console.warn('skip: canonical cost fixture missing — run `pnpm fixtures`');

async function context(): Promise<ToolContext> {
  const bytes = new Uint8Array(readFileSync(path));
  const store = await new IfcParser().parseColumnar(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), { disableWorkerScan: true });
  const backend = new HeadlessLikeBackend(store, 'cost.ifc', 'cost-model');
  const registry = new InMemoryModelRegistry();
  registry.add({ id: 'cost-model', name: 'cost.ifc', store, backend, bim: createBimContext({ backend }), loadedAt: 0 });
  return { registry, scope: fullScope(), progress: NOOP_PROGRESS, log: SILENT_LOGGER, signal: new AbortController().signal, config: { ...DEFAULT_CONFIG } };
}

describe('#4855 MCP cost tools', () => {
  it('registers both read tools in default discovery', () => {
    const registry = buildDefaultToolRegistry();
    expect(registry.has('cost_data')).toBe(true);
    expect(registry.has('cost_evaluate')).toBe(true);
  });

  it.skipIf(!available)('returns the canonical graph and item total', async () => {
    const ctx = await context();
    const dataTool = costTools.find(tool => tool.name === 'cost_data');
    const evaluateTool = costTools.find(tool => tool.name === 'cost_evaluate');
    if (!dataTool || !evaluateTool) throw new Error('cost tools not registered');
    const data = await dataTool.handler({}, ctx);
    expect(data.structuredContent?.data).toMatchObject({ modelId: 'cost-model', source: 'loaded-source', Currency: 'GBP' });
    const model = ctx.registry.get('cost-model');
    if (!model) throw new Error('cost model not registered');
    model.bim.mutate.setAttribute({ modelId: 'cost-model', expressId: 42 }, 'Name', 'Overlay-only name');
    const evaluated = await evaluateTool.handler({ target: 'item', express_id: 42 }, ctx);
    expect(evaluated.structuredContent).toMatchObject({
      source: 'loaded-source', evaluation: { Amount: '2250', Currency: 'GBP' },
    });
    expect(model.bim.cost.items('cost-model').find(item => item.ref.expressId === 42)?.Name)
      .toBe('External wall total');
  });

  it.skipIf(!available)('rejects invalid precision even when called outside protocol validation', async () => {
    const ctx = await context();
    const evaluateTool = costTools.find(tool => tool.name === 'cost_evaluate');
    if (!evaluateTool) throw new Error('cost evaluation tool not registered');
    expect(() => evaluateTool.handler({ target: 'item', express_id: 42, precision: 0 }, ctx))
      .toThrow('precision must be an integer from 1 through 10000');
    expect(() => evaluateTool.handler({ target: 'item', express_id: 42, precision: 10_001 }, ctx))
      .toThrow('precision must be an integer from 1 through 10000');
    expect(() => evaluateTool.handler({
      target: 'item', express_id: Number.MAX_SAFE_INTEGER + 1,
    }, ctx)).toThrow('express_id must be a non-negative safe integer');
  });
});
