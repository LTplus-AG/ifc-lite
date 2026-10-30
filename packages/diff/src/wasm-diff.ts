/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { DiffOptions, EntityFingerprint, ModelDiff } from './types.js';
import { packStrings, unpackDocument } from './wasm-binary.js';
import { fingerprintColumns } from './wasm-columns.js';
import { diffModelConstructor } from './wasm-runtime.js';
import { restoreDiffReferences, type IndexedDiff } from './wasm-result.js';

/**
 * One-shot synchronous Rust comparison after explicit runtime initialization.
 * Every call marshals both models into WASM, compares them, and frees both
 * native models. For repeated comparisons, prepare each model once with
 * {@link prepareDiffModel} and explicitly dispose the resulting handles.
 */
export function compareWithWasm<TRef = unknown>(base: Iterable<EntityFingerprint<TRef>>, head: Iterable<EntityFingerprint<TRef>>, options: DiffOptions = {}): ModelDiff<TRef> {
  const Model = diffModelConstructor();
  const baseRows = Array.from(base);
  const headRows = Array.from(head);
  const create = (entities: readonly EntityFingerprint<TRef>[]) => {
    const c = fingerprintColumns(entities);
    return { model: Model.fromPacked(packStrings(c.strings), c.fields, c.flags, c.boxes, c.volumes, c.componentOffsets, c.componentPairs), keys: c.keys };
  };
  const baseModel = create(baseRows);
  try {
    const headModel = create(headRows);
    try {
      return compareWasmModels(baseModel.model, headModel.model, baseRows, headRows, options, [baseModel.keys, headModel.keys]);
    } finally { headModel.model.free(); }
  } finally { baseModel.model.free(); }
}

/** Shared comparison path for transient public calls and explicit internal owners. */
export function compareWasmModels<TRef>(
  baseModel: InstanceType<ReturnType<typeof diffModelConstructor>>,
  headModel: InstanceType<ReturnType<typeof diffModelConstructor>>,
  baseRows: readonly EntityFingerprint<TRef>[], headRows: readonly EntityFingerprint<TRef>[],
  options: DiffOptions,
  keys: readonly [readonly string[], readonly string[]],
  placementRows?: () => readonly [readonly EntityFingerprint<TRef>[], readonly EntityFingerprint<TRef>[]],
): ModelDiff<TRef> {
  const stripPlacementGeometry = options.stripPlacementGeometry === true;
  const raw = unpackDocument(baseModel.comparePacked(headModel, {
    scope: options.scope,
    stripPlacementGeometry,
    moveTolerance: options.moveTolerance,
    reshapeTolerance: options.reshapeTolerance,
    maxMoveDistance: options.maxMoveDistance,
    matchUnpairedByContent: options.matchUnpairedByContent,
    detectSplitMerge: options.detectSplitMerge,
    detectSuccessors: options.detectSuccessors,
    splitVolumeTolerance: options.splitVolumeTolerance,
    splitPaddingMin: options.splitPaddingMin,
    splitPaddingRatio: options.splitPaddingRatio,
    maxSplitPieces: options.maxSplitPieces,
    successorOverlap: options.successorOverlap,
    successorDistance: options.successorDistance,
    classFamilies: options.classFamilies,
    ...(options.excludeTypes === undefined ? {} : { excludeTypes: [...options.excludeTypes] }),
    ...(options.keyAliases === undefined ? {} : { keyAliases: [...options.keyAliases] }),
  })) as IndexedDiff;
  // Classification is Rust-owned; handle owners supply their stable stripped
  // view, while one-shot calls project only for this call.
  const [baseView, headView] = stripPlacementGeometry
    ? placementRows?.() ?? [stripPlacementRows(baseRows), stripPlacementRows(headRows)]
    : [baseRows, headRows];
  return restoreDiffReferences(raw, baseView, headView, keys);
}

/** Project returned records only; native models always retain original hashes. */
export function stripPlacementRows<TRef>(rows: readonly EntityFingerprint<TRef>[], frozen = false): readonly EntityFingerprint<TRef>[] {
  const view = rows.map(row => {
    if (typeof row.geometryHash !== 'string' || !row.geometryHash.startsWith('p:')) return row;
    const projected = { ...row, geometryHash: undefined };
    return frozen ? Object.freeze(projected) : projected;
  });
  return frozen ? Object.freeze(view) : view;
}
