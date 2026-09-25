/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #5942 — the drape through the canonical load path. The terrain is LandXML
 * TEXT loaded by `useIfcLoader.loadFile`, so the real Rust parser decides the
 * coordinate order; the image is a real PNG + world file + `.prj`; the
 * renderer is observed at its two seams (`removeMeshesForEntities`,
 * `addMeshes`), the same way the other loader tests observe the GPU.
 *
 * Only the pixel decode is outside this test: happy-dom has no
 * `createImageBitmap`, so the raster's texture step returns a stand-in bitmap
 * of the real size. The UVs, coverage, store and GPU hand-off are all real.
 */

import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { RefObject } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { MeshData } from '@ifc-lite/geometry';
import type { Renderer } from '@ifc-lite/renderer';
import { toast } from '@/components/ui/toast';
import { useViewerStore } from '@/store';
import { setGlobalRendererRef } from '../useBCF.js';
import { useIfcLoader } from '../useIfcLoader.js';
import { GeoRasterBundle } from '@/lib/terrain-imagery/raster-bundle.js';
import { readGeoRasterBundle } from '@/lib/terrain-imagery/read-raster.js';
import {
  FEATURE, ORTHO, orthoPng, orthoTerrainXml, orthoWorldFile,
} from '@/lib/terrain-imagery/synthetic-orthophoto.fixture.js';
import { drapeRasterOnTerrains, type DrapeRaster } from './terrainImageryDrape.js';

const LV95_WKT = 'PROJCS["CH1903+ / LV95",AUTHORITY["EPSG","2056"]]';

function orthoBundle(): GeoRasterBundle {
  return new GeoRasterBundle(
    new File([orthoPng().slice()], 'ortho.png', { type: 'image/png' }),
    new File([orthoWorldFile()], 'ortho.pgw'),
    [new File([LV95_WKT], 'ortho.prj')],
  );
}

async function orthoRaster(): Promise<DrapeRaster> {
  const read = await readGeoRasterBundle(orthoBundle());
  assert.ok(read.ok, read.ok ? '' : read.reason);
  const loaded = read.value;
  return {
    name: loaded.name, source: 'file', placement: loaded.placement,
    image: { bytes: loaded.bytes, mime: loaded.mime },
    texture: async () => ({ bitmap: { width: ORTHO.width + 2, height: ORTHO.height + 2 } as ImageBitmap, imageWidth: ORTHO.width, imageHeight: ORTHO.height }),
  };
}

let hookApi: ReturnType<typeof useIfcLoader> | null = null;
function Probe(): null {
  hookApi = useIfcLoader();
  return null;
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;
const gpu = { removed: [] as number[], added: [] as MeshData[] };

beforeEach(async () => {
  hookApi = null;
  gpu.removed = [];
  gpu.added = [];
  useViewerStore.getState().resetViewerState();
  useViewerStore.getState().clearAllModels();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root!.render(<Probe />));
  assert.ok(hookApi);
});

afterEach(async () => {
  setGlobalRendererRef({ current: null });
  const current = root;
  root = null;
  if (current) await act(async () => current.unmount());
  container?.remove();
  container = null;
});

function installRenderer(): void {
  const renderer = {
    isReady: () => true,
    getScene: () => ({ removeMeshesForEntities: (ids: Iterable<number>) => { gpu.removed.push(...ids); return 0; } }),
    addMeshes: (meshes: MeshData[]) => { gpu.added.push(...meshes); return { ok: true, value: undefined }; },
    requestRender: () => {},
  };
  setGlobalRendererRef({ current: renderer as unknown as Renderer } as RefObject<Renderer | null>);
}

async function loadTerrain(pointOrder: 'northing-first' | 'easting-first' = 'northing-first'): Promise<string> {
  const file = new File([orthoTerrainXml(pointOrder)], 'terrain.xml', { type: 'application/xml' });
  await act(async () => hookApi!.loadFile(file, { kind: 'primary' }));
  const model = [...useViewerStore.getState().models.values()][0];
  assert.ok(model?.geometryResult?.meshes.length, 'the terrain loaded and rendered');
  return model.id;
}

describe('draping imagery through the load path (#5942)', () => {
  it('routes a raster bundle through loadFile without creating a model or resetting the scene', async () => {
    const terrainId = await loadTerrain();
    const errors: string[] = [];
    const original = toast.error;
    toast.error = (message: string) => { errors.push(message); };
    try {
      // No renderer is installed: the drape is refused at the GPU step, and
      // everything before it must have left the store alone.
      await act(async () => hookApi!.loadFile(orthoBundle(), { kind: 'federated', modelId: 'raster-model' }));
    } finally {
      toast.error = original;
    }
    const state = useViewerStore.getState();
    assert.deepEqual([...state.models.keys()], [terrainId], 'a raster is imagery, never a model');
    assert.equal(state.models.get(terrainId)?.terrainImagery, undefined);
    assert.equal(state.loading, false);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /viewport is not ready/);
  });

  it('refuses a raster when no terrain is loaded, naming what to do', async () => {
    await assert.rejects(async () => drapeRasterOnTerrains(await orthoRaster()), /load a LandXML terrain first/);
  });

  it('drapes the parsed terrain: the feature vertex samples the marked texel, the rest keeps its geometry', async () => {
    const terrainId = await loadTerrain();
    installRenderer();
    const before = useViewerStore.getState().models.get(terrainId)!.geometryResult!.meshes;
    const [outcome] = await drapeRasterOnTerrains(await orthoRaster());
    assert.ok(outcome.result.ok, outcome.result.ok ? '' : outcome.result.reason);
    const drape = outcome.result.value;
    assert.equal(drape.coveredVertices, 67);
    assert.equal(drape.totalVertices, 105);
    assert.equal(drape.imageCrs, 'EPSG:2056');
    assert.equal(drape.reprojected, false);
    assert.equal(drape.image?.sha256.length, 64);

    // The GPU received textured copies of exactly the meshes it gave up.
    assert.deepEqual(new Set(gpu.removed), new Set(before.map((mesh) => mesh.expressId)));
    assert.equal(gpu.added.length, before.length);
    const after = useViewerStore.getState().models.get(terrainId)!;
    assert.equal(after.terrainImagery, drape);
    const shift = after.geometryResult!.coordinateInfo.originShift;
    let featureTexel: [number, number] | null = null;
    for (const mesh of after.geometryResult!.meshes) {
      const original = before.find((candidate) => candidate.expressId === mesh.expressId)!;
      assert.equal(mesh.positions, original.positions, 'the drape never touches geometry');
      assert.deepEqual(mesh.color.slice(0, 3), [1, 1, 1]);
      assert.equal(mesh.textureRef?.url, 'ortho.png');
      assert.equal(mesh.textureRef?.repeatS, false);
      assert.ok(mesh.uvs && mesh.uvs.length === (mesh.positions.length / 3) * 2);
      const origin = mesh.origin ?? [0, 0, 0];
      for (let vertex = 0; vertex < mesh.positions.length / 3; vertex += 1) {
        const east = mesh.positions[vertex * 3] + origin[0] + shift.x;
        const north = -(mesh.positions[vertex * 3 + 2] + origin[2] + shift.z);
        if (Math.hypot(east - FEATURE.easting, north - FEATURE.northing) > 0.01) continue;
        // The bordered texture is 202 × 102 texels with the image at (1, 1).
        featureTexel = [Math.floor(mesh.uvs[vertex * 2] * (ORTHO.width + 2)) - 1, Math.floor(mesh.uvs[vertex * 2 + 1] * (ORTHO.height + 2)) - 1];
      }
    }
    assert.deepEqual(featureTexel, [ORTHO.marked.col, ORTHO.marked.row]);
  });

  it('refuses the correctly placed image on an easting-first terrain read by the real parser', async () => {
    const terrainId = await loadTerrain('easting-first');
    installRenderer();
    const [outcome] = await drapeRasterOnTerrains(await orthoRaster());
    assert.equal(outcome.result.ok, false);
    assert.match(outcome.result.ok ? '' : outcome.result.reason, /covers no vertex/);
    assert.equal(gpu.added.length, 0, 'nothing is uploaded for a refused drape');
    assert.equal(useViewerStore.getState().models.get(terrainId)?.terrainImagery, undefined);
  });
});
