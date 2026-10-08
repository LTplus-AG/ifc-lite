/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Scan federations for viewer tests (#6887).
 *
 * A real `Renderer` whose point-cloud half (`PointCloudRenderer`) runs on a
 * recording GPU device, scans streamed through the real `ingestPointCloud`,
 * and models registered in the store the way `useIfcLoader.loadFile`'s
 * `finalizeModel` registers them: `registerModelOffset`, the offset folded
 * into the point-cloud descriptor, `addModel`, then `bindPointCloudIdentity`.
 *
 * The loader itself cannot run a scan in node (its decoder is a Web Worker),
 * so `loadScan` replays those finalize steps; keep them in step with it.
 */

import type { GeometryResult, MeshData } from '@ifc-lite/geometry';
import type { StreamPointCloudOptions } from '@ifc-lite/pointcloud';
import { PointCloudRenderer, Renderer } from '@ifc-lite/renderer';
import { useViewerStore, type FederatedModel } from '@/store';
import { ingestPointCloud, type PointCloudFormat } from '@/hooks/ingest/pointCloudIngest';
import { bindPointCloudIdentity } from '@/hooks/ingest/pointCloudIdentity';
import { getMaxExpressId } from '@/hooks/ingest/viewerModelIngest';
import { fixtureDataStore, type FixtureEntity } from '@/test/store-fixture';

function recordingDevice(): GPUDevice {
  const g = globalThis as Record<string, unknown>;
  g.GPUShaderStage ??= { VERTEX: 1, FRAGMENT: 2, COMPUTE: 4 };
  g.GPUBufferUsage ??= { MAP_READ: 1, COPY_SRC: 4, COPY_DST: 8, VERTEX: 32, UNIFORM: 64, STORAGE: 128 };
  return {
    limits: { maxBufferSize: 1 << 28, maxStorageBufferBindingSize: 1 << 28, maxComputeWorkgroupsPerDimension: 65_535 },
    createBindGroupLayout: () => ({}), createPipelineLayout: () => ({}), createShaderModule: () => ({}),
    createRenderPipeline: () => ({}), createBindGroup: () => ({}),
    createBuffer: ({ size }: GPUBufferDescriptor) => ({ size, destroy() {} }),
    queue: { writeBuffer() {} },
  } as unknown as GPUDevice;
}

/** A `Renderer` with a live point-cloud half; `points` is what it uploaded to. */
export function scanTestRenderer(): { renderer: Renderer; points: PointCloudRenderer } {
  const canvas = { width: 256, height: 256, getBoundingClientRect: () => ({ width: 256, height: 256 }) };
  const renderer = new Renderer(canvas as unknown as HTMLCanvasElement);
  const points = new PointCloudRenderer(recordingDevice(), 'rgba8unorm', 'depth32float', 1);
  // The device-creation boundary `Renderer.init` crosses after its GPU await.
  (renderer as unknown as { pointCloudRenderer: PointCloudRenderer }).pointCloudRenderer = points;
  renderer.requestRender = () => {};
  return { renderer, points };
}

/** What `readDeviationDistances` reports per asset: `node.meta` (deviation-readback.ts). */
export function readbackIdentities(points: PointCloudRenderer): Array<{ expressId: number; modelIndex: number }> {
  return points.getPickNodes().map((node) => ({ expressId: node.expressId, modelIndex: node.modelIndex ?? 0 }));
}

/** Register a model the way `finalizeModel`'s federated branch does. */
function register(model: FederatedModel, geometry: GeometryResult): FederatedModel {
  const maxExpressId = getMaxExpressId(model.ifcDataStore, geometry.meshes, geometry.pointClouds);
  const idOffset = useViewerStore.getState().registerModelOffset(model.id, maxExpressId);
  for (const asset of geometry.pointClouds ?? []) asset.expressId = asset.expressId + idOffset;
  const registered = { ...model, idOffset, maxExpressId, geometryResult: geometry };
  useViewerStore.getState().addModel(registered);
  return registered;
}

/** An IFC model whose entities are `entities`, each owning a (stub) mesh. */
export function addIfcModel(id: string, entities: FixtureEntity[]): FederatedModel {
  const geometry: GeometryResult = {
    meshes: entities.map((entity) => ({ expressId: entity.expressId }) as MeshData), totalVertices: 0, totalTriangles: 0,
    coordinateInfo: undefined as unknown as GeometryResult['coordinateInfo'],
  };
  return register({ id, name: `${id}.ifc`, visible: true, ifcDataStore: fixtureDataStore(entities) } as unknown as FederatedModel, geometry);
}

export interface ScanLoad {
  format: PointCloudFormat;
  blob: Blob;
  createSource: StreamPointCloudOptions['createSource'];
}

/** Stream `scan` through `ingestPointCloud`, then register and bind it as `loadFile` does. */
export async function loadScan(renderer: Renderer, id: string, scan: ScanLoad): Promise<{ model: FederatedModel; handle: { id: number } }> {
  const fileName = `${id}.${scan.format}`;
  const ingest = ingestPointCloud({
    format: scan.format, blob: scan.blob, fileName, fileSize: scan.blob.size, renderer, createSource: scan.createSource,
  });
  await ingest.done;
  const model = register({
    id, name: fileName, visible: true, ifcDataStore: ingest.dataStore, pointCloudHandleId: ingest.rendererHandle.id,
  } as unknown as FederatedModel, ingest.geometryResult);
  bindPointCloudIdentity(renderer, ingest.rendererHandle, id, useViewerStore.getState().models);
  return { model, handle: ingest.rendererHandle };
}
