/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Regression: same-session IFCX/USD exports omitted newly authored elements.
 * Invariant: every Rust exporter receives the effective model, including its
 * geometry references, without requiring an export/reload cycle. Only the
 * geometry boundary is intercepted; authoring, STEP export and reload are real.
 */
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const boundary = vi.hoisted(() => {
  const stop = new Error('captured exporter input');
  const capture = vi.fn((_bytes: Uint8Array): never => { throw stop; });
  class GeometryProcessor {
    async init(): Promise<void> {}
    exportGlb = capture;
    exportObj = capture;
    exportIfcx = capture;
    exportUsd = capture;
    dispose(): void {}
  }
  return { stop, capture, GeometryProcessor };
});
vi.mock('@ifc-lite/geometry', () => ({
  GeometryProcessor: boundary.GeometryProcessor,
  isNoRenderGeometryError: () => false,
}));

import type { ToolContext } from '../context.js';
import { DEFAULT_CONFIG, InMemoryModelRegistry, NOOP_PROGRESS, SILENT_LOGGER } from '../context.js';
import { fullScope } from '../auth/scope.js';
import { EntityExtractor } from '@ifc-lite/parser';
import { loadIfcModelFromBytes } from '../loader.js';
import { exportTools } from './export.js';
import { mutationTools } from './mutate.js';

import { source } from './__fixtures__/export-session.js';
let tmp: string;
let ctx: ToolContext;

beforeAll(async () => { tmp = await realpath(await mkdtemp(join(tmpdir(), 'mcp-export-session-'))); });
afterAll(async () => { await rm(tmp, { recursive: true, force: true }); });
beforeEach(async () => {
  boundary.capture.mockClear();
  ctx = {
    registry: new InMemoryModelRegistry(), scope: fullScope(),
    progress: NOOP_PROGRESS, log: SILENT_LOGGER,
    signal: new AbortController().signal,
    config: { ...DEFAULT_CONFIG, allowedPaths: [tmp] },
  };
  ctx.registry.add(await loadIfcModelFromBytes(source, 'm.ifc', 'm'));
});

for (const name of ['export_ifcx', 'export_usd', 'export_glb', 'export_obj']) {
  describe(`${name}: effective session input`, () => {
    async function inputBytes(): Promise<Uint8Array> {
      const tool = exportTools.find(t => t.name === name)!;
      await expect(tool.handler({ file_path: join(tmp, `${name}.out`) }, ctx)).rejects.toBe(boundary.stop);
      expect(boundary.capture).toHaveBeenCalledTimes(1);
      return boundary.capture.mock.calls[0]![0];
    }

    it('preserves the original source when there are no pending edits', async () => {
      expect(await inputBytes()).toEqual(source);
      expect(ctx.registry.get('m')!.backend.getMutationView()).toBeNull();
    });

    it('includes newly authored walls and their representation graph without reloading', async () => {
      const model = ctx.registry.get('m')!;
      const created = model.bim.store.addWall('m', 41, {
        Start: [0, 0, 0], End: [4, 0, 0], Thickness: 0.2, Height: 3, Name: 'New wall',
      });
      const reloaded = await loadIfcModelFromBytes(await inputBytes(), 'export.ifc', 'export');
      const wall = reloaded.bim.query().byType('IfcWall').toArray().find(e => e.name === 'New wall');
      expect(wall).toBeDefined();
      // A product record alone is insufficient: it must retain its geometry.
      const extractor = new EntityExtractor(reloaded.store.source);
      const location = reloaded.store.entityIndex.byId.get(wall!.ref.expressId)!;
      const representationId = extractor.extractEntity(location)?.attributes[6];
      expect(typeof representationId).toBe('number');
      const representationRef = reloaded.store.entityIndex.byId.get(representationId as number)!;
      expect(extractor.extractEntity(representationRef)?.type).toBe('IFCPRODUCTDEFINITIONSHAPE');
      const graph = [...reloaded.store.entityIndex.byId.values()].map(ref => extractor.extractEntity(ref));
      expect(graph.filter(e => e?.type === 'IFCEXTRUDEDAREASOLID')).toHaveLength(1);
      expect(model.bim.query().byType('IfcWall').toArray().some(e => e.ref.expressId === created.expressId)).toBe(true);
      expect(model.backend.getMutationView()?.hasPendingChanges()).toBe(true);
    });

    it('includes pending attribute edits', async () => {
      const tool = mutationTools.find(t => t.name === 'entity_set_attribute')!;
      await tool.handler({ express_id: 72, attribute: 'Name', value: 'Renamed wall' }, ctx);
      const reloaded = await loadIfcModelFromBytes(await inputBytes(), 'export.ifc', 'export');
      expect(reloaded.bim.query().byType('IfcWall').toArray().map(e => e.name)).toEqual(['Renamed wall']);
    });

    it('omits deleted elements', async () => {
      const tool = mutationTools.find(t => t.name === 'entity_delete')!;
      await tool.handler({ express_id: 72 }, ctx);
      const reloaded = await loadIfcModelFromBytes(await inputBytes(), 'export.ifc', 'export');
      expect(reloaded.bim.query().byType('IfcWall').toArray()).toHaveLength(0);
    });
  });
}
