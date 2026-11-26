/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, beforeEach, expect, it } from 'vitest';
import { fullScope } from '../auth/scope.js';
import { DEFAULT_CONFIG, InMemoryModelRegistry, NOOP_PROGRESS, SILENT_LOGGER, type ToolContext } from '../context.js';
import { loadIfcModel } from '../loader.js';
import { buildDefaultToolRegistry } from './index.js';

const wallPath = fileURLToPath(new URL('../../../../apps/viewer/public/samples/hello-wall.ifc', import.meta.url));
const wasmPath = new URL('../../../wasm/pkg/ifc-lite_bg.wasm', import.meta.url);
let root: string;
let ctx: ToolContext;

beforeAll(async () => {
  if (!existsSync(wasmPath)) {
    console.warn('Geometry diagnostics require pnpm build:wasm');
    return;
  }
  const runtime = await import('@ifc-lite/wasm');
  runtime.initSync({ module: readFileSync(wasmPath) });
});
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'mcp-model-health-')));
  ctx = {
    registry: new InMemoryModelRegistry(), scope: fullScope(), progress: NOOP_PROGRESS,
    log: SILENT_LOGGER, signal: new AbortController().signal,
    config: { ...DEFAULT_CONFIG, allowedPaths: [root, dirname(wallPath)] },
  };
});
afterEach(async () => {
  for (const model of ctx.registry.list()) model.backend.dispose();
  await rm(root, { recursive: true, force: true });
});

async function run(name: string, input: Record<string, unknown>) {
  const tool = buildDefaultToolRegistry().get(name);
  expect(tool).not.toBeNull();
  if (!tool) throw new Error(`Missing tool ${name}`);
  return tool.handler(input, ctx);
}

// P5b follow-up to #11583.
it('computes statistics from a real IFC wall model', async () => {
  const model = await loadIfcModel(wallPath);
  ctx.registry.add(model);
  const result = await run('model_stats', {});
  expect(result.structuredContent).toMatchObject({
    schema: model.store.schemaVersion, elements: { IfcWall: 1 }, validation: { duplicateGlobalIds: 0 },
  });
});

it.skipIf(!existsSync(wasmPath))('runs the Rust geometry diagnostics on the wall model', async () => {
  ctx.registry.add(await loadIfcModel(wallPath));
  const result = await run('model_diagnose_geometry', { type: 'IfcWall' });
  expect(result.structuredContent).toMatchObject({
    diagnostics: { worstHosts: expect.any(Array), totalCsgFailures: expect.any(Number) },
  });
});

it('evaluates a delivery recipe and refuses secondary files outside its allowed paths', async () => {
  const recipePath = join(root, 'delivery.json');
  await writeFile(recipePath, JSON.stringify({ models: [wallPath], structural: true }));
  const result = await run('model_delivery', { recipe_path: recipePath });
  expect(result.structuredContent).toMatchObject({
    report: { models: [{ path: wallPath }], checks: [{ type: 'structural', status: expect.stringMatching(/^(pass|fail)$/) }] },
  });
  ctx.config.allowedPaths = [root];
  await expect(run('model_delivery', { recipe_path: recipePath }))
    .rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
});
