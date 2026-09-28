/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Camera-relative instance deltas shared by colour, pick, shadow and the
 * selection mask.
 *
 * Each instanced template owns an {@link InstancedRteDeltaStream}: a vertex
 * buffer (slot 2 of `INSTANCED_VERTEX_BUFFERS`) holding one split
 * `(drawable - camera)` high/low vec4 pair per occurrence, packed on the CPU
 * in f64 from `canonicalAnchors`. It is kept apart from the static instance
 * record so a camera move rewrites it with ONE `writeBuffer` per template
 * rather than one 32-byte write per occurrence per pass, which on a model
 * with ~45K instanced occurrences was tens of thousands of queue writes per
 * frame and most of the submit latency (#6393).
 *
 * QUEUE ORDERING. `writeBuffer` is ordered before the next `queue.submit`,
 * not before the individual pass that reads it, so a stream holds exactly one
 * camera's deltas per submission. Every pass that shares a submission must
 * therefore use the same camera: the colour pass, the shadow depth pre-pass
 * and the selection mask are all encoded into the frame's one encoder with
 * `relativeToEyeFrame.getCameraWorld()`, and the picker records and submits
 * its own encoder. The per-stream camera cache is what turns those three
 * same-frame calls into one upload; two different cameras inside ONE
 * submission would make the earlier pass read the later camera's deltas.
 */

import { tryPackRteDrawableDelta, type WorldPoint } from './relative-to-eye.js';

/** Bytes per occurrence in a delta stream: high vec4 + low vec4. */
export const INSTANCED_RTE_DELTA_STRIDE_BYTES = 32;
const DELTA_FLOATS = INSTANCED_RTE_DELTA_STRIDE_BYTES / 4;

/** A contiguous `[first, first + count)` instance range, drawn via `firstInstance`. */
export interface InstanceRun {
  readonly first: number;
  readonly count: number;
}

/** One template's GPU delta stream plus the camera it currently holds. */
export interface InstancedRteDeltaStream {
  /** VERTEX | COPY_DST, `instanceCount * 32` bytes, bound at vertex slot 2. */
  readonly buffer: GPUBuffer;
  /** CPU staging, 8 floats per occurrence at `instance * 8`. */
  readonly scratch: Float32Array;
  /** Camera whose deltas `buffer` holds, or null when it must be rewritten. */
  camera: WorldPoint | null;
  /** Drawable runs for `camera` (out-of-envelope occurrences excluded). */
  runs: readonly InstanceRun[];
}

export interface InstancedRteTemplate {
  instanceCount: number;
  /** Canonical f64 Y-up drawable origins, xyz for each instance. */
  canonicalAnchors: Float64Array;
  rteDeltas: InstancedRteDeltaStream;
}

/** Allocate a template's delta stream; it holds no camera until first uploaded. */
export function createInstancedRteDeltaStream(device: GPUDevice, instanceCount: number): InstancedRteDeltaStream {
  const buffer = device.createBuffer({
    label: 'instanced-rte-deltas',
    size: Math.max(1, instanceCount) * INSTANCED_RTE_DELTA_STRIDE_BYTES,
    usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
  });
  return { buffer, scratch: new Float32Array(instanceCount * DELTA_FLOATS), camera: null, runs: [] };
}

/** Force the next upload to repack every occurrence (its canonical anchors changed). */
export function invalidateInstancedRteDeltas(stream: InstancedRteDeltaStream): void {
  stream.camera = null;
}

const sameCamera = (a: WorldPoint | null, b: WorldPoint): boolean =>
  a !== null && a[0] === b[0] && a[1] === b[1] && a[2] === b[2];

/**
 * Bring each template's delta stream to `camera` and return its drawable runs
 * (one list per template, in order).
 *
 * This is the sole writer of the delta streams. It applies the shared f64
 * boundary/envelope check before any f32 rounding, so a colour, picker,
 * shadow or mask pass cannot independently subtract two large rounded
 * origins on the GPU. An occurrence outside the camera-relative envelope
 * cannot be rasterised this frame and its lanes stay stale, so it is left out
 * of the runs; draw them with `drawInstanceRuns` (#6128).
 *
 * A stream already holding `camera` (exact component equality) returns its
 * cached runs with no queue write; otherwise the packed span from the first
 * run's start to the last run's end is uploaded in one `writeBuffer` (#6393).
 * See the module comment for the one-camera-per-submission contract.
 */
export function uploadInstancedRteDeltas(
  device: GPUDevice,
  templates: readonly InstancedRteTemplate[],
  camera: WorldPoint,
): (readonly InstanceRun[])[] {
  return templates.map((template) => {
    if (template.canonicalAnchors.length !== template.instanceCount * 3) {
      throw new RangeError('Instanced RTE anchors do not match the instance-buffer record count.');
    }
    const stream = template.rteDeltas;
    if (sameCamera(stream.camera, camera)) return stream.runs;
    const anchors = template.canonicalAnchors;
    const runs = collectInstanceRuns(template.instanceCount, (instance) => {
      const source = instance * 3;
      return tryPackRteDrawableDelta(
        [anchors[source]!, anchors[source + 1]!, anchors[source + 2]!],
        camera,
        stream.scratch,
        instance * DELTA_FLOATS,
      );
    });
    if (runs.length > 0) {
      const first = runs[0]!.first;
      const last = runs[runs.length - 1]!;
      const end = last.first + last.count;
      device.queue.writeBuffer(
        stream.buffer,
        first * INSTANCED_RTE_DELTA_STRIDE_BYTES,
        stream.scratch.subarray(first * DELTA_FLOATS, end * DELTA_FLOATS),
      );
    }
    stream.camera = [camera[0], camera[1], camera[2]];
    stream.runs = runs;
    return runs;
  });
}

/**
 * Visit instances `0..count-1` in order and group those for which `drawable`
 * returns true into maximal contiguous runs. `drawable` is called exactly once
 * per instance, so it may also perform that instance's packing.
 */
export function collectInstanceRuns(count: number, drawable: (instance: number) => boolean): InstanceRun[] {
  const runs: InstanceRun[] = [];
  let runStart = -1;
  for (let instance = 0; instance < count; instance++) {
    if (drawable(instance)) {
      if (runStart < 0) runStart = instance;
    } else if (runStart >= 0) {
      runs.push({ first: runStart, count: instance - runStart });
      runStart = -1;
    }
  }
  if (runStart >= 0) runs.push({ first: runStart, count: count - runStart });
  return runs;
}

/** Draw the refreshed instance runs of the bound buffers; returns the draw-call count. */
export function drawInstanceRuns(
  pass: GPURenderPassEncoder,
  indexCount: number,
  runs: readonly InstanceRun[],
): number {
  for (const run of runs) pass.drawIndexed(indexCount, run.count, 0, 0, run.first);
  return runs.length;
}
