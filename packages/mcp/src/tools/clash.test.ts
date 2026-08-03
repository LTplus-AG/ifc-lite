/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `meshModel` (#1959 P1 leak): the module never disposed the GeometryProcessor
 * it created to tessellate a model. A long-lived MCP server process
 * accumulates one WASM handle per never-before-clashed model — the fix wraps
 * meshing in try/finally. Both the cancellation-abort throw and the
 * zero-mesh throw are covered, not just the happy path, since a `finally`
 * that only sits around the success return would still leak on those.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { GeometryProcessor, type GeometryResult, type MeshData } from '@ifc-lite/geometry';
import type { ToolContext } from '../context.js';
import { DEFAULT_CONFIG, InMemoryModelRegistry, NOOP_PROGRESS, SILENT_LOGGER } from '../context.js';
import { fullScope } from '../auth/scope.js';
import { loadIfcModel } from '../loader.js';
import { clashTools } from './clash.js';

const SAMPLE = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('m','2026',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1= IFCPROJECT('0aBcDeFgHiJkLmNoPqRsT0',$,'Proj',$,$,$,$,(#20),#30);
#20= IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-5,#21,$);
#21= IFCAXIS2PLACEMENT3D(#22,$,$);
#22= IFCCARTESIANPOINT((0.,0.,0.));
#30= IFCUNITASSIGNMENT((#31));
#31= IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#40= IFCLOCALPLACEMENT($,#21);
#41= IFCBUILDINGSTOREY('0aBcDeFgHiJkLmNoPqRsT1',$,'L01',$,$,#40,$,$,.ELEMENT.,0.);
#72= IFCWALL('0aBcDeFgHiJkLmNoPqRsT2',$,'Wall A',$,$,#40,$,'tagA',$);
ENDSEC;
END-ISO-10303-21;
`;

const oneTriangle: MeshData = {
  positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
  normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
  indices: new Uint32Array([0, 1, 2]),
  color: [1, 1, 1, 1],
  expressId: 72,
};

let tmp: string;
let modelId = 0;

function ctx(): ToolContext {
  return {
    registry: new InMemoryModelRegistry(),
    scope: fullScope(),
    progress: NOOP_PROGRESS,
    log: SILENT_LOGGER,
    signal: new AbortController().signal,
    config: { ...DEFAULT_CONFIG },
  };
}

/** Every test gets its own registry + freshly-loaded model, so meshModel's
 *  module-level WeakMap cache (keyed by the LoadedModel instance) never
 *  serves a stale mesh across `it()`s. */
async function loadedModel(): Promise<{ context: ToolContext; id: string }> {
  const id = `clash-dispose-${modelId++}`;
  const path = join(tmp, `${id}.ifc`);
  await writeFile(path, SAMPLE, 'utf-8');
  const context = ctx();
  context.registry.add(await loadIfcModel(path, { modelId: id }));
  return { context, id };
}

function clashCheck(context: ToolContext, id: string) {
  const tool = clashTools.find((t) => t.name === 'clash_check');
  if (!tool) throw new Error('clash_check not registered');
  return tool.handler({ model_id: id }, context);
}

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'ifc-lite-clash-dispose-'));
});

afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('meshModel WASM disposal (#1959 P1 leak)', () => {
  it('disposes the GeometryProcessor handle on the success path', async () => {
    vi.spyOn(GeometryProcessor.prototype, 'init').mockResolvedValue(undefined);
    vi.spyOn(GeometryProcessor.prototype, 'process').mockResolvedValue({
      meshes: [oneTriangle],
    } as unknown as GeometryResult);
    const disposeSpy = vi.spyOn(GeometryProcessor.prototype, 'dispose').mockReturnValue(undefined);

    const { context, id } = await loadedModel();
    const result = await clashCheck(context, id);

    expect(result.isError).toBeFalsy();
    expect(disposeSpy).toHaveBeenCalledTimes(1);
  });

  it('disposes the GeometryProcessor handle when meshing yields zero meshes (throw path)', async () => {
    vi.spyOn(GeometryProcessor.prototype, 'init').mockResolvedValue(undefined);
    vi.spyOn(GeometryProcessor.prototype, 'process').mockResolvedValue({
      meshes: [],
    } as unknown as GeometryResult);
    const disposeSpy = vi.spyOn(GeometryProcessor.prototype, 'dispose').mockReturnValue(undefined);

    const { context, id } = await loadedModel();
    await expect(clashCheck(context, id)).rejects.toThrow(
      'No mesh geometry could be produced',
    );
    expect(disposeSpy).toHaveBeenCalledTimes(1);
  });

  it('disposes the GeometryProcessor handle when the run is already aborted (cancellation throw)', async () => {
    vi.spyOn(GeometryProcessor.prototype, 'init').mockResolvedValue(undefined);
    const processSpy = vi.spyOn(GeometryProcessor.prototype, 'process');
    const disposeSpy = vi.spyOn(GeometryProcessor.prototype, 'dispose').mockReturnValue(undefined);

    const { context, id } = await loadedModel();
    const controller = new AbortController();
    controller.abort();
    context.signal = controller.signal;

    await expect(clashCheck(context, id)).rejects.toThrow('Clash run cancelled before meshing.');
    expect(processSpy).not.toHaveBeenCalled();
    expect(disposeSpy).toHaveBeenCalledTimes(1);
  });
});
