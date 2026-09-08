/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `ifc-lite export --format usd` end to end through the REAL wasm boundary
 * (the committed hello-wall sample has render geometry). Covers the `--out`
 * write path, processor disposal, and the whole-model rule that entity filters
 * are ignored for USD (a zero-match `--type` must NOT abort the export).
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { GeometryProcessor } from '@ifc-lite/geometry';
import { exportCommand } from './export.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
// Committed viewer demo sample with real render geometry (a wall).
const SAMPLE_IFC = join(__dirname, '../../../../apps/viewer/public/samples/hello-wall.ifc');

let tmp: string;

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'ifc-lite-cli-usd-'));
});

afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe('export --format usd', () => {
  it('writes a valid Z-up USDA stage to --out and disposes the processor', async () => {
    const out = join(tmp, 'model.usda');
    const disposeSpy = vi.spyOn(GeometryProcessor.prototype, 'dispose');

    await exportCommand([SAMPLE_IFC, '--format', 'usd', '--out', out]);

    const usda = await readFile(out, 'utf-8');
    expect(usda.startsWith('#usda 1.0')).toBe(true);
    expect(usda).toMatch(/upAxis\s*=\s*"Z"/);
    expect(usda).toContain('def Xform "World"');
    expect(usda).toMatch(/def Mesh "|class Mesh "/);
    expect(disposeSpy).toHaveBeenCalled();

    disposeSpy.mockRestore();
  });

  it('ignores entity filters for the whole-model USD format (a zero-match --type must not abort)', async () => {
    const out = join(tmp, 'filtered.usda');

    // A type that matches nothing would abort a normal entity export; USD is
    // whole-model, so the filter is ignored and the full stage is still written.
    await exportCommand([SAMPLE_IFC, '--format', 'usd', '--type', 'IfcDoesNotExist', '--out', out]);

    const usda = await readFile(out, 'utf-8');
    expect(usda.startsWith('#usda 1.0')).toBe(true);
    expect(usda).toContain('def Xform "World"');
  });
});
