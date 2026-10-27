// SPDX-License-Identifier: MPL-2.0
import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile, mkdir, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { exportCommand, exportFilePath } from './export.js';
import { exportKernel, retainedArtifacts } from './export-retained.js';
import { requireRetainedNode, validateEngine, type RetainedEngine } from '../retained/engine.js';
import { retainedReport, reportJson } from '../retained/report.js';
import { buildHelp, buildCommandHelp } from '../help.js';
import type { RetainedShapeProduct } from '../../../wasm/pkg-retained/ifc-lite.js';

const dirs: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
const engine: RetainedEngine = { directory: '/unused', url: new URL('file:///unused/'), sdk: 'protocol-test', capabilities: null, manifestSha256: '0'.repeat(64) };
const shape: RetainedShapeProduct = { status: 'published', expressId: 27, ifcType: 'IfcBuildingElementProxy', marker: 'PresentationObligationsUnmet', obligationsUnmet: ['IfcAppearance'],
  parts: [{ positions: Float64Array.of(0, 0, 0, 1, 0, 0, 0, 1, 0), indices: Uint32Array.of(0, 1, 2),
    worldFromObject: Float64Array.of(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 10, 20, 30, 1), curved: false }] };

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
  expect(() => retainedArtifacts(engine, [], () => null)).toThrow(/0 products/);
  expect(() => retainedArtifacts(engine, [{ status: 'refused', expressId: 27, ifcType: shape.ifcType, code: 'incomplete' }], () => null)).toThrow(/0 products/);
  expect(() => retainedArtifacts(engine, [{ ...shape, parts: [...shape.parts, { ...shape.parts[0], indices: Uint32Array.of(999, 1, 2) }] }], () => null)).toThrow(/partial product/);
});

it('#7955 shape-only OBJ transforms world f64 points to Y-up and keeps refusal origins', () => {
  const refusal = { status: 'refused' as const, expressId: 80, ifcType: shape.ifcType, code: 'material_layer_strategy' as const,
    origin: { site: 'product', entity: 80, cause: 'material' } };
  const { obj, report, json } = retainedArtifacts(engine, [refusal, shape], id => `guid-${id}`);
  expect(obj).toContain('# PresentationObligationsUnmet');
  expect(obj).toContain('v 10.000000 30.000000 -20.000000');
  expect(obj).toContain('f 1 2 3');
  expect(obj).not.toContain('_80');
  expect(report.summary).toEqual({ candidates: 2, published: 1, coverage: 0.5, byCode: { material_layer_strategy: 1 } });
  expect(report.products.map(p => p.id)).toEqual([27, 80]);
  expect(report.products[1]).toMatchObject({ globalId: 'guid-80', code: refusal.code, origin: refusal.origin });
  expect(report.products[1]).not.toHaveProperty('parts');
  expect(json).toBe(reportJson(retainedReport(engine, [shape, refusal], id => `guid-${id}`)));
  expect(buildHelp('test')).not.toContain('--kernel');
  expect(buildCommandHelp('test', 'export')).toContain('--retained-engine');
});

it('#7955 bad manifest hashes are fatal before engine imports or output writes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'retained-digest-')); dirs.push(dir);
  const paths = ['pkg-retained/ifc-lite.js', 'pkg-retained/ifc-lite_bg.wasm', 'pkg-retained/package.json',
    'smlib/node/client.mjs', 'smlib/node/worker.mjs', 'smlib/node/hooks.mjs', 'smlib/worker.mjs', 'smlib/module.mjs',
    'smlib/sweep.mjs', 'smlib/sweep-contract.mjs', 'smlib/contract.mjs',
    'smlib/ifclite_smlib_browser.mjs', 'smlib/ifclite_smlib_browser.wasm', 'LICENSES/SMLib/LICENSE',
    'LICENSES/SMLib/THIRD_PARTY_NOTICES.md', 'LICENSES/ifc-lite/LICENSE'];
  const content = 'must never execute';
  const assets = [];
  for (const path of paths) {
    await mkdir(join(dir, path, '..'), { recursive: true }); await writeFile(join(dir, path), content);
    assets.push({ path, bytes: content.length, sha256: createHash('sha256').update(content).digest('hex') });
  }
  await writeFile(join(dir, 'engine-manifest.json'), JSON.stringify({ format: 'ifc-lite.retained-engine/1', sdk: { revision: '0'.repeat(40) }, capabilities: null, assets }));
  await validateEngine(dir);
  vi.stubEnv('IFCLITE_RETAINED_ENGINE', dir);
  expect((await exportKernel(['--kernel', 'retained'], 'obj'))?.directory).toBe(dir);
  await writeFile(join(dir, paths[0]), 'tampered');
  await expect(exportCommand(['missing.ifc', '--format', 'obj', '--kernel', 'retained', '--retained-engine', dir,
    '--out', join(dir, 'out.obj'), '--retained-report', join(dir, 'report.json')])).rejects.toThrow(/hash mismatch/);
  await expect(readFile(join(dir, 'out.obj'))).rejects.toThrow();
  await expect(readFile(join(dir, 'report.json'))).rejects.toThrow();
});

it('#7955 OBJ uses Rust fixed-six formatting, including exact ties and signed zero', () => {
  const part = { ...shape.parts[0], positions: Float64Array.of(1 / 128, 0, -1 / 128, 1, 0, 0, 0, 1, 0),
    worldFromObject: Float64Array.of(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1) };
  const { obj } = retainedArtifacts(engine, [{ ...shape, parts: [part] }], () => null);
  expect(obj).toContain('v 0.007812 -0.007812 -0.000000');
});

it('reads the input path after value-taking flags', () => {
  expect(exportFilePath(['--kernel', 'retained', '--retained-engine', '/engine', 'model.ifc', '--format', 'obj']))
    .toBe('model.ifc');
  expect(exportFilePath(['--format', 'obj', 'model.ifc'])).toBe('model.ifc');
  expect(exportFilePath(['model.ifc', '--format', 'csv'])).toBe('model.ifc');
  expect(exportFilePath(['--format', 'obj'])).toBeUndefined();
});
