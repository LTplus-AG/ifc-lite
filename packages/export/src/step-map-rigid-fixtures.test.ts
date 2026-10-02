/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { beforeAll, describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { IfcParser, EntityExtractor, type IfcDataStore } from '@ifc-lite/parser';
import { SCHEMA_REGISTRY } from '@ifc-lite/codegen/ifc4';
import { isSubtypeOf } from '@ifc-lite/codegen';
import { GeometryProcessor, type GeometryResult, type MeshData } from '@ifc-lite/geometry';
import { renderFrameWorldOffset, viewerToIfcAxes } from '../../geometry/src/world-frame.js';
import { MutablePropertyView } from '@ifc-lite/mutations';
import { formatStepReal } from '@ifc-lite/data';
import { StepExporter } from './step-exporter.js';

type Point = [number, number, number];
const fixtures = [
  { path: 'ara3d/AC20-FZK-Haus.ifc', angle: 50, offset: [458870.0632856814, 5438773.629049492, 110] as Point, count: 127 },
  { path: 'georeferencer/MiniBIM-3.1-DO_01_VORM.ifc', angle: 15, offset: [90770, 435320, 3.5] as Point, count: 2668 },
];
const wasm = new URL('../../wasm/pkg/ifc-lite_bg.wasm', import.meta.url);
const required = process.env.IFC_LITE_REQUIRE_FIXTURES === '1';
async function parse(content: string | Uint8Array) {
  const bytes = typeof content === 'string' ? new TextEncoder().encode(content) : content;
  return new IfcParser().parseColumnar(bytes.slice().buffer as ArrayBuffer, { disableWorkerScan: true });
}
function attributes(store: IfcDataStore) {
  const extractor = new EntityExtractor(store.source);
  const cache = new Map<number, unknown[]>();
  return (id: number) => {
    let attrs = cache.get(id);
    if (!attrs) {
      const record = store.entityIndex.byId.get(id);
      if (!record) throw new Error(`Missing entity #${id}`);
      attrs = extractor.extractEntity(record)?.attributes;
      if (!attrs) throw new Error(`Unreadable entity #${id}`);
      cache.set(id, attrs);
    }
    return attrs;
  };
}
function ref(value: unknown): number {
  if (typeof value !== 'number') throw new Error('Expected an IFC entity reference');
  return value;
}
function vector(value: unknown): Point {
  if (!Array.isArray(value) || value.length < 3 || !value.slice(0, 3).every(v => typeof v === 'number')) throw new Error('Expected an IFC three-dimensional vector');
  return [Number(value[0]), Number(value[1]), Number(value[2])];
}
// These are original catalogued authoring-tool fixtures. Only the documented
// georeferencer-style map record is authored in memory, never fixture bytes.
function authorMap(source: string, store: IfcDataStore, fixture: typeof fixtures[number]) {
  const attrs = attributes(store);
  const c = Math.cos(fixture.angle * Math.PI / 180), s = Math.sin(fixture.angle * Math.PI / 180);
  const map = store.entityIndex.byType.get('IFCMAPCONVERSION')?.[0];
  const context = [...store.entityIndex.byId.values()].find(record => record.type === 'IFCGEOMETRICREPRESENTATIONCONTEXT' && attrs(record.expressId)[1] === 'Model')?.expressId;
  const unit = [...store.entityIndex.byId.values()].find(record => record.type === 'IFCSIUNIT' && attrs(record.expressId)[1] === '.LENGTHUNIT.' && attrs(record.expressId)[2] === null)?.expressId;
  if (!context || !unit) throw new Error('Real fixture must declare a Model context and metre project unit');
  const maximum = [...store.entityIndex.byId.keys()].reduce((maximum, id) => Math.max(maximum, id), 0);
  const crs = map ? ref(attrs(map)[1]) : maximum + 1;
  const id = map ?? maximum + 2;
  const line = `#${id}=IFCMAPCONVERSION(#${context},#${crs},${fixture.offset.map(formatStepReal).join(',')},${formatStepReal(c)},${formatStepReal(s)},1.);`;
  if (map) return source.replace(new RegExp(`#${map}\\s*=IFCMAPCONVERSION\\([^;]*;`, 'i'), line);
  const end = source.lastIndexOf('ENDSEC;');
  return source.slice(0, end) + `\n#${crs}=IFCPROJECTEDCRS('EPSG:32632',$,$,$,$,$,#${unit});\n${line}\n` + source.slice(end);
}
function transform(p: Point, angle: number, offset: Point): Point {
  const c = Math.cos(angle * Math.PI / 180), s = Math.sin(angle * Math.PI / 180);
  return [c * p[0] - s * p[1] + offset[0], s * p[0] + c * p[1] + offset[1], p[2] + offset[2]];
}
const sub = (a: Point, b: Point): Point => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Point, b: Point) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
function distanceToTriangle(p: Point, a: Point, b: Point, c: Point) {
  const ab = sub(b, a), ac = sub(c, a), ap = sub(p, a);
  const normal: Point = [ab[1] * ac[2] - ab[2] * ac[1], ab[2] * ac[0] - ab[0] * ac[2], ab[0] * ac[1] - ab[1] * ac[0]];
  const area = dot(normal, normal);
  if (area > 0) {
    const height = dot(ap, normal) / area;
    const q: Point = [p[0] - height * normal[0], p[1] - height * normal[1], p[2] - height * normal[2]];
    const aq = sub(q, a), d00 = dot(ab, ab), d01 = dot(ab, ac), d11 = dot(ac, ac);
    const denominator = d00 * d11 - d01 * d01;
    const u = (d11 * dot(aq, ab) - d01 * dot(aq, ac)) / denominator;
    const v = (d00 * dot(aq, ac) - d01 * dot(aq, ab)) / denominator;
    if (u >= -1e-9 && v >= -1e-9 && u + v <= 1 + 1e-9) return Math.abs(height) * Math.sqrt(area);
  }
  return Math.min(...[[a, b], [b, c], [c, a]].map(([start, end]) => {
    const edge = sub(end, start), length = dot(edge, edge);
    const t = length ? Math.max(0, Math.min(1, dot(sub(p, start), edge) / length)) : 0;
    return Math.hypot(...sub(p, [start[0] + t * edge[0], start[1] + t * edge[1], start[2] + t * edge[2]]));
  }));
}
function points(mesh: MeshData, result: GeometryResult): Point[] {
  const offset = renderFrameWorldOffset(result.coordinateInfo), origin = mesh.origin ?? [0, 0, 0];
  return Array.from({ length: mesh.positions.length / 3 }, (_, i) => {
    const p = viewerToIfcAxes({ x: mesh.positions[i * 3] + origin[0], y: mesh.positions[i * 3 + 1] + origin[1], z: mesh.positions[i * 3 + 2] + origin[2] });
    return [p.x + offset.x, p.y + offset.y, p.z + offset.z];
  });
}
function assertSurface(source: MeshData[], target: MeshData[], before: GeometryResult, after: GeometryResult, angle: number, offset: Point) {
  let maximumDistance = 0;
  const old = source.map(mesh => ({ mesh, points: points(mesh, before).map(p => transform(p, angle, offset)) }));
  const fresh = target.map(mesh => ({ mesh, points: points(mesh, after) }));
  expect(target.map(mesh => mesh.color).sort()).toEqual(source.map(mesh => mesh.color).sort());
  // Two-sided surface comparison tolerates legitimate re-triangulation, while
  // cut-face centroids catch a filled opening that vertex-only checks miss.
  for (const [from, to] of [[old, fresh], [fresh, old]]) {
    const triangles = to.flatMap(({ mesh, points }) => Array.from({ length: mesh.indices.length / 3 }, (_, i) => [points[mesh.indices[i * 3]], points[mesh.indices[i * 3 + 1]], points[mesh.indices[i * 3 + 2]]]));
    for (const { mesh, points } of from) {
      const centroids = Array.from({ length: mesh.indices.length / 3 }, (_, i): Point => {
        const a = points[mesh.indices[i * 3]], b = points[mesh.indices[i * 3 + 1]], c = points[mesh.indices[i * 3 + 2]];
        return [(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3, (a[2] + b[2] + c[2]) / 3];
      });
      for (const p of [...points, ...centroids]) maximumDistance = Math.max(maximumDistance, Math.min(...triangles.map(([a, b, c]) => distanceToTriangle(p, a, b, c))));
    }
  }
  expect(maximumDistance).toBeLessThan(.003);
  return maximumDistance;
}

describe('real authoring-tool fixtures through fresh canonical WASM (#6692)', () => {
  beforeAll(async () => {
    if (!existsSync(wasm)) return;
    const { initSync } = await import('@ifc-lite/wasm');
    initSync({ module: readFileSync(wasm) });
  });
  for (const fixture of fixtures) {
    const path = new URL(`../../../tests/models/${fixture.path}`, import.meta.url);
    const available = existsSync(path) && existsSync(wasm);
    if (!available && !required) console.warn(`SKIP #6692 ${fixture.path}: run pnpm fixtures and scripts/build-wasm.sh.`);
    it.skipIf(!available && !required)(`preserves authored ${fixture.angle} degree frames and cut/style surfaces in ${fixture.path}`, async () => {
      expect(existsSync(path), 'Required fixture absent: run pnpm fixtures').toBe(true);
      expect(existsSync(wasm), 'Required real WASM absent: run scripts/build-wasm.sh').toBe(true);
      const original = readFileSync(path, 'utf8');
      const source = authorMap(original, await parse(original), fixture);
      const store = await parse(source), get = attributes(store);
      const products = [...store.entityIndex.byId.values()].filter(record => isSubtypeOf(SCHEMA_REGISTRY, record.type, 'IfcProduct') && typeof get(record.expressId)[5] === 'number');
      expect(products.length).toBe(fixture.count);
      const view = new MutablePropertyView(store.properties ?? null, 'rigid-fixture');
      const edited = products[0].expressId;
      view.setAttribute(edited, 'Name', 'WASM rigid fixture edit', typeof get(edited)[2] === 'string' ? String(get(edited)[2]) : undefined);
      const options = { schema: 'IFC4', timeStamp: '2026-10-02T00:00:00' } as const;
      const ordinary = new StepExporter(store, view).export(options);
      const exported = await new StepExporter(store, view).exportAsync({ ...options, normalizeMapUnitsToMetres: true, normalizeMapGeometry: true });
      expect(exported.stats.warnings).toEqual([]);
      const output = await parse(exported.content), afterAttrs = attributes(output);
      expect(afterAttrs(edited)[2]).toBe('WASM rigid fixture edit');
      const mapId = store.entityIndex.byType.get('IFCMAPCONVERSION')?.[0];
      expect(mapId).toBeDefined();
      const sourceMap = get(ref(mapId)), outputMap = afterAttrs(ref(mapId));
      expect(outputMap.slice(2, 8)).toEqual([0, 0, 0, 1, 0, 1]);
      expect(outputMap.slice(0, 2)).toEqual(sourceMap.slice(0, 2));
      const sourceCRS = get(ref(sourceMap[1])), outputCRS = afterAttrs(ref(outputMap[1]));
      expect(outputCRS.slice(0, 6)).toEqual(sourceCRS.slice(0, 6));
      const mapUnit = afterAttrs(ref(outputCRS[6]));
      expect(mapUnit.slice(1, 4)).toEqual(['.LENGTHUNIT.', null, '.METRE.']);
      if (sourceCRS[6] !== null) expect(mapUnit).toEqual(get(ref(sourceCRS[6])));
      for (const product of products) {
        const before = get(product.expressId), after = afterAttrs(product.expressId);
        expect([after[0], after[5], after[6]]).toEqual([before[0], before[5], before[6]]);
      }
      let changedRoots = 0;
      for (const id of store.entityIndex.byType.get('IFCLOCALPLACEMENT') ?? []) {
        const placement = get(id), next = afterAttrs(id);
        if (placement[1] === next[1]) continue;
        expect(placement[0]).toBe(null);
        const oldFrame = get(ref(placement[1])), newFrame = afterAttrs(ref(next[1]));
        const expected = transform(vector(get(ref(oldFrame[0]))[0]), fixture.angle, fixture.offset);
        const actual = vector(afterAttrs(ref(newFrame[0]))[0]);
        expect(Math.hypot(...sub(expected, actual))).toBeLessThan(1e-7);
        const ratios = oldFrame[2] === null ? [1, 0, 0] as Point : vector(get(ref(oldFrame[2]))[0]);
        const length = Math.hypot(...ratios);
        expect(length).toBeGreaterThan(0);
        const oldX: Point = [ratios[0] / length, ratios[1] / length, ratios[2] / length];
        const expectedX = transform(oldX, fixture.angle, [0, 0, 0]);
        expect(Math.hypot(...sub(expectedX, vector(afterAttrs(ref(newFrame[2]))[0])))).toBeLessThan(1e-12);
        changedRoots++;
      }
      expect(changedRoots).toBeGreaterThan(0);
      const processor = new GeometryProcessor();
      try {
        await processor.init();
        const before = await processor.process(ordinary.content);
        const after = await processor.process(exported.content);
        expect([...new Set(after.meshes.map(mesh => mesh.expressId))].sort()).toEqual([...new Set(before.meshes.map(mesh => mesh.expressId))].sort());
        const representatives = [...new Set((store.entityIndex.byType.get('IFCRELVOIDSELEMENT') ?? []).map(id => ref(get(id)[4])))].filter(id => before.meshes.some(mesh => mesh.expressId === id)).slice(0, 3);
        const door = before.meshes.find(mesh => mesh.ifcType === 'IfcDoor');
        if (door) representatives.push(door.expressId);
        expect(representatives.length).toBeGreaterThan(0);
        const surfaces = representatives.map(id => ({ expressId: id, maximumDistanceMetres: assertSurface(before.meshes.filter(mesh => mesh.expressId === id), after.meshes.filter(mesh => mesh.expressId === id), before, after, fixture.angle, fixture.offset) }));
        console.info('#6692 fresh-WASM fixture oracle', JSON.stringify({ path: fixture.path, productCount: products.length, changedRoots, surfaces }));
      } finally { processor.dispose(); }
      expect(new StepExporter(store, view).export(options).content).toEqual(ordinary.content);
      expect(get(edited)[2]).not.toBe('WASM rigid fixture edit');
    }, 180_000);
  }
});
