/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Bounded, post-pass color-frame readback used by strict hardware witnesses. */

/** A central, actual-color crop copied from the presented production color target. */
export interface RendererColorFrame {
  width: number;
  height: number;
  rgba: Uint8ClampedArray;
  duplicate?: Uint8ClampedArray;
  metadata?: Record<string, unknown>;
}

interface ColorFrameCopy {
  buffer: GPUBuffer;
  width: number;
  height: number;
  bytesPerRow: number;
  bgra: boolean;
  duplicate?: ColorFrameCopy;
  metadata?: Record<string, unknown>;
}

interface PendingRendererColorFrame {
  diagnostic: boolean;
  encoded: boolean;
  skippedFrames: number;
  promise: Promise<RendererColorFrame | null>;
  resolve: (frame: RendererColorFrame | null) => void;
}

export interface RendererColorFrameCapture {
  pending: PendingRendererColorFrame;
  sourceTexture: GPUTexture;
  width: number;
  height: number;
  format: GPUTextureFormat;
  metadata?: Record<string, unknown>;
}

/** Keep debug/readback work bounded even for a full-screen 8K production viewport. */
const MAX_COLOR_FRAME_DIMENSION = 512;
const PIXEL_BYTES = 4;
const COPY_ROW_ALIGNMENT = 256;
const MAX_COLOR_FRAME_CAPTURE_SKIPS = 3;
let diagnosticSequence = 0;
const pendingCaptures = new WeakMap<object, PendingRendererColorFrame>();

function captureDimensions(width: number, height: number): { x: number; y: number; width: number; height: number } {
  const capturedWidth = Math.min(width, MAX_COLOR_FRAME_DIMENSION);
  const capturedHeight = Math.min(height, MAX_COLOR_FRAME_DIMENSION);
  return {
    x: Math.floor((width - capturedWidth) / 2),
    y: Math.floor((height - capturedHeight) / 2),
    width: capturedWidth,
    height: capturedHeight,
  };
}

/**
 * Appends a color copy after every production pass, so the bytes describe the
 * exact submitted frame instead of compositor or scene-residency state.
 */
export function encodeRendererColorFrameReadback(
  device: GPUDevice,
  encoder: GPUCommandEncoder,
  texture: GPUTexture,
  frameWidth: number,
  frameHeight: number,
  format: GPUTextureFormat,
): ColorFrameCopy {
  const region = captureDimensions(frameWidth, frameHeight);
  const bytesPerRow = Math.ceil((region.width * PIXEL_BYTES) / COPY_ROW_ALIGNMENT) * COPY_ROW_ALIGNMENT;
  const buffer = device.createBuffer({
    size: bytesPerRow * region.height,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });
  try {
    encoder.copyTextureToBuffer(
      { texture, origin: { x: region.x, y: region.y, z: 0 } },
      { buffer, bytesPerRow, rowsPerImage: region.height },
      { width: region.width, height: region.height, depthOrArrayLayers: 1 },
    );
  } catch (error) {
    buffer.destroy();
    throw error;
  }
  return { buffer, width: region.width, height: region.height, bytesPerRow, bgra: format.startsWith('bgra') };
}

/** Maps and normalizes an encoded color copy. Call only after its command buffer submitted. */
export async function resolveRendererColorFrameReadback(copy: ColorFrameCopy): Promise<RendererColorFrame | null> {
  const [frame, duplicate] = await Promise.all([
    resolveSingleColorFrame(copy),
    copy.duplicate ? resolveSingleColorFrame(copy.duplicate) : Promise.resolve(null),
  ]);
  if (!frame || (copy.duplicate && !duplicate)) return null;
  return { ...frame, ...(duplicate ? { duplicate: duplicate.rgba } : {}), ...(copy.metadata ? { metadata: copy.metadata } : {}) };
}

async function resolveSingleColorFrame(copy: ColorFrameCopy): Promise<RendererColorFrame | null> {
  let mapped = false;
  try {
    // GPUMapMode.READ = 1. The package's browser typings intentionally do not
    // require the runtime global to exist in Node-only renderer tests.
    await copy.buffer.mapAsync(1);
    mapped = true;
    const source = new Uint8Array(copy.buffer.getMappedRange());
    const rgba = new Uint8ClampedArray(copy.width * copy.height * PIXEL_BYTES);
    for (let row = 0; row < copy.height; row++) for (let column = 0; column < copy.width; column++) {
      const from = row * copy.bytesPerRow + column * PIXEL_BYTES;
      const to = (row * copy.width + column) * PIXEL_BYTES;
      rgba[to] = copy.bgra ? source[from + 2]! : source[from]!;
      rgba[to + 1] = source[from + 1]!;
      rgba[to + 2] = copy.bgra ? source[from]! : source[from + 2]!;
      rgba[to + 3] = source[from + 3]!;
    }
    return { width: copy.width, height: copy.height, rgba };
  } catch (error) {
    console.warn('[Renderer] Color-frame readback failed:', error);
    return null;
  } finally {
    if (mapped) copy.buffer.unmap();
    copy.buffer.destroy();
  }
}

/** Queue one bounded readback for a renderer host, coalescing concurrent callers. */
export function requestRendererColorFrame(
  host: object,
  available: boolean,
  requestRender: () => void,
  diagnostic = false,
): Promise<RendererColorFrame | null> {
  if (!available) return Promise.resolve(null);
  const existing = pendingCaptures.get(host);
  if (existing) return existing.promise;
  let resolve!: (frame: RendererColorFrame | null) => void;
  const promise = new Promise<RendererColorFrame | null>((finish) => { resolve = finish; });
  pendingCaptures.set(host, { diagnostic, encoded: false, skippedFrames: 0, promise, resolve });
  try {
    requestRender();
  } catch (error) {
    // A synchronous host failure must not strand the coalescing entry: a
    // later caller needs to be able to request a fresh frame.
    pendingCaptures.delete(host);
    resolve(null);
    return Promise.reject(error);
  }
  return promise;
}

/** Cancels on terminal device loss, render error, or renderer teardown. */
export function cancelRendererColorFrame(host: object): void {
  const pending = pendingCaptures.get(host);
  if (!pending) return;
  pendingCaptures.delete(host);
  pending.resolve(null);
}

/** Re-request up to three transient context/resize skips, never an endless frame loop. */
export function retryRendererColorFrame(host: object, requestRender: () => void): void {
  const pending = pendingCaptures.get(host);
  if (!pending || pending.encoded) return;
  if (pending.skippedFrames >= MAX_COLOR_FRAME_CAPTURE_SKIPS) {
    cancelRendererColorFrame(host);
    return;
  }
  pending.skippedFrames++;
  requestRender();
}

/** Binds one pending request to the copy-capable production canvas texture. */
export function beginRendererColorFrameCapture(
  host: object,
  sourceTexture: GPUTexture,
  width: number,
  height: number,
  format: GPUTextureFormat,
): RendererColorFrameCapture | null {
  const pending = pendingCaptures.get(host);
  if (!pending || pending.encoded) return null;
  return {
    pending,
    sourceTexture,
    width,
    height,
    format,
  };
}

/** Encodes a color copy before the frame command buffer is submitted. */
export function encodeRendererColorFrameCapture(
  device: GPUDevice,
  encoder: GPUCommandEncoder,
  capture: RendererColorFrameCapture,
): ColorFrameCopy {
  const copy = encodeRendererColorFrameReadback(
    device, encoder, capture.sourceTexture, capture.width, capture.height, capture.format,
  );
  if (capture.pending.diagnostic) {
    try {
      copy.duplicate = encodeRendererColorFrameReadback(device, encoder, capture.sourceTexture, capture.width, capture.height, capture.format);
      copy.metadata = { ...capture.metadata, crop: captureDimensions(capture.width, capture.height), format: capture.format,
        textureSize: [capture.width, capture.height], encodedAt: performance.now() };
    } catch (error) { copy.buffer.destroy(); throw error; }
  }
  capture.pending.encoded = true;
  return copy;
}

/** Settles the requester once its submitted canvas copy maps. */
export function settleRendererColorFrameCapture(
  host: object,
  capture: RendererColorFrameCapture,
  copy: ColorFrameCopy,
): void {
  void resolveRendererColorFrameReadback(copy).then((frame) => {
    if (pendingCaptures.get(host) !== capture.pending) return;
    pendingCaptures.delete(host);
    capture.pending.resolve(frame);
  });
}

/** Frees a copy whose command buffer could not be submitted. */
export function discardRendererColorFrameReadback(copy: ColorFrameCopy | null): void {
  copy?.duplicate?.buffer.destroy();
  copy?.buffer.destroy();
}

// Observe only diagnostic command recording. Native receivers remain bound and
// every call is forwarded once; no pass, submit, clear or render is introduced.
export function traceRendererColorFrameEncoder(capture: RendererColorFrameCapture | null, encoder: GPUCommandEncoder): GPUCommandEncoder {
  if (!capture?.pending.diagnostic) return encoder;
  const passes: Record<string, unknown>[] = [];
  capture.metadata = { diagnosticFrameId: ++diagnosticSequence, recordingAt: performance.now(), passes };
  return new Proxy(encoder, { set: forwardNativeAssignment, get(target, property) {
    if (property === 'beginRenderPass') return (descriptor: GPURenderPassDescriptor) => {
      const pass = target.beginRenderPass(descriptor);
      const trace: Record<string, unknown> = { label: descriptor.label,
        color: Array.from(descriptor.colorAttachments, a => a ? { view: evidenceObjectId(a.view), resolve: a.resolveTarget ? evidenceObjectId(a.resolveTarget) : null, loadOp: a.loadOp, storeOp: a.storeOp, clearValue: a.clearValue } : null),
        depth: descriptor.depthStencilAttachment ? { ...descriptor.depthStencilAttachment, view: evidenceObjectId(descriptor.depthStencilAttachment.view) } : null,
        rasterCalls: [], defaultRaster: 'full attachment viewport/scissor until overridden' };
      if (passes.length < 64) passes.push(trace);
      else capture.metadata!.passesTruncated = true;
      return new Proxy(pass, { set: forwardNativeAssignment, get(native, key) {
        const value = Reflect.get(native, key, native);
        if (typeof value !== 'function') return value;
        if (key !== 'setViewport' && key !== 'setScissorRect' && key !== 'setBlendConstant' && key !== 'setStencilReference') return value.bind(native);
        return (...args: unknown[]) => {
          const calls = trace.rasterCalls as unknown[];
          if (calls.length < 256) calls.push({ method: key, args: structuredClone(args) });
          else trace.rasterCallsTruncated = true;
          return Reflect.apply(value, native, args);
        };
      } });
    };
    const value = Reflect.get(target, property, target);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
}
// WebIDL accessors brand-check `this` too. Reflect.set's default receiver would
// be the Proxy, even though getters and methods already use the native object.
// Forward every assignment, not just GPUObjectBase.label (#8566 / failed 40ad).
function forwardNativeAssignment(native: object, key: string | symbol, value: unknown): boolean {
  return Reflect.set(native, key, value, native);
}
const evidenceObjects = new WeakMap<object, number>();
let evidenceObjectSequence = 0;
function evidenceObjectId(object: object): number {
  let id = evidenceObjects.get(object);
  if (id === undefined) { id = ++evidenceObjectSequence; evidenceObjects.set(object, id); }
  return id;
}
