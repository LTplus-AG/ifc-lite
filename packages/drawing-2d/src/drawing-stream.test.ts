/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The streamed generator (#10264). `drawing-stream.golden.json` was recorded
 * by the PRE-streaming array generator (base 173774d1a2) over the same scenes:
 * the array API must still produce exactly that, and a streamed source in any
 * batching must produce the same drawing while holding one batch at a time
 * and keeping none of it.
 */

import { describe, expect, it } from 'vitest';
import type { MeshData } from '@ifc-lite/geometry';
import { Drawing2DGenerator } from './drawing-generator.js';
import { makeEntityKey } from './types.js';
import type { DrawingMeshSource, DrawingPass } from './drawing-mesh-source.js';
import { drawingDigest, multiMaterialShell, STREAM_OPTIONS, streamConfigs, streamScene, box, sheet } from './drawing-stream.fixtures.test.js';
import golden from './drawing-stream.golden.json' with { type: 'json' };

/** A source that leases each batch until the generator advances, and counts. */
function leasingSource(meshes: readonly MeshData[], size: number, failOn?: { pass: DrawingPass; batch: number }) {
  const stats = { passes: [] as DrawingPass[], live: 0, peak: 0, batches: 0 };
  const source: DrawingMeshSource = {
    async *pass(pass) {
      stats.passes.push(pass);
      let batch = 0;
      for (let i = 0; i < meshes.length; i += size) {
        if (failOn && failOn.pass === pass && failOn.batch === batch) throw new Error('generation replaced');
        // A fresh copy per pass, like a chunk decoded again from storage.
        const leased = meshes.slice(i, i + size).map((mesh) => ({ ...mesh, positions: mesh.positions.slice(), indices: mesh.indices.slice() }));
        stats.live++;
        stats.peak = Math.max(stats.peak, stats.live);
        stats.batches++;
        batch++;
        try {
          yield leased;
        } finally {
          stats.live--;
        }
      }
    },
  };
  return { source, stats };
}

/** Every object reachable from `root`. */
function reachable(root: unknown): Set<unknown> {
  const seen = new Set<unknown>();
  const stack = [root];
  while (stack.length) {
    const value = stack.pop();
    if (value === null || typeof value !== 'object' || seen.has(value)) continue;
    seen.add(value);
    if (ArrayBuffer.isView(value)) continue;
    const entries = value instanceof Map ? [...value.entries()].flat() : value instanceof Set ? [...value] : Object.values(value);
    stack.push(...entries);
  }
  return seen;
}

const goldenDigests = golden as Record<string, string>;

describe('Drawing2DGenerator.generateFromSource', () => {
  for (const { name, config } of streamConfigs()) {
    it(`${name}: the array API still draws what the pre-streaming generator drew`, async () => {
      const drawing = await new Drawing2DGenerator().generate(streamScene(), config, STREAM_OPTIONS);
      expect(drawing.lines.length, 'the scene must draw something').toBeGreaterThan(0);
      expect(drawingDigest(drawing)).toBe(goldenDigests[name]);
    });

    for (const size of [1, 2, 3, 5]) {
      it(`${name}: batches of ${size} draw the same, one lease at a time`, async () => {
        const array = await new Drawing2DGenerator().generate(streamScene(), config, STREAM_OPTIONS);
        const { source, stats } = leasingSource(streamScene(), size);
        const streamed = await new Drawing2DGenerator().generateFromSource(source, config, STREAM_OPTIONS);
        expect(drawingDigest(streamed)).toBe(drawingDigest(array));
        expect(stats.peak).toBe(1);
        expect(stats.live).toBe(0);
      });
    }
  }

  it('exercises hidden lines, open surfaces and layered fills in the scenes', async () => {
    const [plan, front] = streamConfigs();
    const drawnPlan = await new Drawing2DGenerator().generate(streamScene(), plan.config, STREAM_OPTIONS);
    const drawnFront = await new Drawing2DGenerator().generate(streamScene(), front.config, STREAM_OPTIONS);
    expect(drawnPlan.lines.some((line) => line.openSurfaceCut)).toBe(true);
    expect(drawnPlan.layerBaseCutPolygons?.length).toBeGreaterThan(0);
    expect(drawnFront.lines.some((line) => line.visibility === 'hidden')).toBe(true);
    expect(new Set(drawnPlan.cutPolygons.map((polygon) => polygon.modelIndex))).toEqual(new Set([0, 1]));
  });

  it('keeps no mesh or geometry array of a batch in the drawing', async () => {
    const { config } = streamConfigs()[0];
    const handed: object[] = [];
    const source: DrawingMeshSource = {
      async *pass() {
        for (const mesh of streamScene()) {
          handed.push(mesh, mesh.positions, mesh.indices, mesh.normals);
          yield [mesh];
        }
      },
    };
    const drawing = await new Drawing2DGenerator().generateFromSource(source, config, STREAM_OPTIONS);
    const kept = reachable(drawing);
    expect(handed.filter((object) => kept.has(object))).toEqual([]);
  });

  it('replays a source only when occlusion or an open surface needs it', async () => {
    const { config } = streamConfigs()[0];
    const closed = [box(1, [0, 0, 0], [4, 3, 0.3]), box(2, [0, 0, 1], [0.3, 3, 4])];
    const cutOnly = leasingSource(closed, 1);
    await new Drawing2DGenerator().generateFromSource(cutOnly.source, config, { ...STREAM_OPTIONS, includeProjection: false });
    expect(cutOnly.stats.passes).toEqual(['geometry']);
    const open = leasingSource([...closed, sheet(5, 1, 3, 2, 2)], 1);
    await new Drawing2DGenerator().generateFromSource(open.source, config, { ...STREAM_OPTIONS, includeProjection: false });
    expect(open.stats.passes).toEqual(['geometry', 'occlusion']);
    const occluded = leasingSource(closed, 1);
    await new Drawing2DGenerator().generateFromSource(occluded.source, config, STREAM_OPTIONS);
    expect(occluded.stats.passes).toEqual(['geometry', 'occlusion']);
  });

  it('rejects, releasing its lease, when the source fails in either pass', async () => {
    const { config } = streamConfigs()[1];
    for (const pass of ['geometry', 'occlusion'] as const) {
      const { source, stats } = leasingSource(streamScene(), 2, { pass, batch: 2 });
      await expect(new Drawing2DGenerator().generateFromSource(source, config, STREAM_OPTIONS)).rejects.toThrow('generation replaced');
      expect(stats.live).toBe(0);
    }
  });

  it('stops between batches once its signal aborts', async () => {
    const { config } = streamConfigs()[1];
    const controller = new AbortController();
    const { source, stats } = leasingSource(streamScene(), 1);
    const watched: DrawingMeshSource = {
      async *pass(pass) {
        for await (const batch of source.pass(pass)) {
          if (stats.batches === 3) controller.abort(new Error('superseded'));
          yield batch;
        }
      },
    };
    await expect(new Drawing2DGenerator().generateFromSource(watched, config, { ...STREAM_OPTIONS, signal: controller.signal }))
      .rejects.toThrow('superseded');
    expect(stats.batches).toBe(3);
    expect(stats.live).toBe(0);
  });
});

describe('Drawing2DGenerator.beginDrawing (push session)', () => {
  for (const { name, config } of streamConfigs()) {
    it(`${name}: one batch at a time, released between adds, draws the golden drawing`, async () => {
      const session = new Drawing2DGenerator().beginDrawing(config, STREAM_OPTIONS);
      for (const mesh of streamScene()) await session.addGeometry([mesh]);
      const needs = session.endGeometry();
      if (needs.depthRaster) for (const mesh of streamScene()) session.addOcclusion([mesh]);
      else for (const mesh of streamScene()) {
        // Only the open-surface candidates' meshes, as a bounded caller would lease them.
        if (needs.openSurfaceEntities.has(makeEntityKey(mesh.modelIndex ?? 0, mesh.expressId))) session.addOcclusion([mesh]);
      }
      expect(drawingDigest(session.finish())).toBe(goldenDigests[name]);
    });
  }

  it('names the open-surface entities a cut-only caller must re-feed, and nothing else', async () => {
    const { config } = streamConfigs()[0];
    const cutOnly = { ...STREAM_OPTIONS, includeProjection: false };
    const session = new Drawing2DGenerator().beginDrawing(config, cutOnly);
    await session.addGeometry(streamScene());
    const needs = session.endGeometry();
    expect(needs.depthRaster).toBe(false);
    expect([...needs.openSurfaceEntities]).toEqual([makeEntityKey(0, 5)]);
    session.addOcclusion(streamScene().filter((mesh) => mesh.expressId === 5));
    const pushed = session.finish();
    const array = await new Drawing2DGenerator().generate(streamScene(), config, cutOnly);
    expect(drawingDigest(pushed)).toBe(drawingDigest(array));
  });

  it('keeps no mesh or geometry array of an added batch', async () => {
    const { config } = streamConfigs()[1];
    const handed: object[] = [];
    const session = new Drawing2DGenerator().beginDrawing(config, STREAM_OPTIONS);
    for (const mesh of streamScene()) { handed.push(mesh, mesh.positions, mesh.indices); await session.addGeometry([mesh]); }
    session.endGeometry();
    for (const mesh of streamScene()) { handed.push(mesh, mesh.positions, mesh.indices); session.addOcclusion([mesh]); }
    const kept = reachable(session);
    expect(handed.filter((object) => kept.has(object))).toEqual([]);
    const drawn = reachable(session.finish());
    expect(handed.filter((object) => drawn.has(object))).toEqual([]);
  });

  it('enforces its phases, and a cancelled or aborted session refuses further batches', async () => {
    const { config } = streamConfigs()[0];
    const session = new Drawing2DGenerator().beginDrawing(config, STREAM_OPTIONS);
    expect(() => session.addOcclusion(streamScene())).toThrow(/geometry phase/);
    await session.addGeometry(streamScene());
    session.endGeometry();
    await expect(session.addGeometry(streamScene())).rejects.toThrow(/occlusion phase/);
    session.cancel();
    expect(() => session.finish()).toThrow(/cancelled/);
    const controller = new AbortController();
    const aborted = new Drawing2DGenerator().beginDrawing(config, { ...STREAM_OPTIONS, signal: controller.signal });
    controller.abort(new Error('superseded'));
    await expect(aborted.addGeometry(streamScene())).rejects.toThrow('superseded');
  });
});

describe('open surfaces: free-edge replay and multi-material shells (#10892 review)', () => {
  const plan = () => streamConfigs().find((c) => c.name === 'plan')!.config;
  const cutOnly = { ...STREAM_OPTIONS, includeProjection: false };

  it('finish() refuses an open sheet whose replay was never fed, and the replay path still draws its free edges', async () => {
    const open = [sheet(5, 2, 6, 4, 2.5)];
    const skipped = new Drawing2DGenerator().beginDrawing(plan(), cutOnly);
    await skipped.addGeometry(open);
    expect(() => skipped.finish()).toThrow(/open-surface entities/);
    // Still usable: feeding what endGeometry asked for completes it.
    skipped.addOcclusion(open);
    const fed = skipped.finish();
    expect(fed.lines.some((line) => line.openSurfaceCut)).toBe(true);
    const array = await new Drawing2DGenerator().generate(open, plan(), cutOnly);
    expect(drawingDigest(fed)).toBe(drawingDigest(array));
  });

  it('an abort while finish() runs (from its progress callback at polygons/0) returns no drawing', async () => {
    const controller = new AbortController();
    const onProgress = (stage: string, progress: number) => { if (stage === 'polygons' && progress === 0) controller.abort(new Error('superseded')); };
    const session = new Drawing2DGenerator().beginDrawing(plan(), { ...cutOnly, signal: controller.signal, onProgress });
    await session.addGeometry([box(1, [0, 0, 0], [4, 3, 0.3])]);
    expect(() => session.finish()).toThrow('superseded');
  });

  it('finish() refuses a depth raster whose occlusion phase was never fed', async () => {
    const session = new Drawing2DGenerator().beginDrawing(plan(), STREAM_OPTIONS);
    await session.addGeometry(streamScene());
    expect(session.endGeometry().depthRaster).toBe(true);
    expect(() => session.finish()).toThrow(/occlusion phase/);
  });

  // Recorded by main's PRE-session generator (89b9ba6, `generate` over the same meshes): each layer's cut is an open
  // chain, but free-edge and chain-end detection are both per entity there too, so the entity-wide loop closes.
  const mainDigests = {
    corner: 'f3f41ca6c90bbd32ade8d45c676e2f07bc5f51f673e452673750255a8bfb1c63',
    midwall: '970c76f49c2601bbdcb9348567f2fec2b8a128c9090beab1b3a271aa5870e297',
  };
  for (const split of ['corner', 'midwall'] as const) {
    it(`a two-material open shell (${split} split) draws exactly as main's pre-session generator, in any batching`, async () => {
      const shell = multiMaterialShell(split);
      const array = await new Drawing2DGenerator().generate(shell, plan(), STREAM_OPTIONS);
      expect(drawingDigest(array)).toBe(mainDigests[split]);
      expect(array.cutPolygons).toHaveLength(2);
      expect(array.lines.some((line) => line.openSurfaceCut)).toBe(false);
      // One layer per batch: the layers' chains only close across batches.
      const { source } = leasingSource(shell, 1);
      expect(drawingDigest(await new Drawing2DGenerator().generateFromSource(source, plan(), STREAM_OPTIONS))).toBe(mainDigests[split]);
    });
  }
});
