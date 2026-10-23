/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #7695: `ifc-lite export` over a model with nothing to draw, through the
 * REAL wasm boundary, driven by the shared empty-export vectors
 * (`rust/export/tests/fixtures/empty_export_vectors.json`).
 *
 * Every render-geometry format must fail with the operator message and write
 * nothing; USD used to write a stage with no meshes and report success. The
 * data formats must still export, because an empty or geometry-free model is
 * real data to them.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { exportCommand } from './export.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const VECTORS = join(__dirname, '../../../../rust/export/tests/fixtures/empty_export_vectors.json');

interface Case { name: string; ifc?: string; expect: Record<string, string> }
const cases: Case[] = JSON.parse(readFileSync(VECTORS, 'utf8')).cases;
const inline = cases.filter((c): c is Case & { ifc: string } => typeof c.ifc === 'string');

class ProcessExited extends Error {
  constructor(readonly code: number | undefined) {
    super(`process.exit(${code})`);
  }
}

/** Run `exportCommand`, capturing stderr and turning `fatal()` into a throw. */
async function run(args: string[]): Promise<{ stderr: string; exited: boolean }> {
  let stderr = '';
  const writeSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
    stderr += String(chunk);
    return true;
  });
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new ProcessExited(code);
  }) as never);
  try {
    await exportCommand(args);
    return { stderr, exited: false };
  } catch (err) {
    if (err instanceof ProcessExited) return { stderr, exited: true };
    throw err;
  } finally {
    writeSpy.mockRestore();
    exitSpy.mockRestore();
  }
}

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'ifclite-export-empty-'));
  dirs.push(d);
  return d;
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** The CLI's render-geometry formats; `gltf` is written as GLB. */
const RENDER: Array<[cli: string, vector: string]> = [['obj', 'obj'], ['glb', 'glb'], ['gltf', 'glb'], ['usd', 'usd']];
/** CLI data formats the vectors cover. */
const DATA: Array<[cli: string, vector: string]> = [['csv', 'csv'], ['json', 'json']];

describe('export of a model with no render geometry (#7695)', () => {
  it('the vectors carry inline empty models', () => {
    expect(inline.length).toBeGreaterThanOrEqual(2);
  });

  for (const c of inline) {
    for (const [format, key] of RENDER) {
      it(`${c.name}: --format ${format} fails closed and writes nothing`, async () => {
        expect(c.expect[key]).toBe('NO_RENDER_GEOMETRY');
        const dir = tmp();
        const input = join(dir, 'model.ifc');
        writeFileSync(input, c.ifc);
        const out = join(dir, `model.${format}`);
        const { stderr, exited } = await run([input, '--format', format, '--out', out]);
        expect(exited).toBe(true);
        expect(stderr).toMatch(/export produced 0 (meshes|vertices)/);
        expect(stderr).not.toContain('NO_RENDER_GEOMETRY');
        expect(existsSync(out)).toBe(false);
      }, 60_000);
    }

    for (const [format, key] of DATA) {
      it(`${c.name}: --format ${format} still exports (a data format is not empty without geometry)`, async () => {
        expect(c.expect[key]).toBe('ok');
        const dir = tmp();
        const input = join(dir, 'model.ifc');
        writeFileSync(input, c.ifc);
        const out = join(dir, `model.${format}`);
        const { exited, stderr } = await run([input, '--format', format, '--out', out]);
        expect(exited, stderr).toBe(false);
        expect(existsSync(out)).toBe(true);
      }, 60_000);
    }
  }
});
