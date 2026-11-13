/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { mkdtemp, readFile, realpath, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it, vi } from 'vitest';
import { fullScope } from '../auth/scope.js';
import { DEFAULT_CONFIG, InMemoryModelRegistry, NOOP_PROGRESS, SILENT_LOGGER, type ToolContext } from '../context.js';
import { source } from './__fixtures__/export-session.js';
import { loadIfcModel, loadIfcModelFromBytes } from '../loader.js';
import { exportTools } from './export.js';

// Pass-through spy on the real lazy Rhino engine entry point.
const rhino = vi.hoisted(() => ({ exportRhinoScene: vi.fn() }));
vi.mock('@ifc-lite/geometry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@ifc-lite/geometry')>();
  rhino.exportRhinoScene.mockImplementation(actual.exportRhinoScene);
  return { ...actual, exportRhinoScene: rhino.exportRhinoScene };
});

it('export_3dm writes Rhino geometry and reports counts; empty models and invalid versions are refused', async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'mcp-rhino-')));
  const sample = fileURLToPath(new URL('../../../../apps/viewer/public/samples/hello-wall.ifc', import.meta.url));
  const model = await loadIfcModel(sample, { modelId: 'm' });
  const ctx: ToolContext = {
    registry: new InMemoryModelRegistry(), scope: fullScope(), progress: NOOP_PROGRESS,
    log: SILENT_LOGGER, signal: new AbortController().signal,
    config: { ...DEFAULT_CONFIG, allowedPaths: [dir] },
  };
  ctx.registry.add(model);
  const tool = exportTools.find(t => t.name === 'export_3dm')!;
  try {
    const out = join(dir, 'wall.3dm');
    const result = await tool.handler({ model_id: 'm', file_path: out, units: 'meters', version: 7 }, ctx);
    expect(result.structuredContent).toMatchObject({ filePath: out, objects: expect.any(Number) });
    expect(result.structuredContent?.objects).toBeGreaterThan(0);
    const bytes = await readFile(out);
    expect(bytes.subarray(0, 24).toString()).toContain('3D Geometry File Format');
    const empty = await loadIfcModelFromBytes(source, 'empty.ifc', 'empty');
    ctx.registry.add(empty);
    // a null scene option means "absent", as for every tool, and uses the default.
    const nullPath = join(dir, 'null.3dm');
    await expect(tool.handler({ model_id: 'm', file_path: nullPath, units: null, normals: null }, ctx)).resolves.toMatchObject({ structuredContent: { filePath: nullPath } });
    const emptyPath = join(dir, 'empty.3dm');
    try {
      await expect(tool.handler({ model_id: 'empty', file_path: emptyPath }, ctx)).rejects.toThrow(/3DM export produced 0 meshes/);
      await expect(access(emptyPath)).rejects.toThrow();
    } finally { empty.backend.dispose(); }
    const bad = join(dir, 'bad.3dm');
    await expect(tool.handler({ model_id: 'm', file_path: bad, version: 9 }, ctx)).rejects.toThrow(/version/);
    await expect(access(bad)).rejects.toThrow();
  } finally { model.backend.dispose(); await rm(dir, { recursive: true, force: true }); }
}, 60000);

// direct tool callers bypass JSON Schema validation.
it.each([{ version: 9 }, { units: 'yards' }, { coordinates: 'survey' }, { layerScheme: 'bad' }, { properties: 'bad' }, { instancing: 0 }, { includeSpaces: 'yes' }, { layerSlicing: 'yes' }, { unknown: true }])('rejects options before building the scene: %j', async options => {
  rhino.exportRhinoScene.mockClear();
  const tool = exportTools.find(t => t.name === 'export_3dm')!;
  await expect(tool.handler({ file_path: 'unused.3dm', ...options }, undefined!)).rejects.toThrow(/INVALID_INPUT/);
  expect(rhino.exportRhinoScene).not.toHaveBeenCalled();
});
