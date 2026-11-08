/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { mkdtemp, readFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { GeometryProcessor } from '@ifc-lite/geometry';
import rhino3dm from 'rhino3dm';
import { exportCommand } from './export.js';
import { rhinoFlags } from './export-3dm.js';

const sample = fileURLToPath(new URL('../../../../apps/viewer/public/samples/hello-wall.ifc', import.meta.url));
let tmp: string;
beforeAll(async () => { tmp = await mkdtemp(join(tmpdir(), 'cli-rhino-')); });
afterAll(async () => { await rm(tmp, { recursive: true, force: true }); });
it('exports a real IFC wall to a readable 3dm with IFC identity', async () => {
  const out = join(tmp, 'wall.3dm');
  await exportCommand([sample, '--format', '3dm', '--out', out]);
  const rhino = await rhino3dm();
  const doc = rhino.File3dm.fromByteArray(new Uint8Array(await readFile(out)));
  expect(doc).not.toBeNull();
  try {
    expect(doc!.objects().count).toBeGreaterThan(0);
    expect(doc!.objects().get(0).attributes().getUserString('IFC::GlobalId')).toBeTruthy();
  } finally { (doc as unknown as { delete(): void } | null)?.delete(); }
}, 60000);
it('fails closed when an entity filter matches nothing', async () => {
  const out = join(tmp, 'missing.3dm');
  const exit = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });
  try {
    await expect(exportCommand([sample, '--format', '3dm', '--type', 'IfcDoesNotExist', '--out', out])).rejects.toThrow('exit');
    await expect(access(out)).rejects.toThrow();
  } finally { exit.mockRestore(); }
});
it.each([
  ['--units', 'yards'], ['--coordinates', 'survey'], ['--layers', 'bad'],
  ['--properties', 'bad'], ['--3dm-version', '9'], ['--units'],
])('rejects invalid Rhino flags %s %s', (...args) => {
  const exit = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });
  try { expect(() => rhinoFlags(args)).toThrow('exit'); }
  finally { exit.mockRestore(); }
});

it('leaves scene and archive defaults to their owners unless flags are passed', () => {
  expect(rhinoFlags([])).toEqual({ options: {}, version: undefined });
  expect(rhinoFlags(['--units', 'feet', '--no-instancing', '--layer-slicing', '--3dm-version', '7'])).toEqual({
    options: { units: 'feet', instancing: false, layerSlicing: true }, version: 7,
  });
});

// invalid flags must fail before any model read or WASM bootstrap.
it.each([[], ['--out'], ['--out', 'x.3dm', '--units', 'yards'], ['--out', 'x.3dm', '--3dm-version', '9']])('validates before reading the model: %j', async (...args) => {
  const init = vi.spyOn(GeometryProcessor.prototype, 'init');
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  const exit = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });
  try {
    // This path does not exist: a read would fail with ENOENT instead of the flag error.
    await expect(exportCommand([join(tmp, 'never-created.ifc'), '--format', '3dm', ...args])).rejects.toThrow('exit');
    expect(stderr.mock.calls.flat().join('')).toMatch(/--out is required|Invalid --/);
    expect(init).not.toHaveBeenCalled();
  } finally { init.mockRestore(); stderr.mockRestore(); exit.mockRestore(); }
});
