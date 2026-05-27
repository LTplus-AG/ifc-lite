/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { GeometryQuality, GeometryResult, MeshData } from '@ifc-lite/geometry';
import { GeometryProcessor } from '@ifc-lite/geometry';
import { GLTFExporter } from './gltf-exporter.js';
import { extractGlbMapping } from './glb.js';
import { generateLod0 } from './lod0-generator.js';
import type { GenerateLod1Result, Lod1MetaJson, Lod0Json, LodInput, Vec3 } from './lod-geometry-types.js';
import { toIfcArrayBuffer } from './lod-geometry-utils.js';

export type GenerateLod1Options = {
  quality?: GeometryQuality;
  /**
   * Test-only hook to simulate meshing failure and force fallback.
   * Not intended for production use.
   */
  __forceMeshingErrorForTest?: boolean;
};

function buildBoxMeshFromAabb(min: Vec3, max: Vec3, expressId: number): MeshData {
  // 24 vertices (4 per face) with correct per-face normals
  const x0 = min[0], y0 = min[1], z0 = min[2];
  const x1 = max[0], y1 = max[1], z1 = max[2];
  // prettier-ignore
  const positions = new Float32Array([
    // bottom (z0) - normal [0,0,-1]
    x0,y0,z0,  x1,y0,z0,  x1,y1,z0,  x0,y1,z0,
    // top (z1) - normal [0,0,1]
    x0,y0,z1,  x1,y0,z1,  x1,y1,z1,  x0,y1,z1,
    // front (y0) - normal [0,-1,0]
    x0,y0,z0,  x1,y0,z0,  x1,y0,z1,  x0,y0,z1,
    // back (y1) - normal [0,1,0]
    x0,y1,z0,  x1,y1,z0,  x1,y1,z1,  x0,y1,z1,
    // left (x0) - normal [-1,0,0]
    x0,y0,z0,  x0,y1,z0,  x0,y1,z1,  x0,y0,z1,
    // right (x1) - normal [1,0,0]
    x1,y0,z0,  x1,y1,z0,  x1,y1,z1,  x1,y0,z1,
  ]);

  // prettier-ignore
  const normals = new Float32Array([
    0,0,-1, 0,0,-1, 0,0,-1, 0,0,-1,   // bottom
    0,0, 1, 0,0, 1, 0,0, 1, 0,0, 1,   // top
    0,-1,0, 0,-1,0, 0,-1,0, 0,-1,0,   // front
    0, 1,0, 0, 1,0, 0, 1,0, 0, 1,0,   // back
    -1,0,0, -1,0,0, -1,0,0, -1,0,0,   // left
     1,0,0,  1,0,0,  1,0,0,  1,0,0,   // right
  ]);

  // 12 triangles (two per face), referencing 24 vertices
  // Winding order follows right-hand rule so cross(e1,e2) matches the declared normal.
  // prettier-ignore
  const indices = new Uint32Array([
    0,2,1, 0,3,2,       // bottom  (normal  0, 0,-1)
    4,5,6, 4,6,7,       // top     (normal  0, 0, 1)
    8,9,10, 8,10,11,    // front   (normal  0,-1, 0)
    12,14,13, 12,15,14, // back    (normal  0, 1, 0)
    16,18,17, 16,19,18, // left    (normal -1, 0, 0)
    20,21,22, 20,22,23, // right   (normal  1, 0, 0)
  ]);

  return {
    expressId,
    positions,
    normals,
    indices,
    color: [0.8, 0.8, 0.8, 1],
    ifcType: 'IfcBuildingElementProxy',
  };
}

function buildFallbackGeometryFromLod0(lod0: Lod0Json): { meshes: MeshData[]; failed: number[] } {
  const meshes: MeshData[] = [];
  const failed: number[] = [];
  for (const el of lod0.elements) {
    try {
      meshes.push(buildBoxMeshFromAabb(el.bbox.min, el.bbox.max, el.expressID));
    } catch {
      failed.push(el.expressID);
    }
  }
  return { meshes, failed };
}

function emptyCoordinateInfo(): GeometryResult['coordinateInfo'] {
  const zero = { x: 0, y: 0, z: 0 };
  return {
    originShift: zero,
    originalBounds: { min: { ...zero }, max: { ...zero } },
    shiftedBounds: { min: { ...zero }, max: { ...zero } },
    hasLargeCoordinates: false,
  };
}

async function processGeometryAdaptive(gp: GeometryProcessor, buffer: ArrayBuffer): Promise<GeometryResult> {
  const meshes: MeshData[] = [];
  let coordinateInfo: GeometryResult['coordinateInfo'] | null = null;

  for await (const event of gp.processAdaptive(new Uint8Array(buffer), {
    // LOD export is not latency-sensitive UI work. Force the async streaming
    // strategy so this path does not call the legacy sync parseMeshes API.
    sizeThreshold: 0,
  })) {
    if (event.type === 'batch') {
      meshes.push(...event.meshes);
      coordinateInfo = event.coordinateInfo ?? coordinateInfo;
    } else if (event.type === 'complete') {
      coordinateInfo = event.coordinateInfo;
    }
  }

  return {
    meshes,
    totalTriangles: meshes.reduce((sum, mesh) => sum + mesh.indices.length / 3, 0),
    totalVertices: meshes.reduce((sum, mesh) => sum + mesh.positions.length / 3, 0),
    coordinateInfo: coordinateInfo ?? emptyCoordinateInfo(),
  };
}

export async function generateLod1(input: LodInput, options: GenerateLod1Options = {}): Promise<GenerateLod1Result> {
  // LOD0 is mandatory and used for degraded detection + fallback.
  const lod0 = await generateLod0(input);
  const allExpress = new Set<number>(lod0.elements.map((e) => e.expressID));

  const notes: string[] = [];

  try {
    if (options.__forceMeshingErrorForTest) {
      throw new Error('Forced meshing failure for test');
    }

    const buffer = toIfcArrayBuffer(input);
    const gp = new GeometryProcessor({ quality: options.quality });
    await gp.init();
    const geom = await processGeometryAdaptive(gp, buffer);

    const exporter = new GLTFExporter(geom);
    const glb = exporter.exportGLB({ includeMetadata: true });
    const mapping = extractGlbMapping(glb);

    const mappedIds = new Set<number>(Object.keys(mapping).map((k) => Number(k)).filter((n) => Number.isFinite(n)));
    const failedElements: number[] = [];
    for (const id of allExpress) {
      if (!mappedIds.has(id)) failedElements.push(id);
    }

    const status: Lod1MetaJson['status'] = failedElements.length > 0 ? 'degraded' : 'ok';
    if (status === 'degraded') {
      notes.push('Some elements did not produce mesh output; GLB contains partial geometry.');
    }

    const meta: Lod1MetaJson = {
      schema: 'ifc-lite-geometry',
      lod: 1,
      status,
      failedElements,
      notes,
      mapping,
    };

    return { glb, meta };
  } catch (e: unknown) {
    // Full failure => mandatory fallback GLB from LOD0 bboxes
    const errMsg = e instanceof Error ? e.message : String(e);
    notes.push(`Meshing failed; using fallback boxes from LOD0. (${errMsg})`);

    const { meshes } = buildFallbackGeometryFromLod0(lod0);
    const fallbackResult: GeometryResult = {
      meshes,
      totalTriangles: meshes.reduce((s, m) => s + m.indices.length / 3, 0),
      totalVertices: meshes.reduce((s, m) => s + m.positions.length / 3, 0),
      coordinateInfo: emptyCoordinateInfo(),
    };
    const exporter = new GLTFExporter(fallbackResult);

    const glb = exporter.exportGLB({ includeMetadata: true });
    const mapping = extractGlbMapping(glb);

    const meta: Lod1MetaJson = {
      schema: 'ifc-lite-geometry',
      lod: 1,
      status: 'degraded',
      fallback: 'boxes_from_lod0',
      failedElements: lod0.elements.map((x) => x.expressID),
      notes,
      mapping,
    };

    return { glb, meta };
  }
}
