// SPDX-License-Identifier: MPL-2.0
import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile, mkdir, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { exportCommand, exportFilePath } from './export.js';
import { exportKernel, retainedArtifacts } from './export-retained.js';
import { requireRetainedNode, validateEngine, type RetainedEngine } from '../retained/engine.js';
import { runRetained } from '../retained/run.js';
import { retainedReport, reportJson } from '../retained/report.js';
import { buildHelp, buildCommandHelp } from '../help.js';
import type { RetainedShapeProduct } from '../../../wasm/pkg-retained/ifc-lite.js';

const dirs: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
const engine: RetainedEngine = { directory: '/unused', url: new URL('file:///unused/'), sdk: 'protocol-test', capabilities: null, manifestSha256: '0'.repeat(64) };
const shape: RetainedShapeProduct = { status: 'published', cuts: 0, consumedParts: 0, expressId: 27, ifcType: 'IfcBuildingElementProxy', marker: 'PresentationObligationsUnmet', obligationsUnmet: ['IfcAppearance'],
  parts: [{ positions: Float64Array.of(0, 0, 0, 1, 0, 0, 0, 1, 0), indices: Uint32Array.of(0, 1, 2),
    worldFromObject: Float64Array.of(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 10, 20, 30, 1), curved: false }] };

it('#7955 M11-I reports instance candidates while every OBJ occurrence stays baked', () => {
  const key = '1'.repeat(64);
  const products = Array.from({ length: 64 }, (_, expressId) => ({ ...shape, expressId, instanceKey: key }));
  const grouped = retainedArtifacts(engine, 8, products, () => null);
  const flat = retainedArtifacts(engine, 8, products.map(({ instanceKey: _key, ...p }) => p), () => null);
  expect(grouped.obj).toBe(flat.obj);
  expect(grouped.report.products).toHaveLength(64);
  for (const product of grouped.report.products) expect(product).toHaveProperty('instanceGroup', { templateProductId: 0, key });
  const below = retainedReport(engine, 8, products.slice(0, 7), () => null);
  for (const product of below.products) expect(product).not.toHaveProperty('instanceGroup');
});

it.each([3, 11])('#7955 PR #8299 groups at the engine-provided threshold %i', threshold => {
  const key = '2'.repeat(64);
  const products = Array.from({ length: threshold + 1 }, (_, expressId) => ({ ...shape, expressId, instanceKey: key }));
  for (const count of [threshold - 1, threshold, threshold + 1]) {
    const report = retainedReport(engine, threshold, products.slice(0, count), () => null);
    for (const product of report.products) {
      if (count < threshold) expect(product).not.toHaveProperty('instanceGroup');
      else expect(product).toHaveProperty('instanceGroup', { templateProductId: 0, key });
    }
  }
});

it('#7955 validates kernel arguments before touching input or output', async () => {
  vi.stubEnv('IFCLITE_RETAINED_ENGINE', undefined);
  const dir = await mkdtemp(join(tmpdir(), 'retained-fatal-')); dirs.push(dir);
  for (const flags of [['--kernel', 'other'], ['--kernel'], ['--kernel', 'retained', '--format', 'obj'], ['--kernel', 'retained', '--format', 'csv'],
    ['--kernel', 'retained', '--format', 'obj', '--retained-engine', join(dir, 'missing')],
    ['--retained-engine', dir], ['--retained-report']]) {
    await expect(exportCommand([join(dir, 'missing.ifc'), ...flags, '--out', join(dir, 'out.obj')])).rejects.toThrow();
    expect(await readdir(dir)).toEqual([]);
  }
  expect(await exportKernel([], 'obj')).toBeUndefined();
  expect(await exportKernel(['--kernel', 'exact'], 'obj')).toBeUndefined();
  expect(() => requireRetainedNode('20.5.1')).toThrow(/20.6/);
  expect(() => requireRetainedNode('20.6.0')).not.toThrow();
});

it('#7955 zero publication and a corrupt later part never produce artifacts', () => {
  expect(() => retainedArtifacts(engine, 8, [], () => null)).toThrow(/0 products/);
  expect(() => retainedArtifacts(engine, 8, [{ status: 'refused', expressId: 27, ifcType: shape.ifcType, code: 'incomplete' }], () => null)).toThrow(/0 products/);
  expect(() => retainedArtifacts(engine, 8, [{ ...shape, parts: [...shape.parts, { ...shape.parts[0], indices: Uint32Array.of(999, 1, 2) }] }], () => null)).toThrow(/partial product/);
});

it('#7955 shape-only OBJ transforms world f64 points to Y-up and keeps refusal origins', () => {
  const refusal = { status: 'refused' as const, expressId: 80, ifcType: shape.ifcType, code: 'material_layer_strategy' as const,
    origin: { site: 'product', entity: 80, cause: 'material' } };
  const { obj, report, json } = retainedArtifacts(engine, 8, [refusal, shape], id => `guid-${id}`);
  expect(obj).toContain('# PresentationObligationsUnmet');
  expect(obj).toContain('v 10.000000 30.000000 -20.000000');
  expect(obj).toContain('f 1 2 3');
  expect(obj).not.toContain('_80');
  expect(report.summary).toEqual({ candidates: 2, published: 1, coverage: 0.5, byCode: { material_layer_strategy: 1 } });
  expect(report.products.map(p => p.id)).toEqual([27, 80]);
  expect(report.products[1]).toMatchObject({ globalId: 'guid-80', code: refusal.code, origin: refusal.origin });
  expect(report.products[1]).not.toHaveProperty('parts');
  expect(json).toBe(reportJson(retainedReport(engine, 8, [shape, refusal], id => `guid-${id}`)));
  expect(buildHelp('test')).not.toContain('--kernel');
  expect(buildCommandHelp('test', 'export')).toContain('--retained-engine');
});

it('#7955 bad manifest hashes are fatal before engine imports or output writes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'retained-digest-')); dirs.push(dir);
  const paths = ['pkg-retained/ifc-lite.js', 'pkg-retained/ifc-lite_bg.wasm', 'pkg-retained/package.json',
    'smlib/node/client.mjs', 'smlib/node/worker.mjs', 'smlib/node/hooks.mjs', 'smlib/worker.mjs', 'smlib/module.mjs',
    'smlib/sweep.mjs', 'smlib/sweep-contract.mjs', 'smlib/contract.mjs',
    'smlib/ifclite_smlib_browser.mjs', 'smlib/ifclite_smlib_browser.wasm', 'LICENSES/SMLib/LICENSE',
    'LICENSES/SMLib/THIRD_PARTY_NOTICES.md', 'LICENSES/ifc-lite/LICENSE', 'THIRD_PARTY_NOTICES.txt'];
  const content = 'must never execute';
  const assets = [];
  for (const path of paths) {
    const value = path === 'pkg-retained/ifc-lite.js'
      ? 'not valid JavaScript; inventory validation must not execute this'
      : path === 'pkg-retained/package.json' ? '{"type":"module"}'
      : path === 'smlib/node/hooks.mjs' ? 'export {};' : content;
    await mkdir(join(dir, path, '..'), { recursive: true }); await writeFile(join(dir, path), value);
    assets.push({ path, bytes: value.length, sha256: createHash('sha256').update(value).digest('hex') });
  }
  await writeFile(join(dir, 'engine-manifest.json'), JSON.stringify({ format: 'ifc-lite.retained-engine/1', sdk: { revision: '0'.repeat(40) }, capabilities: null, assets }));
  // PR #8299: dev/preview servers validate inert assets without executing engine code.
  expect((await validateEngine(dir)).directory).toBe(dir);
  // Refs #7955: an internally consistent inventory still requires the root notice.
  const manifestBytes = await readFile(join(dir, 'engine-manifest.json'));
  const withoutNotice = JSON.parse(manifestBytes.toString());
  withoutNotice.assets = assets.filter(asset => asset.path !== 'THIRD_PARTY_NOTICES.txt');
  await rm(join(dir, 'THIRD_PARTY_NOTICES.txt'));
  await writeFile(join(dir, 'engine-manifest.json'), JSON.stringify(withoutNotice));
  await expect(validateEngine(dir)).rejects.toThrow(/inventory is incomplete \(missing: THIRD_PARTY_NOTICES\.txt\); re-stage the engine/);
  await writeFile(join(dir, 'THIRD_PARTY_NOTICES.txt'), content);
  await writeFile(join(dir, 'engine-manifest.json'), manifestBytes);
  vi.stubEnv('IFCLITE_RETAINED_ENGINE', dir);
  expect((await exportKernel(['--kernel', 'retained'], 'obj'))?.directory).toBe(dir);
  await writeFile(join(dir, paths[0]), 'tampered');
  await expect(exportCommand(['missing.ifc', '--format', 'obj', '--kernel', 'retained', '--retained-engine', dir,
    '--out', join(dir, 'out.obj'), '--retained-report', join(dir, 'report.json')])).rejects.toThrow(/hash mismatch/);
  await expect(readFile(join(dir, 'out.obj'))).rejects.toThrow();
  await expect(readFile(join(dir, 'report.json'))).rejects.toThrow();
});

it('#7955 PR #8299 rejects stale engine exports only when running the engine', async () => {
  // Refs #7955: an engine staged before the threshold export names the re-stage remedy.
  const stale = await mkdtemp(join(tmpdir(), 'retained-stale-')); dirs.push(stale);
  for (const path of ['pkg-retained/ifc-lite.js', 'pkg-retained/ifc-lite_bg.wasm', 'pkg-retained/package.json', 'smlib/node/hooks.mjs']) {
    const value = path === 'pkg-retained/ifc-lite.js' ? 'export default async function init() {}'
      : path === 'pkg-retained/package.json' ? '{"type":"module"}'
      : path === 'smlib/node/hooks.mjs' ? 'export {};' : 'unused';
    await mkdir(join(stale, path, '..'), { recursive: true }); await writeFile(join(stale, path), value);
  }
  await expect(runRetained({ ...engine, url: pathToFileURL(`${stale}/`) }, new Uint8Array())).rejects.toThrow(
    'Retained engine predates the instancing threshold export; re-stage the engine with the current scripts/stage-cli-retained-engine.mjs');
});

it('#7955 OBJ uses Rust fixed-six formatting, including exact ties and signed zero', () => {
  const part = { ...shape.parts[0], positions: Float64Array.of(1 / 128, 0, -1 / 128, 1, 0, 0, 0, 1, 0),
    worldFromObject: Float64Array.of(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1) };
  const { obj } = retainedArtifacts(engine, 8, [{ ...shape, parts: [part] }], () => null);
  expect(obj).toContain('v 0.007812 -0.007812 -0.000000');
});

it('reads the input path after value-taking flags', () => {
  expect(exportFilePath(['--kernel', 'retained', '--retained-engine', '/engine', 'model.ifc', '--format', 'obj']))
    .toBe('model.ifc');
  expect(exportFilePath(['--format', 'obj', 'model.ifc'])).toBe('model.ifc');
  expect(exportFilePath(['model.ifc', '--format', 'csv'])).toBe('model.ifc');
  expect(exportFilePath(['--format', 'obj'])).toBeUndefined();
});


it('#7955 M11-0 report emits optional channels and OBJ indexes per-corner normals across parts', () => {
  const part = { ...shape.parts[0], normals: Float64Array.of(0, 0, 1, 0, 0, 1, 0, 0, 1),
    color: [1, 0, 0, 1] as [number, number, number, number], materialName: 'surface', geometryItemId: 13,
    faces: { table: ['#13:cap(end)'], triangles: Uint32Array.of(0) } };
  const { obj, report } = retainedArtifacts(engine, 8, [{ ...shape, parts: [part, shape.parts[0], part],
    instanceKey: 'a'.repeat(64) }], () => null);
  expect(report.format).toBe('ifc-lite.retained-report/1');
  expect(obj).toContain('vn 0.000000 1.000000 -0.000000');
  expect(obj).toContain('f 1//1 2//2 3//3');
  expect(obj).toContain('f 4 5 6');
  expect(obj).toContain('f 7//4 8//5 9//6');
  const channels = { color: [1, 0, 0, 1], materialName: 'surface', geometryItemId: 13,
    normals: [0, 0, 1, 0, 0, 1, 0, 0, 1], faces: [{ key: '#13:cap(end)', triangles: 1, areaM2: 0.5 }] };
  const parts = (report.products[0] as unknown as { parts: Record<string, unknown>[] }).parts;
  expect(parts).toHaveLength(3);
  expect(parts[0]).toMatchObject(channels);
  expect(parts[2]).toMatchObject(channels);
  for (const key of ['color', 'materialName', 'geometryItemId', 'materialId', 'normals', 'faces']) {
    expect(parts[1]).not.toHaveProperty(key);
  }
  expect(report.products[0]).not.toHaveProperty('instanceGroup');
  expect(() => retainedArtifacts(engine, 8, [{ ...shape, parts: [{ ...part, normals: Float64Array.of(0, 0, 1) }] }], () => null)).toThrow(/corner normals/);
  const signed = retainedArtifacts(engine, 8, [{ ...shape, parts: [{ ...part, normals: Float64Array.of(-0, -0, 1, 0, -0, 1, -0, 0, 1) }] }], () => null);
  const written = (signed.report.products[0] as unknown as { parts: { normals: number[] }[] }).parts[0].normals;
  // JSON has no -0: a written -0 would not round-trip. Removing the `v + 0` canonicalisation fails here.
  expect(written.some(v => Object.is(v, -0))).toBe(false);
});
