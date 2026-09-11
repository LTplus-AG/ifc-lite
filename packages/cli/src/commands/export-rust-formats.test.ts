/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `export-rust-formats.ts` (`exportRustFormat`) had ZERO direct test coverage
 * before this file: nothing imported it, and `export.zero-match.test.ts`
 * (which drives it indirectly through `exportCommand` over the real wasm
 * boundary) only observes success/failure, never the actual argument this
 * module hands across the `GeometryProcessor` boundary.
 *
 * That blind spot is exactly what let a real regression ship: #4364 redefined
 * `GeometryProcessor.exportGlb`'s (and #4386's `exportObj`'s) `isolated`
 * parameter so an explicit empty `Uint32Array` means "isolation filter
 * active, matching nothing" (`undefined` means "no filter"). This file used
 * to pass an explicit empty array to mean "no filter" for both, so a plain
 * `ifc-lite export --format glb` (no `--type`) started failing with
 * "GLB export produced 0 meshes" — nothing caught it, because the CLI suite
 * had no test for this file and the MCP suite mocks the export boundary
 * without asserting on it either (fixed by this same follow-up on the MCP
 * side, `packages/mcp/src/tools/export-init-dispose.test.ts`).
 *
 * `GeometryProcessor` is mocked here (mirroring the MCP pattern above) so the
 * assertions can read `mock.calls[N][i]` — the actual value handed across the
 * boundary — rather than only the return value, which a mock satisfies either
 * way and would not have caught this class of bug.
 */

import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const gp = vi.hoisted(() => {
  const init = vi.fn(async () => undefined);
  const exportGlb = vi.fn();
  const exportObj = vi.fn();
  const exportStep = vi.fn();
  const exportJsonld = vi.fn();
  const exportIfcx = vi.fn();
  const exportUsd = vi.fn();
  const dispose = vi.fn();
  class GeometryProcessor {
    init = init;
    exportGlb = exportGlb;
    exportObj = exportObj;
    exportStep = exportStep;
    exportJsonld = exportJsonld;
    exportIfcx = exportIfcx;
    exportUsd = exportUsd;
    dispose = dispose;
  }
  return {
    init,
    exportGlb,
    exportObj,
    exportStep,
    exportJsonld,
    exportIfcx,
    exportUsd,
    dispose,
    GeometryProcessor,
  };
});

vi.mock('@ifc-lite/geometry', () => ({
  GeometryProcessor: gp.GeometryProcessor,
  isNoRenderGeometryError: (err: unknown) =>
    err instanceof Error && err.message === 'NO_RENDER_GEOMETRY',
}));

// `countGlbMeshes`/`countObjVertices` run on the real bytes `gp.exportGlb`/
// `gp.exportObj` return (a defense-in-depth check independent of what this
// module passed in), so they are mocked separately to keep the success paths
// deterministic without needing byte-for-byte real GLB/OBJ output. Both
// default to a non-zero count so the argument-passing tests below (the
// actual point of this file) exercise the success path; the zero-vertex
// guard itself gets its own test that overrides `countObjVertices` to 0.
const countGlbMeshes = vi.hoisted(() => vi.fn(() => 1));
const countObjVertices = vi.hoisted(() => vi.fn(() => 1));
vi.mock('@ifc-lite/export', () => ({ countGlbMeshes, countObjVertices }));

import { exportRustFormat } from './export-rust-formats.js';
import type { IfcDataStore } from '@ifc-lite/parser';

const __dirname = new URL('.', import.meta.url).pathname;
// Any real file works: `rustExportContext` only reads it off disk
// (`store.source.byteLength === 0` below forces that path) and hands the
// bytes straight to the mocked `GeometryProcessor`, which never inspects them.
const SAMPLE_IFC = join(__dirname, '../../../../apps/viewer/public/samples/hello-wall.ifc');

/** A store whose `source.byteLength` is 0, forcing `rustExportContext` to read `filePath` from disk. */
const FAKE_STORE = { source: { byteLength: 0 } } as unknown as IfcDataStore;

const REFS = [{ expressId: 42 }, { expressId: 43 }];

const dirs: string[] = [];
function outFile(name: string): string {
  const d = mkdtempSync(join(tmpdir(), 'ifclite-export-rust-formats-'));
  dirs.push(d);
  return join(d, name);
}

/**
 * `fatal()` (packages/cli/src/output.ts) writes to stderr and calls the REAL
 * `process.exit(1)`, which does not throw — it would kill the test runner.
 * Mirrors `export.zero-match.test.ts`'s approach: stub `process.exit` to
 * throw instead, so the "matched 0 entities" guard can be asserted with
 * `.rejects.toThrow()` like any other rejection.
 */
class ProcessExited extends Error {
  constructor(readonly code: number | undefined) {
    super(`process.exit(${code})`);
  }
}

afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function stubExit(): void {
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new ProcessExited(code);
  }) as never);
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
}

describe('exportRustFormat: `isolated` argument passed to gp.exportGlb (#4364)', () => {
  it('passes `undefined` (not an empty Uint32Array) when no filter was requested', async () => {
    gp.exportGlb.mockReturnValue(new Uint8Array([1, 2, 3]));
    const out = outFile('no-filter.glb');

    await exportRustFormat('glb', ['--out', out], FAKE_STORE, SAMPLE_IFC, [], false, false);

    expect(gp.exportGlb).toHaveBeenCalledTimes(1);
    const isolatedArg = gp.exportGlb.mock.calls[0]?.[3];
    expect(isolatedArg).toBeUndefined();
  });

  it('passes a real Uint32Array of matched expressIds when a filter matches', async () => {
    gp.exportGlb.mockReturnValue(new Uint8Array([1, 2, 3]));
    const out = outFile('filtered.glb');

    await exportRustFormat('glb', ['--out', out], FAKE_STORE, SAMPLE_IFC, REFS, true, false);

    expect(gp.exportGlb).toHaveBeenCalledTimes(1);
    const isolatedArg = gp.exportGlb.mock.calls[0]?.[3];
    expect(isolatedArg).toBeInstanceOf(Uint32Array);
    expect(Array.from(isolatedArg as Uint32Array)).toEqual([42, 43]);
  });

  it('rejects before calling gp.exportGlb when the filter matches nothing', async () => {
    stubExit();
    const out = outFile('zero-match.glb');

    await expect(
      exportRustFormat('glb', ['--out', out], FAKE_STORE, SAMPLE_IFC, [], true, false),
    ).rejects.toThrow(ProcessExited);
    expect(process.stderr.write).toHaveBeenCalledWith(
      expect.stringContaining('Filter matched 0 entities'),
    );
    expect(gp.exportGlb).not.toHaveBeenCalled();
  });
});

describe('exportRustFormat: `isolated` argument passed to gp.exportObj (the OBJ twin, #4386)', () => {
  it('passes `undefined` (not an empty Uint32Array) when no filter was requested', async () => {
    gp.exportObj.mockReturnValue(new TextEncoder().encode('o Wall\n'));
    const out = outFile('no-filter.obj');

    await exportRustFormat('obj', ['--out', out], FAKE_STORE, SAMPLE_IFC, [], false, false);

    expect(gp.exportObj).toHaveBeenCalledTimes(1);
    const isolatedArg = gp.exportObj.mock.calls[0]?.[3];
    expect(isolatedArg).toBeUndefined();
  });

  it('passes a real Uint32Array of matched expressIds when a filter matches', async () => {
    gp.exportObj.mockReturnValue(new TextEncoder().encode('o Wall\n'));
    const out = outFile('filtered.obj');

    await exportRustFormat('obj', ['--out', out], FAKE_STORE, SAMPLE_IFC, REFS, true, false);

    expect(gp.exportObj).toHaveBeenCalledTimes(1);
    const isolatedArg = gp.exportObj.mock.calls[0]?.[3];
    expect(isolatedArg).toBeInstanceOf(Uint32Array);
    expect(Array.from(isolatedArg as Uint32Array)).toEqual([42, 43]);
  });

  it('rejects before calling gp.exportObj when the filter matches nothing', async () => {
    stubExit();
    const out = outFile('zero-match.obj');

    await expect(
      exportRustFormat('obj', ['--out', out], FAKE_STORE, SAMPLE_IFC, [], true, false),
    ).rejects.toThrow(ProcessExited);
    expect(process.stderr.write).toHaveBeenCalledWith(
      expect.stringContaining('Filter matched 0 entities'),
    );
    expect(gp.exportObj).not.toHaveBeenCalled();
  });

  it('fails loudly (never writes the file) when countObjVertices reports 0 vertices (#4386)', async () => {
    stubExit();
    // `gp.exportObj` "succeeds" with header-only bytes (no real geometry
    // pipeline here to produce zero output on its own), so drive the guard
    // directly through its actual signal: `countObjVertices` returning 0.
    gp.exportObj.mockReturnValue(new TextEncoder().encode('o Empty\n'));
    countObjVertices.mockReturnValueOnce(0);
    const out = outFile('zero-vertices.obj');

    await expect(
      exportRustFormat('obj', ['--out', out], FAKE_STORE, SAMPLE_IFC, [], false, false),
    ).rejects.toThrow(ProcessExited);

    expect(process.stderr.write).toHaveBeenCalledWith(
      expect.stringContaining('OBJ export produced 0 vertices'),
    );
    expect(existsSync(out)).toBe(false);
  });
});

describe('exportRustFormat: whole-model formats never gate on filterRequested', () => {
  it('ifcx ignores a filter (wholeModelFormat=true) and never calls exportObj/exportGlb', async () => {
    gp.exportIfcx.mockReturnValue(new Uint8Array([1]));
    const out = outFile('whole.ifcx');

    await exportRustFormat('ifcx', ['--out', out], FAKE_STORE, SAMPLE_IFC, REFS, true, true);

    expect(gp.exportIfcx).toHaveBeenCalledTimes(1);
    expect(gp.exportGlb).not.toHaveBeenCalled();
    expect(gp.exportObj).not.toHaveBeenCalled();
  });
});
