/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `export_glb` / `export_obj` / `export_ifcx` / `export_usd` all follow:
 *
 *   const gp = new GeometryProcessor();
 *   await gp.init();
 *   try { ... } finally { gp.dispose(); }
 *
 * `gp.init()` sitting outside the `try` (#2342) means a rejection there skips
 * `dispose()` entirely — the correct shape (already used by
 * `packages/mcp/src/tools/clash.ts`) is `try { await gp.init(); ... } finally
 * { gp.dispose(); }`. `GeometryProcessor` is mocked so `init()` can be made to
 * reject deterministically; the real compiled pipeline is covered elsewhere
 * (`scripts/test-wasm-contract.mjs`, the e2e export specs).
 *
 * What these tests pin, stated precisely: that `dispose()` is REACHED on the
 * init-failure path. They do not pin that a WASM handle is freed, and on
 * today's code it is not — `IfcLiteBridge.init()` catches its own failures and
 * calls `reset()`, which nulls `ifcApi` without `free()`, so the recovered
 * `dispose()` optional-chains to a no-op. That leak lives in the bridge's error
 * path and is tracked separately; do not read a green run here as evidence the
 * handle was released.
 */

import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const gp = vi.hoisted(() => {
  const init = vi.fn(async () => undefined);
  const exportGlb = vi.fn();
  const exportObj = vi.fn();
  const exportIfcx = vi.fn();
  const exportUsd = vi.fn();
  const dispose = vi.fn();
  class GeometryProcessor {
    init = init;
    exportGlb = exportGlb;
    exportObj = exportObj;
    exportIfcx = exportIfcx;
    exportUsd = exportUsd;
    dispose = dispose;
  }
  return { init, exportGlb, exportObj, exportIfcx, exportUsd, dispose, GeometryProcessor };
});

vi.mock('@ifc-lite/geometry', () => ({
  GeometryProcessor: gp.GeometryProcessor,
  isNoRenderGeometryError: () => false,
}));

import type { ToolContext } from '../context.js';
import {
  DEFAULT_CONFIG,
  InMemoryModelRegistry,
  NOOP_PROGRESS,
  SILENT_LOGGER,
} from '../context.js';
import { fullScope } from '../auth/scope.js';
import { loadIfcModel } from '../loader.js';
import { exportTools } from './export.js';

/**
 * Assemble a minimal GLB (12-byte header + JSON chunk + BIN chunk), same
 * layout as `packages/export/src/glb.test.ts`'s `buildGlb`, so `export_glb`'s
 * `countGlbMeshes` defense-in-depth check sees a non-zero mesh count on the
 * success path.
 */
function buildGlb(json: unknown): Uint8Array {
  const jsonBytes = new TextEncoder().encode(JSON.stringify(json));
  const pad4 = (n: number) => (4 - (n % 4)) % 4;
  const jsonChunkLen = jsonBytes.length + pad4(jsonBytes.length);
  const total = 12 + 8 + jsonChunkLen + 8;
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  let o = 0;
  dv.setUint32(o, 0x46546c67, true); o += 4; // magic 'glTF'
  dv.setUint32(o, 2, true); o += 4; // version
  dv.setUint32(o, total, true); o += 4; // total length
  dv.setUint32(o, jsonChunkLen, true); o += 4;
  dv.setUint32(o, 0x4e4f534a, true); o += 4; // 'JSON'
  out.set(jsonBytes, o); o += jsonBytes.length;
  for (let i = 0; i < pad4(jsonBytes.length); i++) out[o++] = 0x20;
  dv.setUint32(o, 0, true); o += 4; // zero-length BIN chunk
  dv.setUint32(o, 0x004e4942, true); o += 4; // 'BIN\0'
  return out;
}

const MODEL = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('m','2026',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1= IFCPROJECT('0000000000000000000PRJ',$,'Proj',$,$,$,$,(#20),#30);
#20= IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-5,#21,$);
#21= IFCAXIS2PLACEMENT3D(#22,$,$);
#22= IFCCARTESIANPOINT((0.,0.,0.));
#30= IFCUNITASSIGNMENT((#31));
#31= IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#40= IFCLOCALPLACEMENT($,#21);
#41= IFCBUILDINGSTOREY('0000000000000000000STO',$,'L01',$,$,#40,$,$,.ELEMENT.,0.);
#72= IFCWALL('0000000000000000000WAL',$,'Wall A',$,$,#40,$,'tagA',$);
ENDSEC;
END-ISO-10303-21;
`;

const exportGlbTool = exportTools.find((t) => t.name === 'export_glb')!;
const exportObjTool = exportTools.find((t) => t.name === 'export_obj')!;
const exportIfcxTool = exportTools.find((t) => t.name === 'export_ifcx')!;
const exportUsdTool = exportTools.find((t) => t.name === 'export_usd')!;

let tmp: string;
let ctx: ToolContext;

beforeAll(async () => {
  tmp = await realpath(await mkdtemp(join(tmpdir(), 'ifc-lite-mcp-export-init-')));
  await writeFile(join(tmp, 'm.ifc'), MODEL, 'utf-8');
});

afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

beforeEach(async () => {
  gp.init.mockReset();
  gp.init.mockImplementation(async () => undefined);
  gp.exportGlb.mockReset();
  gp.exportObj.mockReset();
  gp.exportIfcx.mockReset();
  gp.exportUsd.mockReset();
  gp.dispose.mockReset();
  ctx = {
    registry: new InMemoryModelRegistry(),
    scope: fullScope(),
    progress: NOOP_PROGRESS,
    log: SILENT_LOGGER,
    signal: new AbortController().signal,
    config: { ...DEFAULT_CONFIG, allowedPaths: [tmp] },
  };
  ctx.registry.add(await loadIfcModel(join(tmp, 'm.ifc'), { modelId: 'm' }));
});

describe.each([
  { name: 'export_glb', tool: () => exportGlbTool, out: 'out.glb' },
  { name: 'export_obj', tool: () => exportObjTool, out: 'out.obj' },
  { name: 'export_ifcx', tool: () => exportIfcxTool, out: 'out.ifcx' },
  { name: 'export_usd', tool: () => exportUsdTool, out: 'out.usda' },
])('$name: init() rejection', ({ tool, out }) => {
  it('still disposes the processor when init() rejects after allocating', async () => {
    const initError = new Error('WASM init failed after allocating the IfcAPI handle');
    gp.init.mockImplementation(async () => {
      throw initError;
    });
    const filePath = join(tmp, out);

    await expect(tool().handler({ file_path: filePath }, ctx)).rejects.toThrow(initError);

    // This is the assertion that matters: dispose() must actually run on the
    // init-failure path, not merely that the call rejected (a bare `rejects`
    // assertion would pass identically before and after the fix).
    expect(gp.dispose).toHaveBeenCalledTimes(1);
  });
});

describe('export_glb tool: bounding control', () => {
  it('disposes exactly once and returns the correct result on success', async () => {
    const glb = buildGlb({ asset: { version: '2.0' }, meshes: [{}] });
    gp.exportGlb.mockReturnValue(glb);
    const out = join(tmp, 'ok.glb');

    const res = await exportGlbTool.handler({ file_path: out }, ctx);

    expect(res.isError).toBeUndefined();
    expect(gp.init).toHaveBeenCalledTimes(1);
    expect(gp.exportGlb).toHaveBeenCalledTimes(1);
    expect(new Uint8Array(await readFile(out))).toEqual(glb);
    expect(res.structuredContent).toMatchObject({ filePath: out, bytes: glb.length });
    expect(gp.dispose).toHaveBeenCalledTimes(1);
  });
});

describe('export_obj tool: bounding control', () => {
  it('disposes exactly once and returns the correct result on success', async () => {
    const obj = new TextEncoder().encode('o Wall A\nv 0 0 0\n');
    gp.exportObj.mockReturnValue(obj);
    const out = join(tmp, 'ok.obj');

    const res = await exportObjTool.handler({ file_path: out }, ctx);

    expect(res.isError).toBeUndefined();
    expect(gp.init).toHaveBeenCalledTimes(1);
    expect(gp.exportObj).toHaveBeenCalledTimes(1);
    expect(new Uint8Array(await readFile(out))).toEqual(obj);
    expect(res.structuredContent).toMatchObject({ filePath: out, bytes: obj.length });
    expect(gp.dispose).toHaveBeenCalledTimes(1);
  });
});

describe('export_ifcx tool: bounding control', () => {
  it('disposes exactly once and returns the correct result on success', async () => {
    const ifcx = new TextEncoder().encode('{"header":{}}');
    gp.exportIfcx.mockReturnValue(ifcx);
    const out = join(tmp, 'ok.ifcx');

    const res = await exportIfcxTool.handler({ file_path: out }, ctx);

    expect(res.isError).toBeUndefined();
    expect(gp.init).toHaveBeenCalledTimes(1);
    expect(gp.exportIfcx).toHaveBeenCalledTimes(1);
    expect(new Uint8Array(await readFile(out))).toEqual(ifcx);
    expect(res.structuredContent).toMatchObject({ filePath: out, bytes: ifcx.length });
    expect(gp.dispose).toHaveBeenCalledTimes(1);
  });
});
