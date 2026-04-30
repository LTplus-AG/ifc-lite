/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * postMessage protocol shared between the main thread and decode-worker.
 *
 * Direction is encoded by message kind. Typed arrays are always carried
 * in transferable buffers so we don't double-allocate.
 */

import type { DecodedPointChunk, PointCloudBBox } from '../types.js';
import type { PointSourceInfo } from './types.js';

export type WorkerSourceFormat = 'las' | 'laz';

/** main → worker */
export type WorkerRequest =
  | {
      kind: 'open';
      requestId: number;
      format: WorkerSourceFormat;
      blob: Blob;
      label?: string;
      stride: number;
    }
  | {
      kind: 'next';
      requestId: number;
      sourceId: number;
      maxPoints: number;
    }
  | {
      kind: 'close';
      sourceId: number;
    }
  | {
      kind: 'abort';
      sourceId: number;
    };

/** worker → main */
export type WorkerResponse =
  | {
      kind: 'opened';
      requestId: number;
      sourceId: number;
      info: PointSourceInfo;
    }
  | {
      kind: 'chunk';
      requestId: number;
      sourceId: number;
      chunk: SerializedChunk | null;
    }
  | {
      kind: 'error';
      requestId: number;
      message: string;
    };

/** Wire-friendly chunk: typed-array views replaced by their underlying buffers. */
export interface SerializedChunk {
  positions: ArrayBuffer;
  colors?: ArrayBuffer;
  classifications?: ArrayBuffer;
  intensities?: ArrayBuffer;
  pointCount: number;
  bbox: PointCloudBBox;
}

/** Convert a chunk into a transferable wire payload + transfer list. */
export function chunkToWire(chunk: DecodedPointChunk): {
  payload: SerializedChunk;
  transfer: ArrayBuffer[];
} {
  // We construct every typed array in this package via `new Float32Array(N)` /
  // friends, so `.buffer` is always a plain `ArrayBuffer`. The `as ArrayBuffer`
  // cast is safe and required because TS widens the type to `ArrayBufferLike`
  // (which formally includes `SharedArrayBuffer`).
  const positions = chunk.positions.buffer as ArrayBuffer;
  const transfer: ArrayBuffer[] = [positions];
  const payload: SerializedChunk = {
    positions,
    pointCount: chunk.pointCount,
    bbox: chunk.bbox,
  };
  if (chunk.colors) {
    const buf = chunk.colors.buffer as ArrayBuffer;
    payload.colors = buf;
    transfer.push(buf);
  }
  if (chunk.classifications) {
    const buf = chunk.classifications.buffer as ArrayBuffer;
    payload.classifications = buf;
    transfer.push(buf);
  }
  if (chunk.intensities) {
    const buf = chunk.intensities.buffer as ArrayBuffer;
    payload.intensities = buf;
    transfer.push(buf);
  }
  return { payload, transfer };
}

/** Inverse of `chunkToWire`. */
export function chunkFromWire(payload: SerializedChunk): DecodedPointChunk {
  return {
    positions: new Float32Array(payload.positions),
    colors: payload.colors ? new Float32Array(payload.colors) : undefined,
    classifications: payload.classifications ? new Uint8Array(payload.classifications) : undefined,
    intensities: payload.intensities ? new Uint16Array(payload.intensities) : undefined,
    pointCount: payload.pointCount,
    bbox: payload.bbox,
  };
}
