/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { GeometryResult, MeshData } from '@ifc-lite/geometry';
import type { ViewerState } from './index.js';

/** Capture each published mesh prefix. Authoring and streaming append to the
 * live arrays so the renderer can upload only the tail. */
export function captureSettledGeometry(state: ViewerState) {
  const geometries = new WeakMap<GeometryResult, GeometryResult>();
  const buffers = new WeakMap<Float32Array, Float32Array<ArrayBuffer>>();
  let bufferRevision = 0;

  const capture = (source: GeometryResult | null | undefined) => {
    if (!source?.meshes) return source;
    const existing = geometries.get(source);
    if (existing) return existing;
    const { meshes } = source;
    const count = meshes.length;
    let prefix: MeshData[];
    let readRevision = -1;
    const snapshot: GeometryResult = {
      ...source,
      get meshes() {
        if (readRevision === bufferRevision) return prefix;
        prefix = meshes.slice(0, count);
        if (bufferRevision > 0) {
          prefix = prefix.map((mesh) => {
            const positions = buffers.get(mesh.positions);
            const normals = buffers.get(mesh.normals);
            return positions || normals ? { ...mesh, positions: positions ?? mesh.positions, normals: normals ?? mesh.normals } : mesh;
          });
        }
        readRevision = bufferRevision;
        return prefix;
      },
    };
    geometries.set(source, snapshot);
    return snapshot;
  };

  const geometryResult = capture(state.geometryResult) ?? null;
  const modelGeometries = new Map<string, GeometryResult>();
  for (const [id, model] of state.models) {
    const geometry = capture(model.geometryResult);
    if (geometry) modelGeometries.set(id, geometry);
  }

  const preserve = (buffer: Float32Array) => {
    if (buffers.has(buffer)) return;
    buffers.set(buffer, buffer.slice());
    bufferRevision++;
  };
  return {
    geometryResult,
    models: () => new Map([...state.models].map(([id, model]) => {
      const geometry = modelGeometries.get(id);
      return [id, geometry ? { ...model, geometryResult: geometry } : model];
    })),
    preserveMeshBuffers(mesh: MeshData, rotates: boolean) {
      preserve(mesh.positions);
      if (rotates) preserve(mesh.normals);
    },
  };
}
