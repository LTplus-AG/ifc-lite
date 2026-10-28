/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { DiffOptions, EntityFingerprint, ModelDiff } from './types.js';
import { packStrings, unpackStrings } from './wasm-binary.js';
import { fingerprintColumns } from './wasm-columns.js';
import { diffModelConstructor } from './wasm-runtime.js';
import { restoreDiffReferences, type IndexedDiff } from './wasm-result.js';

/** Synchronous Rust comparison after explicit runtime initialization. */
export function compareWithWasm<TRef = unknown>(base: Iterable<EntityFingerprint<TRef>>, head: Iterable<EntityFingerprint<TRef>>, options: DiffOptions = {}): ModelDiff<TRef> {
  const Model = diffModelConstructor();
  const baseRows = Array.from(base);
  const headRows = Array.from(head);
  const create = (entities: readonly EntityFingerprint<TRef>[]) => {
    const c = fingerprintColumns(entities);
    return Model.fromPacked(packStrings(c.strings), c.fields, c.flags, c.boxes, c.volumes, c.componentOffsets, c.componentPairs);
  };
  const baseModel = create(baseRows);
  try {
    const headModel = create(headRows);
    try {
      return compareWasmModels(baseModel, headModel, baseRows, headRows, options);
    } finally { headModel.free(); }
  } finally { baseModel.free(); }
}

/** Shared comparison path for transient public calls and explicit internal owners. */
export function compareWasmModels<TRef>(
  baseModel: InstanceType<ReturnType<typeof diffModelConstructor>>,
  headModel: InstanceType<ReturnType<typeof diffModelConstructor>>,
  baseRows: readonly EntityFingerprint<TRef>[], headRows: readonly EntityFingerprint<TRef>[],
  options: DiffOptions,
): ModelDiff<TRef> {
  const raw = unpackStrings(baseModel.comparePacked(headModel, {
    scope: options.scope,
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
  return restoreDiffReferences(raw, baseRows, headRows);
}
