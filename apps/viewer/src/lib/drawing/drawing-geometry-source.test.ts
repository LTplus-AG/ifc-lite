/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The drawing over released geometry (#10264), through a real backing in
 * IndexedDB (fake-indexeddb), the real generator and the renderer's own shard
 * materialization, checked against an INDEPENDENT oracle: the array
 * generator over the complete resident model, whose instanced occurrences
 * are expanded here by hand from the shard's matrices.
 */

import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { DecodedInstancedShard, MeshData } from '@ifc-lite/geometry';
import { Drawing2DGenerator, createSectionConfig, type Drawing2D, type SectionConfig } from '@ifc-lite/drawing-2d';
import { releaseCpuMeshBuffers } from '@/lib/geometry-cpu-release';
import { placedMesh } from '@/lib/model-placement/placed-geometry';
import type { Translation } from '@/lib/model-placement/translation';
import { GeometryBackingRegistry, type ModelGeometryBacking } from '@/lib/geometry-backing/geometry-backing-registry';
import { GeometryUnavailableError } from '@/lib/geometry-backing/geometry-readback';
import { StaleGeometryGenerationError } from '@/lib/geometry-backing/backing-reader';
import { DrawingGeometry, type DrawingGeometryDeps, type InstancedScene } from './drawing-geometry-source';
import type { DrawingMeshFilter } from './drawing-mesh-filter';

let names = 0;
const database = () => ({ name: `drawing-source-${process.pid}-${names++}`, locks: null });

type V3 = [number, number, number];
function box(expressId: number, modelIndex: number, min: V3, max: V3, ifcType = 'IfcWall'): MeshData {
  const [x0, y0, z0] = min, [x1, y1, z1] = max;
  const positions = new Float32Array([x0, y0, z0, x1, y0, z0, x1, y1, z0, x0, y1, z0, x0, y0, z1, x1, y0, z1, x1, y1, z1, x0, y1, z1]);
  const indices = new Uint32Array([0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 3, 7, 6, 3, 6, 2, 0, 4, 7, 0, 7, 3, 1, 2, 6, 1, 6, 5]);
  return { expressId, modelIndex, ifcType, positions, normals: new Float32Array(positions.length), indices, color: [0.7, 0.7, 0.7, 1] };
}

/** One IFC Z-up template (a 1 × 1 × 2 m post at origin `o`), four occurrences: translated, rotated, translucent. */
function shard(ids: [number, number, number, number], dx: number): DecodedInstancedShard {
  const o: V3 = [0.25, 0.25, 0];
  const corners = [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0], [0, 0, 2], [1, 0, 2], [1, 1, 2], [0, 1, 2]];
  const positions = Float32Array.from(corners.flatMap((c) => [c[0] - o[0], c[1] - o[1], c[2] - o[2]]));
  const indices = Uint32Array.from([0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 3, 7, 6, 3, 6, 2, 0, 4, 7, 0, 7, 3, 1, 2, 6, 1, 6, 5]);
  const rowMajor = (m: number[]) => Float32Array.from(m);
  return {
    templates: [{ positions, normals: new Float32Array(positions.length), indices, origin: o }],
    instances: [
      { templateIndex: 0, entityId: ids[0], color: [0.2, 0.3, 0.4, 1], transform: rowMajor([1, 0, 0, 2 + dx, 0, 1, 0, -3, 0, 0, 1, 0, 0, 0, 0, 1]) },
      { templateIndex: 0, entityId: ids[1], color: [0.2, 0.3, 0.4, 1], transform: rowMajor([0, -1, 0, 5 + dx, 1, 0, 0, -6, 0, 0, 1, 0, 0, 0, 0, 1]) },
      { templateIndex: 0, entityId: ids[2], color: [0.2, 0.3, 0.4, 1], transform: rowMajor([1, 0, 0, 7 + dx, 0, 1, 0, -2, 0, 0, 1, 0, 0, 0, 0, 1]) },
      // Translucent: the flat transparent pipeline's, never an instanced piece.
      { templateIndex: 0, entityId: ids[3], color: [0.2, 0.3, 0.4, 0.3], transform: rowMajor([1, 0, 0, 3 + dx, 0, 1, 0, -1, 0, 0, 1, 0, 0, 0, 0, 1]) },
    ],
    carriesItemIds: false,
  };
}

/** The oracle's own expansion: world(Z-up) = M · (origin + p), then Y-up (x, z, −y). */
function expandByHand(s: DecodedInstancedShard, modelIndex: number, ifcType: string): MeshData[] {
  return s.instances.filter((inst) => inst.color[3] >= 1).map((inst) => {
    const tpl = s.templates[inst.templateIndex], m = inst.transform, out = new Float32Array(tpl.positions.length);
    for (let i = 0; i < out.length; i += 3) {
      const p = [tpl.positions[i] + tpl.origin[0], tpl.positions[i + 1] + tpl.origin[1], tpl.positions[i + 2] + tpl.origin[2]];
      const w = [0, 1, 2].map((r) => m[r * 4] * p[0] + m[r * 4 + 1] * p[1] + m[r * 4 + 2] * p[2] + m[r * 4 + 3]);
      out.set([w[0], w[2], -w[1]], i);
    }
    return { expressId: inst.entityId, modelIndex, ifcType, positions: out, normals: new Float32Array(out.length), indices: tpl.indices, color: inst.color };
  });
}

/** Order-free, exact-to-1e-4 view of what a drawing draws. */
function canonical(d: Drawing2D): { lines: string[]; polygons: string[]; stats: unknown } {
  const r = (v: number) => (Math.round(v * 1e4) / 1e4 + 0).toFixed(4);
  const pt = (p: { x: number; y: number }) => `${r(p.x)},${r(p.y)}`;
  // A ring keeps its connectivity: canonical start (smallest vertex) and direction, never sorted vertices.
  const ring = (pts: Array<{ x: number; y: number }>) => {
    let s = pts.map(pt); if (s.length > 1 && s[0] === s[s.length - 1]) s = s.slice(0, -1);
    const min = [...s].sort()[0]; const forms: string[] = [];
    for (const a of [s, [...s].reverse()]) a.forEach((v, i) => { if (v === min) forms.push([...a.slice(i), ...a.slice(0, i)].join(' ')); });
    return forms.sort()[0] ?? '';
  };
  const lines = d.lines.map((l) => [l.category, l.visibility, l.entityId, l.modelIndex, l.ifcType, l.openSurfaceCut ?? false,
    [pt(l.line.start), pt(l.line.end)].sort().join(' ')].join('|')).sort();
  const polygons = [...d.cutPolygons.map((p) => ['cut', p] as const), ...(d.layerBaseCutPolygons ?? []).map((p) => ['base', p] as const)].map(([from, p]) => [from, p.entityId, p.modelIndex, p.ifcType,
    ring(p.polygon.outer), p.polygon.holes.map(ring).sort().join('/')].join('|')).sort();
  const { processingTimeMs: _t, ...stats } = d.stats;
  return { lines, polygons, stats };
}

// 103/203 are filtered out by class (keepAll drops IfcWindow); 104/204 are translucent and pass the filter.
const TYPES = new Map([[101, 'IfcColumn'], [102, 'IfcColumn'], [103, 'IfcWindow'], [104, 'IfcColumn'],
  [201, 'IfcColumn'], [202, 'IfcColumn'], [203, 'IfcWindow'], [204, 'IfcColumn']]);
const MODELS = { a: { index: 0 }, b: { index: 1 } } as const;
const PLACEMENT: Record<string, Translation> = { a: [0, 0, 0], b: [20, 0, 0] };

function flatModel(id: 'a' | 'b'): MeshData[] {
  const m = MODELS[id].index, o = m * 210;
  return [box(o + 1, m, [0, 0, 0], [10, 3, 0.3]), box(o + 2, m, [0, 0, 0.3], [0.3, 3, 8]),
    box(o + 3, m, [2, 0, 4], [6, 1.2, 4.4], 'IfcFurnishingElement'), box(o + 4, m, [0, -0.3, 0], [10, 0, 8], 'IfcSlab')];
}

const modelOf = (globalId: number) => (globalId < 200 ? 'a' : 'b');

interface World {
  merged: MeshData[]; shards: Record<'a' | 'b', DecodedInstancedShard>;
  registry: GeometryBackingRegistry; backings: Map<string, ModelGeometryBacking>;
}

async function world(decodedCacheBytes = 1024): Promise<World> {
  const shards = { a: shard([101, 102, 103, 104], 0), b: shard([201, 202, 203, 204], 0) };
  const registry = await GeometryBackingRegistry.open(database());
  const backings = new Map<string, ModelGeometryBacking>();
  const merged: MeshData[] = [];
  for (const id of ['a', 'b'] as const) {
    // A federated model's own list need not carry its index; the merged copies do.
    const store = flatModel(id).map(({ modelIndex: _index, ...mesh }) => mesh);
    const backing = await registry.begin(id, { chunkBytes: 512, queueBytes: 1 << 16, decodedCacheBytes });
    await backing.writer.append(store);
    await backing.writer.appendInstancedShard(shards[id]);
    await backing.writer.close();
    backings.set(id, backing);
    // The merged list is placed view geometry over the model's own arrays.
    merged.push(...store.map((mesh) => placedMesh({ ...mesh, modelIndex: MODELS[id].index }, PLACEMENT[id])));
  }
  return { merged, shards, registry, backings };
}

/** The resident scene: occurrences already placed, as the renderer keeps them. */
function residentScene(w: World): InstancedScene {
  const pieces = new Map<number, MeshData[]>();
  for (const id of ['a', 'b'] as const) {
    for (const piece of expandByHand(w.shards[id], MODELS[id].index, '')) {
      pieces.set(piece.expressId, [...(pieces.get(piece.expressId) ?? []), placedMesh(piece, PLACEMENT[id])]);
    }
  }
  return { getInstancedEntityIds: () => pieces.keys(), getInstancedMeshDataPieces: (id) => pieces.get(id) };
}

function deps(w: World, overrides: Partial<DrawingGeometryDeps> = {}): DrawingGeometryDeps {
  return {
    modelOf, visibleModels: ['a', 'b'], modelIndexOf: (id) => MODELS[id as 'a' | 'b'].index,
    translationFor: (id) => PLACEMENT[id], typeOf: (id) => TYPES.get(id), scene: residentScene(w),
    instancedReleased: false, hasInstanced: () => true, backing: (id) => w.backings.get(id), isCurrent: () => true, ...overrides,
  };
}

const OPTIONS = { useGPU: false, includeProjection: true, includeEdges: true, includeHiddenLines: true, mergeLines: true } as const;
const keepAll: DrawingMeshFilter = (mesh) => mesh.ifcType !== 'IfcWindow';
const CONFIGS: Array<[string, SectionConfig]> = [
  ['plan', createSectionConfig('y', 1, { projectionDepth: 3 })],
  ['front', createSectionConfig('z', 4.2, { projectionDepth: 6 })],
];

/** The oracle: the array generator over the complete placed resident model. */
async function oracle(w: World, config: SectionConfig): Promise<Drawing2D> {
  const occurrences = (['a', 'b'] as const).flatMap((id) => expandByHand(w.shards[id], MODELS[id].index, '')
    .map((piece) => placedMesh({ ...piece, ifcType: TYPES.get(piece.expressId) }, PLACEMENT[id])));
  return new Drawing2DGenerator().generate([...w.merged, ...occurrences].filter(keepAll), config, OPTIONS);
}

/** The store arrays are freed; only the backing still holds the geometry. */
function release(w: World): void {
  releaseCpuMeshBuffers(w.merged);
}

/** Counts the backing reads a drawing holds at once. */
function watchLeases(backing: ModelGeometryBacking) {
  const stats = { live: 0, peak: 0, chunks: 0 };
  const original = backing.reader.meshes.bind(backing.reader);
  backing.reader.meshes = async function* (options) {
    for await (const chunk of original(options)) {
      stats.live++; stats.peak = Math.max(stats.peak, stats.live); stats.chunks++;
      try { yield chunk; } finally { stats.live--; }
    }
  };
  return stats;
}

describe('drawing geometry source over released geometry', () => {
  for (const [name, config] of CONFIGS) {
    it(`${name}: resident and released drawings both equal the independent complete-model oracle`, async () => {
      const w = await world(0); // no decoded cache: every released lease leaves no retained bytes
      const expected = canonical(await oracle(w, config));
      assert.ok(expected.lines.some((line) => line.includes('IfcColumn')), 'the oracle must draw instanced occurrences');
      // Checked on every drawing below, not only on the oracle.
      const drawnIds = (d: Drawing2D) => new Set([...d.lines.map((l) => l.entityId), ...d.cutPolygons.map((p) => p.entityId)]);
      const assertOccurrences = (d: Drawing2D, label: string) => {
        const ids = drawnIds(d);
        assert.ok(ids.has(101) && ids.has(201), `${label}: opaque occurrences of both models are drawn`);
        for (const id of [103, 203]) assert.ok(!ids.has(id), `${label}: class-filtered occurrence ${id} is not drawn`);
        for (const id of [104, 204]) assert.ok(!ids.has(id), `${label}: translucent occurrence ${id} is not instanced geometry`);
      };

      const resident = new DrawingGeometry(w.merged, deps(w));
      assert.equal(resident.released, false);
      const residentDrawing = await new Drawing2DGenerator().generateFromSource(resident.source(keepAll, { instanced: true }), config, OPTIONS);
      assertOccurrences(residentDrawing, 'resident');
      assert.deepEqual(canonical(residentDrawing), expected);

      release(w);
      assert.ok(w.merged.every((mesh) => mesh.positions.length === 0), 'the store arrays are released');
      const leases = [...w.backings.values()].map(watchLeases);
      const released = new DrawingGeometry(w.merged, deps(w, { scene: null, instancedReleased: true }));
      assert.equal(released.released, true);
      const releasedDrawing = await new Drawing2DGenerator().generateFromSource(released.source(keepAll, { instanced: true }), config, OPTIONS);
      assertOccurrences(releasedDrawing, 'released');
      assert.deepEqual(canonical(releasedDrawing), expected);
      for (const stats of leases) {
        assert.ok(stats.chunks > 1, 'each model streams several chunks');
        assert.equal(stats.peak, 1, 'one chunk lease at a time');
        assert.equal(stats.live, 0);
      }
      for (const backing of w.backings.values()) assert.equal(backing.reader.retainedBytes, 0, 'every decoded chunk lease was released');
      await w.registry.close();
    });
  }

  it('refuses a released model without a complete current backing', async () => {
    const w = await world();
    release(w);
    assert.throws(() => new DrawingGeometry(w.merged, deps(w, { backing: (id) => (id === 'b' ? undefined : w.backings.get(id)) })),
      GeometryUnavailableError);
    await w.registry.invalidate('a');
    assert.throws(() => new DrawingGeometry(w.merged, deps(w)), GeometryUnavailableError);
    await w.registry.close();
  });

  it('rejects a drawing whose generation is replaced while it reads, and never draws it', async () => {
    const w = await world();
    release(w);
    const geometry = new DrawingGeometry(w.merged, deps(w, { scene: null, instancedReleased: true }));
    const original = w.backings.get('b')!.reader.meshes.bind(w.backings.get('b')!.reader);
    w.backings.get('b')!.reader.meshes = async function* (options) {
      let first = true;
      for await (const chunk of original(options)) {
        yield chunk;
        // A content-version bump starts a new generation of model b mid-read.
        if (first) { first = false; await w.registry.begin('b'); }
      }
    };
    await assert.rejects(new Drawing2DGenerator().generateFromSource(geometry.source(keepAll, { instanced: true }), CONFIGS[0][1], OPTIONS),
      StaleGeometryGenerationError);
    await w.registry.close();
  });

  it('rejects a drawing whose earlier model is replaced after its read returned, while a later model reads', async () => {
    const w = await world();
    release(w);
    const geometry = new DrawingGeometry(w.merged, deps(w, { scene: null }));
    const original = w.backings.get('b')!.reader.meshes.bind(w.backings.get('b')!.reader);
    let reads = 0;
    w.backings.get('b')!.reader.meshes = async function* (options) {
      // In the last (occlusion) pass, after model a's read returned: no later read of a would notice.
      let first = ++reads === 2;
      for await (const chunk of original(options)) { yield chunk; if (first) { first = false; await w.registry.begin('a'); } }
    };
    await assert.rejects(new Drawing2DGenerator().generateFromSource(geometry.source(keepAll, { instanced: false }), CONFIGS[0][1], OPTIONS),
      GeometryUnavailableError);
    assert.equal(reads, 2, 'the replacement happened in the last pass');
    await w.registry.close();
  });

  it('aborts a superseded drawing before its next batch, releasing the lease', async () => {
    const w = await world(0); // no decoded cache: a released lease leaves no retained bytes
    release(w);
    let current = true;
    const stats = watchLeases(w.backings.get('a')!);
    const geometry = new DrawingGeometry(w.merged, deps(w, { scene: null, instancedReleased: true, isCurrent: () => current }));
    const source = geometry.source(keepAll, { instanced: true });
    const watched = { async *pass(pass: 'geometry' | 'occlusion') {
      for await (const batch of source.pass(pass)) { yield batch; if (stats.chunks === 2) current = false; }
    } };
    await assert.rejects(new Drawing2DGenerator().generateFromSource(watched, CONFIGS[0][1], OPTIONS), { name: 'AbortError' });
    assert.equal(stats.chunks, 2);
    assert.equal(stats.live, 0);
    assert.equal(w.backings.get('a')!.reader.retainedBytes, 0);
    await w.registry.close();
  });

  it('rejects a backing that does not hold exactly the model meshes', async () => {
    const w = await world();
    const extra = await w.registry.begin('a', { chunkBytes: 512 });
    await extra.writer.append(flatModel('a').slice(0, -1)); // a matching prefix: only the count check can refuse it
    await extra.writer.appendInstancedShard(w.shards.a);
    await extra.writer.close();
    w.backings.set('a', extra);
    release(w);
    const geometry = new DrawingGeometry(w.merged, deps(w, { scene: null, instancedReleased: true }));
    const count = flatModel('a').length;
    await assert.rejects(new Drawing2DGenerator().generateFromSource(geometry.source(keepAll, { instanced: true }), CONFIGS[0][1], OPTIONS),
      { name: 'GeometryUnavailableError', message: `Model a's backing holds ${count - 1} meshes, the model ${count}` });
    await w.registry.close();
  });

  it('a resident drawing with nothing released asks no per-mesh ownership', async () => {
    const w = await world();
    let asked = 0;
    const geometry = new DrawingGeometry(w.merged, deps(w, { modelOf: (id) => { asked++; return modelOf(id); } }));
    assert.equal(geometry.released, false);
    assert.equal(asked, 0);
    await w.registry.close();
  });

  it('answers emptiness from metadata alone, instanced ids included', async () => {
    const w = await world();
    release(w);
    const geometry = new DrawingGeometry(w.merged, deps(w, { scene: null, instancedReleased: true }));
    assert.equal(geometry.isEmpty(() => false, { instanced: true }), true);
    assert.equal(geometry.isEmpty((mesh) => mesh.expressId === 202, { instanced: true }), false);
    assert.equal(geometry.isEmpty((mesh) => mesh.expressId === 202, { instanced: false }), true);
    await w.registry.close();
  });

  it('refuses backed geometry whose ids resolve to another model, and scene ids without pieces', async () => {
    const w = await world();
    // Model b's backing replaced by one holding model a's (local-range) ids.
    const foreign = await w.registry.begin('b', { chunkBytes: 512 });
    await foreign.writer.append(flatModel('a').map(({ modelIndex: _index, ...mesh }) => mesh));
    await foreign.writer.appendInstancedShard(w.shards.b);
    await foreign.writer.close();
    w.backings.set('b', foreign);
    release(w);
    const geometry = new DrawingGeometry(w.merged, deps(w, { scene: null, instancedReleased: true }));
    await assert.rejects(new Drawing2DGenerator().generateFromSource(geometry.source(keepAll, { instanced: true }), CONFIGS[0][1], OPTIONS),
      /not in its global id range/);
    const listedOnly: InstancedScene = { getInstancedEntityIds: () => [101][Symbol.iterator](), getInstancedMeshDataPieces: () => undefined };
    const resident = new DrawingGeometry([], deps(w, { scene: listedOnly }));
    await assert.rejects(new Drawing2DGenerator().generateFromSource(resident.source(keepAll, { instanced: true }), CONFIGS[0][1], OPTIONS),
      /no resident occurrence geometry/);
    await w.registry.close();
  });

  it('refuses a released model whose backing lost the instanced shards it streamed', async () => {
    const w = await world();
    const flatOnly = await w.registry.begin('a', { chunkBytes: 512 });
    await flatOnly.writer.append(flatModel('a').map(({ modelIndex: _index, ...mesh }) => mesh));
    await flatOnly.writer.close();
    w.backings.set('a', flatOnly);
    release(w);
    assert.throws(() => new DrawingGeometry(w.merged, deps(w, { scene: null, instancedReleased: true })),
      /streamed instanced geometry its backing does not hold/);
    // A model that never had instancing needs no shards.
    assert.doesNotThrow(() => new DrawingGeometry(w.merged, deps(w, { scene: null, instancedReleased: true,
      hasInstanced: (id) => id !== 'a' })));
    // A backing holding some shards but not every listed entity is refused too.
    const partial = await w.registry.begin('a', { chunkBytes: 512 });
    await partial.writer.append(flatModel('a').map(({ modelIndex: _index, ...mesh }) => mesh));
    await partial.writer.appendInstancedShard(shard([101, 102, 103, 104], 0));
    await partial.writer.close();
    w.backings.set('a', partial);
    assert.throws(() => new DrawingGeometry(w.merged, deps(w, { scene: null, instancedReleased: true, listedInstanced: () => [101, 102, 105] })),
      /Instanced entity 105 of model a is in no backed shard/);
    assert.doesNotThrow(() => new DrawingGeometry(w.merged, deps(w, { scene: null, instancedReleased: true, listedInstanced: () => [101, 102] })));
    await w.registry.close();
  });

  it('refuses a backing whose meshes are not the store list, even at equal count and ownership', async () => {
    const w = await world();
    // Same count, every id model a's, but the second mesh is another entity (#5, not #2).
    const swapped = flatModel('a').map(({ modelIndex: _index, ...mesh }) => mesh);
    swapped[1] = { ...swapped[1], expressId: 5 };
    const other = await w.registry.begin('a', { chunkBytes: 512 });
    await other.writer.append(swapped);
    await other.writer.appendInstancedShard(w.shards.a);
    await other.writer.close();
    w.backings.set('a', other);
    release(w);
    const geometry = new DrawingGeometry(w.merged, deps(w, { scene: null, instancedReleased: true }));
    await assert.rejects(new Drawing2DGenerator().generateFromSource(geometry.source(keepAll, { instanced: true }), CONFIGS[0][1], OPTIONS),
      /backed mesh 1 \(#5\) is not its current mesh #2/);
    await w.registry.close();
  });

  it('r4645106680 a released drawing reads back only the occurrences the scene lists, as its resident drawing cuts', async () => {
    const w = await world();
    release(w);
    // The backings hold 101/102 and 201/202, but the scene lists only 101 and 201 (102/202 never reached it).
    const released = new DrawingGeometry(w.merged, deps(w, { scene: null, instancedReleased: true, listedInstanced: () => [101, 201] }));
    const columns = (mesh: { expressId: number }) => mesh.expressId % 100 > 0 && mesh.expressId % 100 < 5 && mesh.expressId > 100; // instanced ids only
    const ids = new Set<number>();
    for await (const batch of released.source(columns, { instanced: true }).pass('geometry')) for (const mesh of batch) ids.add(mesh.expressId);
    assert.deepEqual([...ids].sort(), [101, 201], 'never an occurrence the resident drawing does not cut');
    await w.registry.close();
  });

  it('released emptiness counts only occurrences a route draws, like the resident scene list', async () => {
    const w = await world();
    release(w);
    // Isolating only the translucent 104: no route materializes it, so the drawing is empty in both.
    const only104 = (mesh: { expressId: number }) => mesh.expressId === 104;
    const released = new DrawingGeometry(w.merged, deps(w, { scene: null, instancedReleased: true, listedInstanced: () => [101, 102, 103, 201, 202, 203] }));
    assert.equal(released.isEmpty(only104, { instanced: true }), true);
    assert.equal(released.isEmpty((mesh) => mesh.expressId === 101, { instanced: true }), false);
    await w.registry.close();
  });
});
