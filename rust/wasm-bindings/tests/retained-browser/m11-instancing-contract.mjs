// SPDX-License-Identifier: MPL-2.0
// #7955: consumes real retained session events before their WASM handles are freed.
export function instancingContract() {
  const meshes = [], keys = [], shapeKeys = [], faceTables = [];
  return {
    collect(event) {
      if (!event.instanceKey) throw Error('mapped product has no instance key');
      const faces = event.faces ?? event.parts?.map(part => part.faces);
      if (faces?.length !== 1 || faces[0]?.table.length !== 6 || faces[0]?.triangles.length !== 12) {
        throw Error('M11-F must supply all six face keys before the M11-I key witness');
      }
      faceTables.push({ table: Array.from(faces[0].table), triangles: Array.from(faces[0].triangles) });
      if (!event.meshes) { shapeKeys.push(event.instanceKey); return; }
      if (event.meshes.length !== 1 || !event.instanceWorldFromObject) throw Error('mapped view has no composed frame');
      const mesh = event.meshes.get(0);
      try {
        meshes.push({ expressId: mesh.expressId, ifcType: mesh.ifcType, positions: mesh.positions,
          normals: mesh.normals, indices: mesh.indices, color: mesh.color, origin: Array.from(mesh.origin),
          geometryClass: mesh.geometryClass, worldFromObject: event.instanceWorldFromObject });
        keys.push(event.instanceKey);
      } finally { mesh.free(); }
    },
    async finish(wasm, rtc) {
      if (meshes.length !== 64 || new Set(keys).size !== 1 || shapeKeys.length !== 64
        || shapeKeys.some(key => key !== keys[0])) throw Error('64 occurrences must share one byte-equal key across view/shape');
      const result = wasm.encodeInstancedShard(meshes, keys, rtc);
      if (result.groupCount !== 1 || result.instanceCount !== 64 || result.flatIndices.length
        || result.verificationRejections) throw Error('one verified group of 64 required');
      const header = new DataView(result.shard.buffer, result.shard.byteOffset, result.shard.byteLength);
      const flatIndices = meshes.reduce((sum, mesh) => sum + mesh.indices.length, 0);
      if (header.getUint32(0, true) !== 0x49464e53 || header.getUint32(8, true) !== 1
        || header.getUint32(12, true) !== 64 || header.getUint32(24, true) * 64 !== flatIndices) throw Error('IFNS triangle coverage changed');
      const response = await fetch('/smlib/m11-i-native-instances.json');
      if (!response.ok) throw Error('M11-I native reference missing');
      const native = await response.json();
      if (native.key !== keys[0] || native.groups !== result.groupCount
        || native.occurrences !== result.instanceCount || native.triangles !== flatIndices / 3
        || JSON.stringify(native.ids) !== JSON.stringify(meshes.map(mesh => mesh.expressId))
        || faceTables.some(faces => JSON.stringify(faces.table) !== JSON.stringify(native.faceKeysPerPart)
          || JSON.stringify(faces.triangles) !== JSON.stringify(native.triangleFacesPerPart))) {
        throw Error('M11-I native/browser key bytes, triangle counts or face tables differ');
      }
      return { key: keys[0], groups: result.groupCount, occurrences: result.instanceCount,
        verificationRejections: result.verificationRejections, triangles: flatIndices / 3 };
    },
  };
}
