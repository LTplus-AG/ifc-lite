/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `export_usd` MCP handler: it writes the `GeometryProcessor.exportUsd` bytes to
 * disk and MUST dispose the processor whether the export succeeds or fails. The
 * `GeometryProcessor` (wasm) is mocked so we can drive both the success and the
 * null-output paths deterministically; the real compiled `exportUsd` is covered
 * by `scripts/test-wasm-contract.mjs` and `tests/e2e/usd-export.e2e.spec.ts`.
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const gp = vi.hoisted(() => {
  const init = vi.fn(async () => undefined);
  const exportUsd = vi.fn();
  const dispose = vi.fn();
  class GeometryProcessor {
    init = init;
    exportUsd = exportUsd;
    dispose = dispose;
  }
  return { init, exportUsd, dispose, GeometryProcessor };
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

const exportUsdTool = exportTools.find((t) => t.name === 'export_usd')!;

let tmp: string;
let ctx: ToolContext;

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'ifc-lite-mcp-usd-'));
  await writeFile(join(tmp, 'm.ifc'), MODEL, 'utf-8');
});

afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

beforeEach(async () => {
  gp.init.mockClear();
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

describe('export_usd tool', () => {
  it('is registered with a required file_path', () => {
    expect(exportUsdTool).toBeDefined();
    expect(exportUsdTool.inputSchema.required).toContain('file_path');
  });

  it('writes the exportUsd bytes to disk and disposes the processor on success', async () => {
    const usd = new TextEncoder().encode('#usda 1.0\n(\n    defaultPrim = "World"\n)\n');
    gp.exportUsd.mockReturnValue(usd);
    const out = join(tmp, 'out.usda');

    const res = await exportUsdTool.handler({ file_path: out }, ctx);

    expect(res.isError).toBeUndefined();
    expect(gp.exportUsd).toHaveBeenCalledTimes(1);
    expect(new Uint8Array(await readFile(out))).toEqual(usd);
    expect(res.structuredContent).toMatchObject({ filePath: out, bytes: usd.length });
    expect(gp.dispose).toHaveBeenCalledTimes(1);
  });

  it('throws INTERNAL_ERROR but STILL disposes the processor when exportUsd returns null', async () => {
    gp.exportUsd.mockReturnValue(null);
    const out = join(tmp, 'out-null.usda');

    await expect(exportUsdTool.handler({ file_path: out }, ctx)).rejects.toMatchObject({
      code: 'INTERNAL_ERROR',
    });
    // Disposed via the handler's `finally`, even though nothing was written.
    expect(gp.dispose).toHaveBeenCalledTimes(1);
  });
});
