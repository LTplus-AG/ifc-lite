/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * GPU upload of one prepared instanced template and the registration of its
 * occurrences, shared by `Scene.addInstancedShard` (one template per shard
 * record) and the model-wide keyed slots (`scene-keyed-instancing.ts`).
 */

import { createStaticGpuBuffer } from './gpu-static-upload.js';
import { occurrenceSphereRadius, poolStandInBuffer } from './gpu-instance-pool.js';
import type { SceneInstancePool } from './scene-gpu-instancing.js';
import { createInstancedRteDeltaStream, type InstancedRteDeltaStream } from './instanced-rte.js';
import {
  foldOccurrenceWorldBox,
  INSTANCE_COLOR_OFFSET,
  INSTANCE_FINISH_FLAGS_MASK,
  INSTANCE_FLAGS_OFFSET,
  INSTANCE_STRIDE_BYTES,
  type InstancedRenderTemplate,
} from './instanced-render.js';
import type { ModelTranslations } from './model-translation.js';
import type { BoundingBox } from './scene-raycaster.js';
import { unionInstancedWorldAabb } from './scene-instance-bounds.js';
import type { InstancedOccurrence, InstancedTemplateCpu, InstancedTemplateGPU } from './scene-instance-types.js';

/** The Scene state an instanced upload writes. */
export interface InstanceUploadHost {
  instancedTemplates: (InstancedTemplateGPU | undefined)[];
  instancedTemplateCpu: (InstancedTemplateCpu | undefined)[];
  instancedEntityMap: Map<number, InstancedOccurrence[]>;
  instancedSelected: Set<number>;
  instancedOverrideColors: ReadonlyMap<number, readonly [number, number, number, number]> | null;
  boundingBoxes: Map<number, BoundingBox>;
  modelTranslations: ModelTranslations;
  instancePool: SceneInstancePool;
}

/** Ids whose selection or colour override predates occurrences an upload added. */
export interface LateInstanceIds {
  selected: Set<number>;
  overridden: Set<number>;
}

/**
 * Interleave a template's local positions + normals into the 28-byte
 * (pos3f + norm3f + entityId u32) vertex layout the instanced pipeline's slot 0
 * expects. entityId is a 0 placeholder (vs_instanced ignores it); normals may
 * be shorter/absent on degenerate meshes and default to 0.
 */
export function interleaveTemplateVertices(positions: Float32Array, normals: Float32Array): ArrayBuffer {
  const vcount = Math.floor(positions.length / 3);
  const vtx = new ArrayBuffer(vcount * 28);
  const vf = new Float32Array(vtx);
  for (let i = 0; i < vcount; i++) {
    const o = i * 7;
    vf[o + 0] = positions[i * 3 + 0];
    vf[o + 1] = positions[i * 3 + 1];
    vf[o + 2] = positions[i * 3 + 2];
    vf[o + 3] = i * 3 + 0 < normals.length ? normals[i * 3 + 0] : 0;
    vf[o + 4] = i * 3 + 1 < normals.length ? normals[i * 3 + 1] : 0;
    vf[o + 5] = i * 3 + 2 < normals.length ? normals[i * 3 + 2] : 0;
  }
  return vtx;
}

/** Template-local AABB, used to derive per-occurrence world AABBs cheaply. */
export function templateLocalBox(positions: Float32Array): { min: [number, number, number]; max: [number, number, number] } {
  let lmnx = Infinity, lmny = Infinity, lmnz = Infinity;
  let lmxx = -Infinity, lmxy = -Infinity, lmxz = -Infinity;
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i], y = positions[i + 1], z = positions[i + 2];
    if (x < lmnx) lmnx = x; if (y < lmny) lmny = y; if (z < lmnz) lmnz = z;
    if (x > lmxx) lmxx = x; if (y > lmxy) lmxy = y; if (z > lmxz) lmxz = z;
  }
  return { min: [lmnx, lmny, lmnz], max: [lmxx, lmxy, lmxz] };
}

/**
 * Upload one shard template as its own slot (slots are stable identities,
 * never recycled) and register its occurrences. Empty geometry or no
 * occurrences: nothing.
 */
export function uploadInstancedTemplate(
  host: InstanceUploadHost,
  device: GPUDevice,
  t: InstancedRenderTemplate,
  modelIndex: number,
  late: LateInstanceIds,
): void {
  if (Math.floor(t.positions.length / 3) === 0 || t.indices.length === 0 || t.instanceCount === 0) return;
  const vertexBuffer = createStaticGpuBuffer(device, interleaveTemplateVertices(t.positions, t.normals), GPUBufferUsage.VERTEX);
  const indexBuffer = createStaticGpuBuffer(device, t.indices, GPUBufferUsage.INDEX);
  // instanceBuffer is already the interleaved mat4 + entityId + rgba block
  // (INSTANCE_STRIDE_BYTES per occurrence) from prepareInstancedRender.
  host.modelTranslations.placeInstances(t.instanceBuffer, modelIndex, INSTANCE_STRIDE_BYTES, t.canonicalAnchors, t.canonicalMatrixTranslations);
  // GPU pool: it holds the records and every pass draws from it, so no per-template records or delta stream (stand-ins keep the shape).
  const pooled = host.instancePool.enabled;
  const instanceBuffer = pooled ? poolStandInBuffer(device) : createStaticGpuBuffer(device, new Uint8Array(t.instanceBuffer, 0, t.instanceCount * INSTANCE_STRIDE_BYTES), GPUBufferUsage.VERTEX);
  let rteDeltas: InstancedRteDeltaStream;
  try {
    rteDeltas = createInstancedRteDeltaStream(device, pooled ? 0 : t.instanceCount);
  } catch (error) {
    // Nothing references this template's buffers yet; free them rather than leak them.
    vertexBuffer.destroy(); indexBuffer.destroy(); instanceBuffer.destroy();
    throw error;
  }
  const templateIndex = host.instancedTemplates.length;
  const template: InstancedTemplateGPU = {
    modelIndex, vertexBuffer, indexBuffer, indexCount: t.indices.length, instanceBuffer, instanceCount: t.instanceCount,
    canonicalAnchors: t.canonicalAnchors, rteDeltas, bounds: null, maxOccRadius: 0, selectedCount: 0,
  };
  host.instancedTemplates[templateIndex] = template;
  const box = templateLocalBox(t.positions);
  // Retain the compact CPU geometry + the packed instance records (mat4 per
  // occurrence) so CPU consumers can reach instanced geometry without a full
  // per-occurrence MeshData each. These are references into the decoded shard.
  // Slot-assigned because release empties the CPU array while GPU slots live on; push would misalign them.
  host.instancedTemplateCpu[templateIndex] = {
    modelIndex, positions: t.positions, normals: t.normals, indices: t.indices, instanceData: t.instanceBuffer,
    canonicalAnchors: t.canonicalAnchors, canonicalMatrixTranslations: t.canonicalMatrixTranslations,
    localMin: box.min, localMax: box.max,
  };
  const pool = host.instancePool.ensure(device);
  const poolBase = pool ? pool.allocate(t.instanceCount) : -1;
  const poolRadii = poolBase >= 0 ? new Float32Array(t.instanceCount).fill(Infinity) : null; // -1: past the device limits, not pooled
  registerInstancedOccurrences(host, templateIndex, template, t, 0, box.min, box.max, late, poolBase, poolRadii);
  if (pool && poolRadii) {
    template.poolGroup = pool.addTemplate(templateIndex, poolBase, { vertexBuffer, indexBuffer, indexCount: t.indices.length, positions: t.positions, normals: t.normals, indices: t.indices }, t.instanceBuffer, t.canonicalAnchors, poolRadii);
  }
}

/**
 * Register occurrences `t` as records `firstSlot..` of slot `templateIndex`.
 *
 * Maps each occurrence's express_id -> (template, byte offset, original
 * colour) so selection (flag byte) + lens/IDS overlays (colour bytes) can patch
 * individual occurrences via writeBuffer without a re-upload. Also folds each
 * occurrence's world AABB (template local box × its mat4) into boundingBoxes so
 * getEntityBoundingBox + the CPU raycast-bounds path (BCF anchors,
 * large/released-model picking, frame-selection) see instanced geometry.
 * (Templates with no finite local box — empty geometry — are skipped.)
 */
export function registerInstancedOccurrences(
  host: InstanceUploadHost,
  templateIndex: number,
  template: InstancedTemplateGPU,
  t: InstancedRenderTemplate,
  firstSlot: number,
  localMin: readonly [number, number, number],
  localMax: readonly [number, number, number],
  late: LateInstanceIds,
  poolBase = -1,
  poolRadii: Float32Array | null = null,
): void {
  const [lmnx, lmny, lmnz] = localMin;
  const [lmxx, lmxy, lmxz] = localMax;
  const cdv = new DataView(t.instanceBuffer);
  const haveBox = Number.isFinite(lmnx);
  for (let i = 0; i < t.instanceCount; i++) {
    const byteOffset = i * INSTANCE_STRIDE_BYTES;
    const eid = t.entityIds[i];
    const originalColor: [number, number, number, number] = [
      cdv.getFloat32(byteOffset + INSTANCE_COLOR_OFFSET, true),
      cdv.getFloat32(byteOffset + INSTANCE_COLOR_OFFSET + 4, true),
      cdv.getFloat32(byteOffset + INSTANCE_COLOR_OFFSET + 8, true),
      cdv.getFloat32(byteOffset + INSTANCE_COLOR_OFFSET + 12, true),
    ];
    let arr = host.instancedEntityMap.get(eid);
    if (!arr) {
      arr = [];
      host.instancedEntityMap.set(eid, arr);
    }
    // #2985; no id column or the 0 sentinel ⇒ none. ASSIGNED, never conditionally spread: ONE object shape for records that outlive the shard.
    arr.push({
      templateIndex, byteOffset: (firstSlot + i) * INSTANCE_STRIDE_BYTES, originalColor, itemId: t.itemIds?.[i] || undefined,
      finishBits: (cdv.getUint32(byteOffset + INSTANCE_FLAGS_OFFSET, true) & INSTANCE_FINISH_FLAGS_MASK) >>> 0,
      poolIndex: poolBase >= 0 ? poolBase + i : -1,
    });
    // A shard can stream in AFTER a selection was recorded (its ids may exist
    // in earlier shards or the flat path). setInstancedSelection diffs by id and
    // would early-return on the unchanged set, so seed the late occurrences
    // here: count them for the contribution-cull exemption and remember the id
    // to write its selected flag after the upload.
    if (host.instancedSelected.has(eid)) {
      template.selectedCount++;
      late.selected.add(eid);
    }
    if (host.instancedOverrideColors?.has(eid)) late.overridden.add(eid);
    if (haveBox) {
      const w = unionInstancedWorldAabb(host.boundingBoxes, eid, cdv, byteOffset, t.canonicalAnchors, lmnx, lmny, lmnz, lmxx, lmxy, lmxz);
      // Fold the occurrence's world box into the template's cull metadata
      // (union bounds + largest occurrence bounding-sphere radius) for the
      // per-frame instanced frustum/contribution culls. Non-finite boxes
      // poison the template so it fails OPEN (never culled).
      foldOccurrenceWorldBox(template, w);
      if (poolRadii) poolRadii[i] = occurrenceSphereRadius(w, t.canonicalAnchors, i);
    }
  }
}
