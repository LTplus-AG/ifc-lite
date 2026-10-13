/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, expect, it } from 'vitest';
import { fullScope } from '../auth/scope.js';
import { DEFAULT_CONFIG, InMemoryModelRegistry, NOOP_PROGRESS, SILENT_LOGGER, type ToolContext } from '../context.js';
import { loadIfcModelFromBytes } from '../loader.js';
import { exportTools } from './export.js';
import { source } from './__fixtures__/export-session.js';

const wasm = new URL('../../../wasm/pkg/ifc-lite_bg.wasm', import.meta.url);
const available = existsSync(wasm);
beforeAll(async () => {
  if (!available) { console.warn('Session export tests require pnpm build:wasm'); return; }
  const runtime = await import('@ifc-lite/wasm');
  runtime.initSync({ module: readFileSync(wasm) });
});

// Regression: fresh MCP creates must export identically to export-IFC/reload.
it.skipIf(!available)('same-session IFCX and USD include authored elements through the real Rust exporters', async () => {
  const tmp = await realpath(await mkdtemp(join(tmpdir(), 'mcp-export-session-wasm-')));
  const model = await loadIfcModelFromBytes(source, 'm.ifc', 'm');
  const ctx: ToolContext = {
    registry: new InMemoryModelRegistry(), scope: fullScope(), progress: NOOP_PROGRESS,
    log: SILENT_LOGGER, signal: new AbortController().signal,
    config: { ...DEFAULT_CONFIG, allowedPaths: [tmp] },
  };
  ctx.registry.add(model);
  try {
    model.bim.store.addWall('m', 41, {
      Start: [0, 0, 0], End: [4, 0, 0], Thickness: 0.2, Height: 3, Name: 'SessionWall',
    });
    const ifc = model.bim.export.ifc();
    const reloaded = await loadIfcModelFromBytes(typeof ifc === 'string' ? new TextEncoder().encode(ifc) : ifc, 'reloaded.ifc', 'reloaded');
    ctx.registry.add(reloaded);
    for (const name of ['export_ifcx', 'export_usd']) {
      const tool = exportTools.find(t => t.name === name)!;
      const currentPath = join(tmp, `${name}-current.out`);
      const reloadedPath = join(tmp, `${name}-reloaded.out`);
      await tool.handler({ model_id: 'm', file_path: currentPath }, ctx);
      await tool.handler({ model_id: 'reloaded', file_path: reloadedPath }, ctx);
      const current = await readFile(currentPath, 'utf-8');
      const roundTrip = await readFile(reloadedPath, 'utf-8');
      if (name === 'export_ifcx') {
        expect(JSON.parse(current)).toEqual(JSON.parse(roundTrip));
        expect(current).toContain('SessionWall');
      } else {
        const meshes = current.match(/def Mesh /g) ?? [];
        expect(meshes.length).toBeGreaterThan(0);
        expect(meshes).toHaveLength((roundTrip.match(/def Mesh /g) ?? []).length);
        expect(current).toContain('SessionWall');
      }
    }
    expect(model.backend.getMutationView()?.hasPendingChanges()).toBe(true);
  } finally {
    model.backend.dispose();
    await rm(tmp, { recursive: true, force: true });
  }
});
