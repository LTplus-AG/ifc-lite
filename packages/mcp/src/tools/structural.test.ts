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
import { structuralTools } from './structural.js';

const path = fileURLToPath(new URL('../../../../tests/models/ifcopenshell/structural_analysis_curve.ifc', import.meta.url));
const available = existsSync(path);
if (!available) console.warn('skip: canonical structural fixture missing — run `pnpm fixtures`');

async function context(): Promise<ToolContext> {
  const bytes = new Uint8Array(readFileSync(path));
  const store = await new IfcParser().parseColumnar(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), { disableWorkerScan: true });
  const backend = new HeadlessLikeBackend(store, 'structural.ifc', 'structural-model');
  const registry = new InMemoryModelRegistry();
  registry.add({ id: 'structural-model', name: 'structural.ifc', store, backend, bim: createBimContext({ backend }), loadedAt: 0 });
  return { registry, scope: fullScope(), progress: NOOP_PROGRESS, log: SILENT_LOGGER, signal: new AbortController().signal, config: { ...DEFAULT_CONFIG } };
}

describe('#4206 MCP structural tools', () => {
  it('registers the read tool in default discovery', () => {
    const registry = buildDefaultToolRegistry();
    expect(registry.has('structural_data')).toBe(true);
  });

  it.skipIf(!available)('returns the real Constructivity fixture\'s structural analysis model', async () => {
    const ctx = await context();
    const dataTool = structuralTools.find(tool => tool.name === 'structural_data');
    if (!dataTool) throw new Error('structural_data tool not registered');
    const result = await dataTool.handler({}, ctx);
    const data = result.structuredContent?.data as {
      hasStructural: boolean;
      analysisModels: unknown[];
      members: unknown[];
      connections: unknown[];
      activities: unknown[];
    };
    expect(data.hasStructural).toBe(true);
    expect(data.analysisModels.length).toBe(1);
    expect(data.members.length).toBe(3);
    expect(data.connections.length).toBe(4);
    expect(data.activities.length).toBe(10);
    expect(result.content?.[0]?.text).toContain("model 'structural-model'");
  });
});
