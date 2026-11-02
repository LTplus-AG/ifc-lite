/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { GeometryResult } from '@ifc-lite/geometry';
import { createSyntheticDataStore, type IfcDataStore } from '@ifc-lite/parser';
import { normalizeGaussianAttributes, type NormalizedGaussianAttributes } from '@ifc-lite/renderer';
import { createCoordinateInfo } from '../../utils/localParsingUtils.js';
import { modelIndices } from '../../lib/model-placement/model-indices.js';
import type { GaussianDecoded } from './gaussianDecoded.js';
import type { GaussianSplatHandle, GaussianSplatApi } from './gaussianSplatPort.js';

/** Raw source coordinates: no axis flip, unit, survey or measurement claim. */
export const UNCALIBRATED_PLACEMENT: readonly number[] = Object.freeze([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

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
  /** 'source': raw coordinates (identity). 'explicit': supplied by the caller or user. */
  readonly placementOrigin: 'source' | 'explicit';
  readonly calibration: 'uncalibrated';
  /** Only an attribution the caller supplied; never inferred from file contents. */
  readonly attribution?: string;
}

/** Renderer-boundary arrays plus the summary the store keeps. */
export interface PreparedGaussianCapture extends Pick<GaussianDecoded, 'count' | 'shDegree' | 'centerBounds'> {
  attributes: NormalizedGaussianAttributes;
}

/** Normalize once. The caller passes the decode result straight in and keeps no
 * reference, so the raw decoded columns are collectable during the upload. */
export function prepareGaussianCapture(decoded: GaussianDecoded): PreparedGaussianCapture {
  const { count, shDegree, centerBounds } = decoded;
  return { attributes: normalizeGaussianAttributes(decoded), count, shDegree, centerBounds };
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
  /** Explicit caller/user placement; absent means raw source coordinates. */
  placement?: readonly number[];
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
  const placement = request.placement ?? UNCALIBRATED_PLACEMENT;
  if (placement.length !== 16 || !placement.every(Number.isFinite)) throw new Error('A capture placement needs 16 finite matrix values.');
  const slot = modelIndices.reserve(request.modelId, request.models());
  let handle: GaussianSplatHandle;
  try {
    handle = await splats.add({
      attributes: capture.attributes, placement: { matrix: placement }, modelIndex: slot.index, visible: request.visible,
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
      placement, placementOrigin: request.placement ? 'explicit' : 'source', calibration: 'uncalibrated',
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
