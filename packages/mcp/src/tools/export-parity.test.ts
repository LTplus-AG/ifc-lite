/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, beforeEach, expect, it } from 'vitest';
import { countGlbMeshes, countJsonldNodes } from '@ifc-lite/export';
import { fullScope } from '../auth/scope.js';
import { DEFAULT_CONFIG, InMemoryModelRegistry, NOOP_PROGRESS, SILENT_LOGGER, type ToolContext } from '../context.js';
import { loadIfcModel, loadIfcModelFromBytes } from '../loader.js';
import { validateInput } from '../validate.js';
import { exportTools } from './export.js';
import { source } from './__fixtures__/export-session.js';

const wasm = new URL('../../../wasm/pkg/ifc-lite_bg.wasm', import.meta.url);
const exportWasm = new URL('../../../wasm/pkg-rhino/ifc-lite-rhino_bg.wasm', import.meta.url);
const wall = fileURLToPath(new URL('../../../../apps/viewer/public/samples/hello-wall.ifc', import.meta.url));
const building = fileURLToPath(new URL('../../../../apps/viewer/public/samples/building-architecture.ifc', import.meta.url));

let root: string;
let ctx: ToolContext;
beforeAll(async () => {
  if (!existsSync(wasm)) {
    console.warn('Rust export parity tests require pnpm build:wasm');
    return;
  }
  if (!existsSync(exportWasm)) console.warn('CityJSON parity tests require the pnpm build:wasm export payload');
  const runtime = await import('@ifc-lite/wasm');
  runtime.initSync({ module: readFileSync(wasm) });
});
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'ifc-lite-mcp-export-parity-')));
  ctx = {
    registry: new InMemoryModelRegistry(), scope: fullScope(), progress: NOOP_PROGRESS,
    log: SILENT_LOGGER, signal: new AbortController().signal,
    config: { ...DEFAULT_CONFIG, allowedPaths: [root] },
  };
});
afterEach(async () => {
  for (const model of ctx.registry.list()) model.backend.dispose();
  await rm(root, { recursive: true, force: true });
});

async function run(name: string, input: Record<string, unknown>) {
  const tool = exportTools.find((entry) => entry.name === name);
  expect(tool).toBeDefined();
  if (!tool) throw new Error(`Missing ${name}`);
  const validated = validateInput(tool.inputSchema, input);
  expect(validated.valid).toBe(true);
  return tool.handler(input, ctx);
}

async function artifact(name: string, options: Record<string, unknown> = {}) {
  const filePath = join(root, name);
  const result = await run(name, { file_path: filePath, ...options });
  const content = await readFile(filePath);
  expect(result.structuredContent).toMatchObject({ filePath, bytes: content.length });
  expect(result.content).toContainEqual(expect.objectContaining({ type: 'resource_link', size: content.length }));
  return content;
}

// P5b follow-up to #11583.
it('applies storey and limit filters to a loaded model export', async () => {
  ctx.registry.add(await loadIfcModelFromBytes(source, 'storey.ifc'));
  const result = await run('export_json', { storey: 'Level 1', type: 'IfcWall', limit: 1 });
  expect(result.structuredContent).toMatchObject({ rows: [expect.objectContaining({ Name: 'Existing wall' })] });
});

it('applies the STEP export limit after the GlobalId allowlist (#11583)', async () => {
  const text = new TextDecoder().decode(source).replace(
    'ENDSEC;\nEND-ISO', "#73=IFCWALL('0WALL00000000000000001',$,'Other wall',$,$,#40,$,$,$);\nENDSEC;\nEND-ISO",
  );
  ctx.registry.add(await loadIfcModelFromBytes(new TextEncoder().encode(text), 'walls.ifc'));
  const filePath = join(root, 'limited.ifc');
  const result = await run('export_ifc', { file_path: filePath, global_ids: ['0WALL00000000000000001'], limit: 1 });
  expect(result.structuredContent).toMatchObject({ exportedCount: 1 });
  expect(await readFile(filePath, 'utf-8')).toContain("Other wall");
});

it.skipIf(!existsSync(wasm))('writes binary glTF and a property-bearing JSON-LD graph', async () => {
  ctx.registry.add(await loadIfcModel(wall));
  expect(countGlbMeshes(await artifact('export_gltf', { type: 'IfcWall' }))).toBeGreaterThan(0);
  expect(countJsonldNodes(await artifact('export_jsonld', { type: 'IfcWall' }))).toBeGreaterThan(0);
  const out = join(root, 'empty.jsonld');
  await expect(run('export_jsonld', {
    file_path: out, where: { set: 'Pset_NoSuchSet', property: 'Missing', operator: 'exists' },
  })).rejects.toThrow('matched no entities');
  expect(existsSync(out)).toBe(false);
});

it.skipIf(!existsSync(wasm))('writes parseable Honeybee and Dragonfly models', async () => {
  ctx.registry.add(await loadIfcModel(building));
  for (const name of ['export_hbjson', 'export_dfjson']) {
    const bytes = await artifact(name, { name: 'BIMDemo' });
    expect(JSON.parse(bytes.toString('utf8'))).toMatchObject({ type: 'Model', identifier: expect.stringMatching(/^BIMDemo/) });
  }
});

it.skipIf(!existsSync(wasm) || !existsSync(exportWasm))('writes CityJSON and a stream of CityJSONFeature records', async () => {
  ctx.registry.add(await loadIfcModel(wall));
  const bytes = await artifact('export_cityjson', { blocks_only: true });
  expect(JSON.parse(bytes.toString('utf8'))).toMatchObject({ type: 'CityJSON', version: '2.0' });
  const sequence = await artifact('export_cityjsonseq', { blocks_only: true });
  const [header, feature] = sequence.toString('utf8').trim().split('\n');
  expect(JSON.parse(header)).toMatchObject({ type: 'CityJSON' });
  expect(JSON.parse(feature)).toMatchObject({ type: 'CityJSONFeature' });
});
