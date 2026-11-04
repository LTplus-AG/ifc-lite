/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { RenderFrameInfo } from '@ifc-lite/geometry/world-frame';
import type { CaptureUpAxis } from './pointCloudFrame.js';
import { gaussianCaptureFrame, gaussianUploadPlacement } from './gaussianCaptureFrame.js';
import type { GeometryResult } from '@ifc-lite/geometry';
import { createSyntheticDataStore, type IfcDataStore } from '@ifc-lite/parser';
import {
  normalizeGaussianAttributes, type GaussianSplatApi, type GaussianSplatHandle, type NormalizedGaussianAttributes,
} from '@ifc-lite/renderer';
import { createCoordinateInfo } from '../../utils/localParsingUtils.js';
import { modelIndices } from '../../lib/model-placement/model-indices.js';
import type { GaussianDecoded } from './gaussianDecoded.js';

/** Store record of one capture. `handle` is the renderer-issued object itself. */
export interface GaussianSplatModel {
  readonly handle: GaussianSplatHandle;
  readonly format: 'gaussian-ply' | 'splat';
  readonly count: number;
  readonly shDegree: 0 | 1 | 2 | 3;
  /** Decoded centre bounds in source coordinates; centres only, for framing. */
  readonly sourceCenterBounds: GaussianDecoded['centerBounds'];
  /** Column-major source-local -> viewer world matrix handed to the renderer. */
  readonly placement: readonly number[];
  /** Source-coordinate centre subtracted from the CPU position arrays only. */
  readonly decodeOrigin?: readonly [number, number, number];
  /** Unbaked placement and axes for reload/portable restore (#8752). */
  readonly sourcePlacement?: readonly number[];
  readonly upAxis?: CaptureUpAxis;
  readonly frameOffset?: { x: number; y: number; z: number };
  /** 'source': default frame policy. 'explicit': a supplied placement matrix. */
  readonly placementOrigin: 'source' | 'explicit';
  readonly calibration: 'uncalibrated';
  /** Only an attribution the caller supplied; never inferred from file contents. */
  readonly attribution?: string;
}

/** Renderer-boundary arrays plus the summary the store keeps. */
export interface PreparedGaussianCapture extends Pick<GaussianDecoded, 'count' | 'shDegree' | 'centerBounds'> {
  attributes: NormalizedGaussianAttributes;
  decodeOrigin: readonly [number, number, number];
}

/** Normalize once. The caller passes the decode result straight in and keeps no
 * reference, so the raw decoded columns are collectable during the upload. */
export function prepareGaussianCapture(decoded: GaussianDecoded): PreparedGaussianCapture {
  const { count, shDegree, centerBounds } = decoded;
  const attributes = normalizeGaussianAttributes(decoded);
  const decodeOrigin = decoded.decodeOrigin;
  return { attributes, decodeOrigin, count, shDegree, centerBounds };
}

export interface GaussianUploadRequest {
  modelId: string;
  format: GaussianSplatModel['format'];
  capture: PreparedGaussianCapture;
  splats: GaussianSplatApi;
  /** Renderer generation captured before decoding; a different one refuses. */
  generation: number;
  currentGeneration(): number | undefined;
  models(): ReadonlyMap<string, unknown>;
  visible: boolean;
  signal: AbortSignal;
  isCurrent(): boolean;
  /** Caller placement before the shared render-frame offset is subtracted. */
  placement?: readonly number[];
  upAxis?: CaptureUpAxis;
  frame?: RenderFrameInfo | null;
  attribution?: string;
}

/** A resident asset not yet owned by a published model. Exactly one of
 * `commit` (the store now owns it) or `rollback` (remove it) must run. */
export interface GaussianUpload {
  record: GaussianSplatModel;
  commit(): void;
  rollback(): void;
}

/**
 * Reserve the shared model slot, then upload. The slot is held until
 * the asset is published or removed, so no other model can take its index
 * while this upload is outstanding. A stale, aborted or rejected upload leaves
 * no renderer asset and no reservation behind. Resolves null when superseded.
 */
export async function uploadGaussianCapture(request: GaussianUploadRequest): Promise<GaussianUpload | null> {
  const { capture, splats, signal } = request;
  if (!request.isCurrent() || signal.aborted) return null;
  if (request.currentGeneration() !== request.generation) {
    throw new Error('The viewer renderer was reinitialised while the capture decoded.');
  }
  const framed = gaussianCaptureFrame(request.placement, request.upAxis, request.frame);
  const { placement } = framed;
  const slot = modelIndices.reserve(request.modelId, request.models());
  let handle: GaussianSplatHandle;
  try {
    // The adapter's acknowledgement literal is a renderer call detail, not the
    // admission decision: that is the build's (`gaussianAdmissionEnabled`, #8568).
    handle = await splats.add({
      attributes: capture.attributes, placement: { matrix: gaussianUploadPlacement(placement, capture.decodeOrigin) }, modelIndex: slot.index, visible: request.visible,
    }, { qualification: 'internal-unqualified', signal });
  } catch (error) {
    slot.release(); // A rejected add retains nothing, including this index.
    throw error;
  }
  const rollback = () => { splats.remove(handle); slot.release(); };
  if (!request.isCurrent() || signal.aborted) { rollback(); return null; }
  const { count, shDegree, centerBounds } = capture;
  return {
    record: {
      handle, format: request.format, count, shDegree, sourceCenterBounds: centerBounds,
      ...framed, decodeOrigin: capture.decodeOrigin, placementOrigin: request.placement ? 'explicit' : 'source', calibration: 'uncalibrated',
      ...(request.attribution ? { attribution: request.attribution } : {}),
    },
    commit: () => slot.release(),
    rollback,
  };
}

/** Model-registry shell: no entity rows, so no IFC EXPRESS id is invented. */
export function gaussianModelShell(fileSize: number): { dataStore: IfcDataStore; geometryResult: GeometryResult } {
  const origin = { x: 0, y: 0, z: 0 };
  return {
    dataStore: createSyntheticDataStore({ schemaVersion: 'IFC4', fileSize, entityCount: 0, entities: [] }),
    geometryResult: {
      meshes: [], totalVertices: 0, totalTriangles: 0,
      coordinateInfo: createCoordinateInfo({ min: origin, max: { ...origin } }),
    },
  };
}
