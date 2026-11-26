/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Model-wide instanced templates for keyed IFNS shards (the global instance
 * plan, `?perf.globalInstancing=1`).
 *
 * A keyed shard names each template record with a model-wide key (its `IFNL`
 * trailer, `DecodedInstancedShard.templateKeys`) and every record carries its
 * geometry. Records of one `(model, key)` join into ONE growable scene slot,
 * so a key is one template and one draw however many batches and workers fed
 * it. A shard without keys, or a keyed record without geometry, uploads as
 * before.
 *
 * Growth is amortised: the slot's GPU instance buffer, CPU record block and
 * anchor arrays have a power-of-two capacity; an append within capacity is a
 * `writeBuffer` of the new tail. While a slot is OPEN, its template's
 * `instanceData` is that capacity block (`instanceCount` is the live count)
 * and its anchor arrays are exact-length views into the backing.
 *
 * Consumers that size work from `instanceData.byteLength` — model placement
 * (`ModelTranslations.placeInstances`) and device-loss recovery — need exact
 * blocks, so a slot only opens while its model sits at the identity pose, and
 * {@link KeyedInstancing.seal} turns open slots into ordinary exact-length
 * templates before either runs. A sealed model's later keyed records upload as
 * ordinary per-shard templates: correct, with one draw per record as today.
 */

import type { DecodedInstancedShard } from '@ifc-lite/geometry';
import { createStaticGpuBuffer } from './gpu-static-upload.js';
import { createInstancedRteDeltaStream, extendInstancedRteDeltas } from './instanced-rte.js';
import { INSTANCE_STRIDE_BYTES, type InstancedRenderTemplate } from './instanced-render.js';
import {
  interleaveTemplateVertices,
  registerInstancedOccurrences,
  templateLocalBox,
  type InstanceUploadHost,
  type LateInstanceIds,
  uploadInstancedTemplate,
} from './scene-instance-upload.js';
import type { InstancedTemplateGPU } from './scene-instance-types.js';

/** The growable backing behind one open keyed slot. */
interface KeyedSlot {
  templateIndex: number;
  /** The defining record's geometry; a later record whose geometry differs uploads on its own. */
  def: { positions: Float32Array; normals: Float32Array; indices: Uint32Array };
  capacity: number;
  anchors: Float64Array;
  matrixTranslations: Float32Array;
}

/** A slot's growable backing at `capacity` records: GPU instance buffer, delta stream, anchors. */
function allocBacking(device: GPUDevice, capacity: number) {
  const instanceBuffer = device.createBuffer({ size: capacity * INSTANCE_STRIDE_BYTES, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
  try {
    const rteDeltas = createInstancedRteDeltaStream(device, capacity);
    return { instanceBuffer, rteDeltas, anchors: new Float64Array(capacity * 3), matrixTranslations: new Float32Array(capacity * 3) };
  } catch (error) {
    instanceBuffer.destroy(); // nothing references it yet
    throw error;
  }
}

/** Records of one key agree on geometry up to f32 noise (each batch takes its template back to the
 *  local frame itself); a vertex further apart than this is different geometry. */
const VERTEX_TOLERANCE_M = 1e-4;
/** Unit normals of one key agree up to the same noise. */
const NORMAL_TOLERANCE = 1e-3;

function within(a: Float32Array, b: Float32Array, tolerance: number): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (!(Math.abs(a[i] - b[i]) <= tolerance)) return false;
  return true;
}

/**
 * Whether `chunk` carries the slot's geometry: identical indices, and local positions
 * and normals within f32 noise. Each record's instance matrix folds in its own template
 * origin (`rel · T(origin)`), so drawing it with the slot's positions is exact when the
 * LOCAL positions agree, whatever the origins. The engine verifies each occurrence
 * against its own batch's template, not across batches, so comparing the buffers
 * themselves is the join's check: records with equal counts and bounds but different
 * geometry never share a template.
 */
function sameGeometry(def: KeyedSlot['def'], chunk: InstancedRenderTemplate): boolean {
  if (def.indices.length !== chunk.indices.length || def.positions.length !== chunk.positions.length) return false;
  for (let i = 0; i < def.indices.length; i++) if (def.indices[i] !== chunk.indices[i]) return false;
  return within(def.positions, chunk.positions, VERTEX_TOLERANCE_M) && within(def.normals, chunk.normals, NORMAL_TOLERANCE);
}

/** The slot capacity for `needed` records: the next power of two, clamped to the device's
 *  buffer limit; 0 when even `needed` records do not fit. */
function slotCapacity(device: GPUDevice, needed: number): number {
  const limit = Math.floor((device.limits?.maxBufferSize ?? Number.POSITIVE_INFINITY) / INSTANCE_STRIDE_BYTES);
  return needed > limit ? 0 : Math.min(keyedCapacityFor(needed), limit);
}

/** A keyed record of one shard: append `chunk` to the `(model, key)` slot. */
export interface KeyedAppend {
  slotKey: string;
  chunk: InstancedRenderTemplate;
}

/** Smallest power of two >= n (min 16). */
function keyedCapacityFor(n: number): number {
  let c = 16;
  while (c < n) c *= 2;
  return c;
}

export class KeyedInstancing {
  private readonly slots = new Map<string, KeyedSlot>();
  private readonly sealedModels = new Set<number>();
  /** On by default: only the global instance plan writes keyed shards, so a keyed
   *  shard joins whatever path uploads it (stream, adopted snapshot, recovery) and
   *  whatever a flag reads now. Setting this to false opts the scene out. */
  enabled = true;
  /** Models that received keyed shards while enabled (the plan applied to them), joined or not. */
  private readonly keyedModels = new Set<number>();

  /** Whether any model still in the scene received keyed shards: the global instance plan applied to it. */
  get receivedKeyedShards(): boolean {
    return this.keyedModels.size > 0;
  }

  /** Open keyed slots (diagnostics). */
  get openSlots(): number {
    return this.slots.size;
  }

  /**
   * Split a shard's prepared templates: keyed records with geometry join their
   * `(model, key)` slot; everything else uploads as before. `eligible` is the
   * Scene's verdict that slots may open: the shard is keyed, the GPU instance
   * pool is off (pooled records live in the pool), and the model sits at the
   * identity pose. A sealed model never opens slots.
   */
  route(shard: DecodedInstancedShard, prepared: InstancedRenderTemplate[], modelIndex: number, eligible: boolean): {
    plain: InstancedRenderTemplate[];
    keyed: KeyedAppend[];
  } {
    const keys = shard.templateKeys;
    if (this.enabled && !this.keyedModels.has(modelIndex) && keys?.some((key) => key !== '')) this.keyedModels.add(modelIndex);
    if (!this.enabled || !keys || !eligible || this.sealedModels.has(modelIndex)) return { plain: prepared, keyed: [] };
    const plain: InstancedRenderTemplate[] = [];
    const keyed: KeyedAppend[] = [];
    for (const chunk of prepared) {
      const key = keys[chunk.templateIndex] ?? '';
      if (key === '' || chunk.indices.length === 0 || chunk.positions.length === 0) plain.push(chunk);
      else keyed.push({ slotKey: `${modelIndex}|${key}`, chunk });
    }
    return { plain, keyed };
  }

  /**
   * Append one keyed record, creating its slot on first use and doubling its
   * capacity when full. A record whose geometry does not match the slot's, or
   * that would grow the slot past the device's buffer limit, uploads as its own
   * template instead.
   */
  append(host: InstanceUploadHost, device: GPUDevice, { slotKey, chunk }: KeyedAppend, modelIndex: number, late: LateInstanceIds): void {
    const n = chunk.instanceCount;
    if (n === 0) return;
    const existing = this.slots.get(slotKey);
    const needed = (existing ? (host.instancedTemplates[existing.templateIndex]?.instanceCount ?? 0) : 0) + n;
    const capacity = existing && needed <= existing.capacity ? existing.capacity : slotCapacity(device, needed);
    if ((existing && !sameGeometry(existing.def, chunk)) || capacity === 0) {
      uploadInstancedTemplate(host, device, chunk, modelIndex, late);
      return;
    }
    const slot = existing ?? this.open(host, device, slotKey, chunk, modelIndex, capacity);
    const template = host.instancedTemplates[slot.templateIndex];
    const cpu = host.instancedTemplateCpu[slot.templateIndex];
    if (!template || !cpu) return;
    const count = template.instanceCount;
    if (count + n > slot.capacity) this.grow(device, slot, template, cpu, capacity);
    const bytes = new Uint8Array(chunk.instanceBuffer, 0, n * INSTANCE_STRIDE_BYTES);
    new Uint8Array(cpu.instanceData).set(bytes, count * INSTANCE_STRIDE_BYTES);
    device.queue.writeBuffer(template.instanceBuffer, count * INSTANCE_STRIDE_BYTES, bytes);
    slot.anchors.set(chunk.canonicalAnchors, count * 3);
    slot.matrixTranslations.set(chunk.canonicalMatrixTranslations, count * 3);
    template.instanceCount = count + n;
    template.canonicalAnchors = cpu.canonicalAnchors = slot.anchors.subarray(0, (count + n) * 3);
    cpu.canonicalMatrixTranslations = slot.matrixTranslations.subarray(0, (count + n) * 3);
    // Pack only the appended tail for the camera the stream holds (a grown,
    // fresh stream holds none and repacks once): invalidating here would
    // repack every occurrence of the template on every streaming frame.
    extendInstancedRteDeltas(device, template.rteDeltas, template.canonicalAnchors, count, n);
    registerInstancedOccurrences(host, slot.templateIndex, template, chunk, count, cpu.localMin, cpu.localMax, late);
  }

  private open(host: InstanceUploadHost, device: GPUDevice, slotKey: string, def: InstancedRenderTemplate, modelIndex: number, capacity: number): KeyedSlot {
    const box = templateLocalBox(def.positions);
    const vertexBuffer = createStaticGpuBuffer(device, interleaveTemplateVertices(def.positions, def.normals), GPUBufferUsage.VERTEX);
    let indexBuffer: GPUBuffer | undefined, backing: ReturnType<typeof allocBacking>;
    try {
      indexBuffer = createStaticGpuBuffer(device, def.indices, GPUBufferUsage.INDEX);
      backing = allocBacking(device, capacity);
    } catch (error) {
      vertexBuffer.destroy(); indexBuffer?.destroy(); // nothing references them yet
      throw error;
    }
    const { instanceBuffer, rteDeltas, anchors, matrixTranslations } = backing;
    const templateIndex = host.instancedTemplates.length;
    host.instancedTemplates[templateIndex] = {
      modelIndex, vertexBuffer, indexBuffer, indexCount: def.indices.length, instanceBuffer, instanceCount: 0,
      canonicalAnchors: anchors.subarray(0, 0), rteDeltas,
      bounds: null, maxOccRadius: 0, selectedCount: 0,
    };
    host.instancedTemplateCpu[templateIndex] = {
      modelIndex, positions: def.positions, normals: def.normals, indices: def.indices,
      instanceData: new ArrayBuffer(capacity * INSTANCE_STRIDE_BYTES),
      canonicalAnchors: anchors.subarray(0, 0), canonicalMatrixTranslations: matrixTranslations.subarray(0, 0),
      localMin: box.min, localMax: box.max,
    };
    const slot: KeyedSlot = { templateIndex, def: { positions: def.positions, normals: def.normals, indices: def.indices }, capacity, anchors, matrixTranslations };
    this.slots.set(slotKey, slot);
    return slot;
  }

  private grow(device: GPUDevice, slot: KeyedSlot, template: InstancedTemplateGPU, cpu: { instanceData: ArrayBuffer }, capacity: number): void {
    const count = template.instanceCount;
    const data = new ArrayBuffer(capacity * INSTANCE_STRIDE_BYTES);
    new Uint8Array(data).set(new Uint8Array(cpu.instanceData, 0, count * INSTANCE_STRIDE_BYTES));
    const next = allocBacking(device, capacity);
    next.anchors.set(slot.anchors.subarray(0, count * 3));
    next.matrixTranslations.set(slot.matrixTranslations.subarray(0, count * 3));
    if (count > 0) device.queue.writeBuffer(next.instanceBuffer, 0, data, 0, count * INSTANCE_STRIDE_BYTES);
    template.instanceBuffer.destroy();
    template.rteDeltas.buffer.destroy();
    template.instanceBuffer = next.instanceBuffer;
    template.rteDeltas = next.rteDeltas;
    cpu.instanceData = data;
    Object.assign(slot, { capacity, anchors: next.anchors, matrixTranslations: next.matrixTranslations });
  }

  /**
   * Turn the open slots of `modelIndex` (every model when omitted) into
   * ordinary exact-length templates and stop opening slots for it. Run before
   * anything sizes work from `instanceData.byteLength`: a model placement or a
   * device-loss recovery.
   */
  seal(host: InstanceUploadHost, modelIndex?: number): void {
    for (const [slotKey, slot] of this.slots) {
      const cpu = host.instancedTemplateCpu[slot.templateIndex];
      const template = host.instancedTemplates[slot.templateIndex];
      const model = cpu?.modelIndex ?? template?.modelIndex;
      if (modelIndex !== undefined && model !== modelIndex) continue;
      this.slots.delete(slotKey);
      if (modelIndex === undefined && model !== undefined) this.sealedModels.add(model);
      if (!cpu || !template) continue;
      const count = template.instanceCount;
      cpu.instanceData = cpu.instanceData.slice(0, count * INSTANCE_STRIDE_BYTES);
      template.canonicalAnchors = cpu.canonicalAnchors = slot.anchors.slice(0, count * 3);
      cpu.canonicalMatrixTranslations = slot.matrixTranslations.slice(0, count * 3);
    }
    if (modelIndex !== undefined) this.sealedModels.add(modelIndex);
  }

  /** Forget one model's slots (its templates were freed). */
  removeModel(modelIndex: number): void {
    const prefix = `${modelIndex}|`;
    for (const key of [...this.slots.keys()]) if (key.startsWith(prefix)) this.slots.delete(key);
    this.sealedModels.delete(modelIndex);
    this.keyedModels.delete(modelIndex);
  }

  clear(): void {
    this.slots.clear();
    this.sealedModels.clear();
    this.keyedModels.clear();
  }
}
