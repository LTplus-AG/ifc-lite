/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { decodeInstancedShard } from '@ifc-lite/geometry';
import type { StreamingGeometryEvent } from '@ifc-lite/geometry';
import { bounds, type Complete } from './contracts.js';

const meshKeys = new Set(['expressId', 'ifcType', 'modelIndex', 'positions', 'normals', 'indices',
  'appearanceSource', 'color', 'shadingColor', 'entityIds', 'geometryItemId', 'materialId', 'material',
  'geometryHash', 'geometryAabb', 'geometryVolume', 'geometryClass', 'origin', 'occurrenceKey',
  'localBounds', 'localToWorld']);
export async function sha256(bytes: Uint8Array): Promise<string> {
  // Own ArrayBuffer: no SharedArrayBuffer BufferSource cast and no numeric reinterpretation.
  const owned = new Uint8Array(bytes.byteLength);
  owned.set(bytes);
  const digest = await crypto.subtle.digest('SHA-256', owned.buffer);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

function describeFlatChannel(value: unknown) {
  if (ArrayBuffer.isView(value)) return { constructor: value.constructor.name,
    length: 'length' in value ? value.length : null, byteLength: value.byteLength };
  if (Array.isArray(value)) return { constructor: 'Array', length: value.length, byteLength: null };
  return { constructor: value === null ? 'null' : typeof value, length: null, byteLength: null };
}

class Encoder {
  private visits = 0;
  private deadline = performance.now() + bounds.hashMs;
  check(): void {
    if (++this.visits > bounds.objectVisits || performance.now() > this.deadline) {
      throw new Error('post-timing identity work/deadline bound');
    }
  }
  async encode(value: unknown, depth = 0): Promise<unknown> {
    this.check();
    if (depth > 24) throw new Error('identity depth bound');
    if (value === undefined) return ['undefined'];
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
    if (typeof value === 'bigint') return ['bigint', value.toString()];
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) throw new Error('nonfinite scalar identity');
      return ['number', Object.is(value, -0) ? '-0' : value.toString()];
    }
    if (ArrayBuffer.isView(value)) {
      if (value.buffer instanceof SharedArrayBuffer) throw new Error('mutable shared output identity');
      const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
      const chunks: string[] = [];
      for (let offset = 0; offset < bytes.length; offset += bounds.hashChunkBytes) {
        this.check();
        chunks.push(await sha256(bytes.subarray(offset, offset + bounds.hashChunkBytes)));
      }
      return ['view', value.constructor.name, value.byteLength, chunks];
    }
    if (Array.isArray(value)) {
      const output: unknown[] = [];
      for (const item of value) output.push(await this.encode(item, depth + 1));
      return ['array', output];
    }
    if (typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
      const output: unknown[] = [];
      for (const key of Object.keys(value).sort()) {
        output.push([key, await this.encode(Reflect.get(value, key), depth + 1)]);
      }
      return ['object', output];
    }
    throw new Error('unsupported identity value');
  }
  async digest(value: unknown): Promise<string> {
    return sha256(new TextEncoder().encode(JSON.stringify(await this.encode(value))));
  }
}

function admittedShard(buffer: ArrayBuffer): void {
  if (buffer.byteLength < 32) throw new Error('short IFNS header');
  const header = new DataView(buffer);
  const version = header.getUint32(4, true);
  const declared = header.getUint32(28, true);
  const stride = version === 1 || declared === 0 ? 88 : declared;
  if (header.getUint32(8, true) > bounds.identities || header.getUint32(12, true) > bounds.identities) {
    throw new Error('IFNS decoding allocation bound');
  }
  if (header.getUint32(0, true) !== 0x49464e53 || ![1, 2, 3].includes(version)
    || ![88, 92, 100].includes(stride)) throw new Error('unknown IFNS version/appearance tail');
  const expected = 32 + header.getUint32(8, true) * 48 + header.getUint32(12, true) * stride
    + (header.getUint32(16, true) + header.getUint32(20, true) + header.getUint32(24, true)) * 4;
  if (expected !== buffer.byteLength) throw new Error('unowned IFNS trailing/truncated bytes');
}

export async function identity(events: readonly StreamingGeometryEvent[], complete: Complete) {
  const encoder = new Encoder();
  const flat: string[] = [];
  const instances: string[] = [];
  const colors = new Map<number, readonly number[]>();
  let triangles = 0;
  for (const event of events) if (event.type === 'colorUpdate') {
    for (const [id, color] of event.updates) colors.set(id, color);
  }
  const append = (target: string[], digest: string) => {
    if (flat.length + instances.length >= bounds.identities) throw new Error('identity row bound');
    target.push(digest);
  };
  for (const event of events) {
    encoder.check();
    if (event.type !== 'batch') continue;
    for (const mesh of event.meshes) {
      for (const key of Object.keys(mesh)) {
        if (!meshKeys.has(key) && Reflect.get(mesh, key) !== undefined) throw new Error(`unsupported flat output channel: ${key}`);
      }
      if (!(mesh.positions instanceof Float32Array) || !(mesh.normals instanceof Float32Array)
        || !(mesh.indices instanceof Uint32Array) || mesh.positions.length % 3 || mesh.indices.length % 3
        || (mesh.normals.length !== 0 && mesh.normals.length !== mesh.positions.length)) throw new Error(`unsupported flat geometry shape: ${JSON.stringify({
          expressId: mesh.expressId, ifcType: mesh.ifcType ?? null, keys: Object.keys(mesh).sort(),
          positions: describeFlatChannel(mesh.positions), normals: describeFlatChannel(mesh.normals),
          indices: describeFlatChannel(mesh.indices),
        })}`);
      triangles += mesh.indices.length / 3;
      append(flat, await encoder.digest({ mesh, finalColorUpdate: colors.get(mesh.expressId) }));
    }
    for (const shard of event.instancedShards ?? []) {
      admittedShard(shard);
      const decoded = decodeInstancedShard(shard);
      const templates: string[] = [];
      const used = new Set<number>();
      for (const template of decoded.templates) {
        if (!(template.positions instanceof Float32Array) || !(template.normals instanceof Float32Array)
          || !(template.indices instanceof Uint32Array) || template.positions.length % 3 || template.indices.length % 3
          || (template.normals.length !== 0 && template.normals.length !== template.positions.length)) {
          throw new Error('unsupported instance template shape');
        }
        templates.push(await encoder.digest(template));
      }
      for (const instance of decoded.instances) {
        const template = decoded.templates[instance.templateIndex];
        if (!template || instance.transform.length !== 16) throw new Error('unowned occurrence/template');
        used.add(instance.templateIndex);
        triangles += template.indices.length / 3;
        const { templateIndex, ...occurrence } = instance;
        append(instances, await encoder.digest({ template: templates[templateIndex], occurrence,
          carriesItemIds: decoded.carriesItemIds, carriesFinishes: decoded.carriesFinishes,
          finalColorUpdate: colors.get(instance.entityId) }));
      }
      if (used.size !== templates.length) throw new Error('unowned instanced template');
    }
    // Hashing is off by default. Refuse unexpected enabled hash channels rather than lose their ID association.
    for (const key of ['instancedGeometryHashIds', 'instancedGeometryHashValues',
      'instancedGeometryAabbValues', 'instancedGeometryVolumeValues'] as const) {
      if (event[key] !== undefined) throw new Error(`unexpected default output channel: ${key}`);
    }
  }
  if (flat.length + instances.length !== complete.totalMeshes || complete.totalMeshes === 0) {
    throw new Error('complete mesh census mismatch/empty model');
  }
  const colorRows = [...colors.entries()].sort(([left], [right]) => left - right);
  return { sha256: await encoder.digest({ scope: 'canonical-pool-cpu-v1', flat: flat.sort(),
    instances: instances.sort(), colors: colorRows, coordinateInfo: complete.coordinateInfo }),
    flat: flat.length, occurrences: instances.length, triangles };
}
