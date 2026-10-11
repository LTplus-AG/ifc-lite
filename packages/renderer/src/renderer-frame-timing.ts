/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Bounded, opt-in renderer timing ownership (#6975). No instrumentation globals. */
import { GpuFrameTimingRecorder } from './frame-timing-gpu.js';
import { passDurationsMs } from './frame-timing.js';

const MAX_SAMPLES = 256;
const MAX_PASSES = 16;

export interface RendererGpuTimingSnapshot {
  mode: 'disabled' | 'unsupported' | 'gpu-queries';
  epoch: number;
  sampled: number;
  skipped: number;
  overwritten: number;
  errors: number;
  frames: { timestamp: number; passesMs: Record<string, number> }[];
}

interface TimingState {
  enabled: boolean;
  device: GPUDevice | null;
  recorder: GpuFrameTimingRecorder | null;
  pending: boolean;
  snapshot: RendererGpuTimingSnapshot;
}

const owners = new WeakMap<object, TimingState>();
const encoders = new WeakMap<GPUCommandEncoder, { recorder: GpuFrameTimingRecorder; state: TimingState; complete: boolean }>();
const empty = (): RendererGpuTimingSnapshot => ({
  mode: 'disabled', epoch: 0, sampled: 0, skipped: 0, overwritten: 0, errors: 0, frames: [],
});

export function configureRendererGpuTiming(owner: object, enabled: boolean): void {
  const epoch = (owners.get(owner)?.snapshot.epoch ?? 0) + 1;
  releaseRendererGpuTiming(owner);
  owners.set(owner, { enabled, device: null, recorder: null, pending: false, snapshot: { ...empty(), epoch } });
}

/** Preserve opt-in intent across device recovery; never preserve old-device resources. */
export function releaseRendererGpuTiming(owner: object): void {
  const state = owners.get(owner);
  if (!state) return;
  state.recorder?.destroy();
  state.recorder = null;
  state.device = null;
  state.pending = false;
  state.snapshot = { ...empty(), epoch: state.snapshot.epoch + 1 };
}

export function readRendererGpuTiming(owner: object): RendererGpuTimingSnapshot {
  const snapshot = owners.get(owner)?.snapshot;
  return snapshot ? { ...snapshot, frames: snapshot.frames.map((frame) => ({
    timestamp: frame.timestamp, passesMs: { ...frame.passesMs },
  })) } : empty();
}

export function beginRendererGpuTiming(owner: object, device: GPUDevice, encoder: GPUCommandEncoder): void {
  const state = owners.get(owner);
  if (!state?.enabled) return;
  if (state.device !== device) {
    releaseRendererGpuTiming(owner);
    state.device = device;
    state.recorder = GpuFrameTimingRecorder.create(device, MAX_PASSES);
    state.snapshot.mode = state.recorder ? 'gpu-queries' : 'unsupported';
  }
  if (!state.recorder) return;
  if (state.pending || !state.recorder.beginFrame()) {
    state.snapshot.skipped++;
    return;
  }
  encoders.set(encoder, { recorder: state.recorder, state, complete: true });
}

/** Every production render-pass descriptor uses this same optional timing seam. */
export function renderPassTimestampWrites(encoder: GPUCommandEncoder, label: string): GPURenderPassTimestampWrites | undefined {
  const frame = encoders.get(encoder);
  if (!frame) return undefined;
  const writes = frame.recorder.beginPass(label);
  if (!writes && frame.complete) {
    frame.complete = false;
    frame.state.snapshot.errors++;
    console.warn('[Renderer] GPU timing pass budget exceeded; discarding incomplete frame');
  }
  return writes ?? undefined;
}

export function submitRendererGpuTiming(owner: object, device: GPUDevice, encoder: GPUCommandEncoder): void {
  encoders.get(encoder)?.recorder.endFrame(encoder);
  device.queue.submit([encoder.finish()]);
  settleRendererGpuTiming(owner, encoder);
}

/** Call immediately after submit; does not wait for readback on the render path. */
function settleRendererGpuTiming(owner: object, encoder: GPUCommandEncoder): void {
  const frame = encoders.get(encoder);
  const recorder = frame?.recorder;
  encoders.delete(encoder);
  const state = owners.get(owner);
  if (!recorder || !state || recorder !== state.recorder) return;
  state.pending = true;
  const timestamp = performance.now();
  void recorder.readback().then((samples) => {
    if (!samples || state.recorder !== recorder || !frame?.complete) return;
    if (samples.some((sample) => sample.endNs < sample.startNs)) {
      throw new Error('GPU timing contains a non-monotonic timestamp pair');
    }
    if (state.snapshot.frames.length === MAX_SAMPLES) {
      state.snapshot.frames.shift();
      state.snapshot.overwritten++;
    }
    state.snapshot.frames.push({ timestamp, passesMs: passDurationsMs(samples) });
    state.snapshot.sampled++;
  }).catch((error: unknown) => {
    if (state.recorder !== recorder) return; // teardown deliberately cancels the map
    state.snapshot.errors++;
    console.warn('[Renderer] GPU frame timing readback failed:', error);
  }).finally(() => {
    if (state.recorder === recorder) state.pending = false;
  });
}
