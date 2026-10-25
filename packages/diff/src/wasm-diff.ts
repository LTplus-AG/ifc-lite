/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { DiffOptions, EntityFingerprint, ModelDiff } from './types.js';
import { fingerprintColumns } from './wasm-columns.js';
import { diffModelConstructor } from './wasm-runtime.js';
import { restoreDiffReferences, type IndexedDiff } from './wasm-result.js';

/** Synchronous Rust comparison after explicit runtime initialization. */
export function compareWithWasm<TRef>(base: readonly EntityFingerprint<TRef>[], head: readonly EntityFingerprint<TRef>[], options: DiffOptions = {}): ModelDiff<TRef> {
  const Model = diffModelConstructor();
  const create = (entities: readonly EntityFingerprint<TRef>[]) => {
    const c = fingerprintColumns(entities);
    return new Model(c.strings, c.fields, c.flags, c.boxes, c.volumes, c.componentOffsets, c.componentPairs);
  };
  const baseModel = create(base);
  try {
    const headModel = create(head);
    try {
      const raw: IndexedDiff = baseModel.compare(headModel, {
        ...options,
        ...(options.excludeTypes === undefined ? {} : { excludeTypes: [...options.excludeTypes] }),
        ...(options.keyAliases === undefined ? {} : { keyAliases: [...options.keyAliases] }),
      });
      return restoreDiffReferences(raw, base, head);
    } finally { headModel.free(); }
  } finally { baseModel.free(); }
}
