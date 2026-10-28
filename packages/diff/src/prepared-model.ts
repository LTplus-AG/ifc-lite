/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { DiffOptions, EntityFingerprint, ModelDiff } from './types.js';
import { fingerprintColumns } from './wasm-columns.js';
import { packStrings } from './wasm-binary.js';
import { diffModelConstructor } from './wasm-runtime.js';
import { compareWasmModels } from './wasm-diff.js';

/** Explicit immutable fingerprint snapshot; opaque ref objects retain their identity.
 * Dispose in finally. Prepare again to observe edits to the source fingerprints.
 * Results refer to the owned snapshots, not mutable source fingerprint objects.
 */
export class PreparedDiffModel<TRef = unknown> {
  private model: InstanceType<ReturnType<typeof diffModelConstructor>> | undefined;
  private rows: EntityFingerprint<TRef>[];

  constructor(entities: Iterable<EntityFingerprint<TRef>>) {
    const Model = diffModelConstructor();
    this.rows = Array.from(entities, entity => {
      const row = { ...entity };
      if (row.components !== undefined) row.components = Object.freeze({ ...row.components });
      if (row.aabb !== undefined) row.aabb = Object.freeze({
        min: Object.freeze([...row.aabb.min]) as [number, number, number],
        max: Object.freeze([...row.aabb.max]) as [number, number, number],
      });
      return Object.freeze(row);
    });
    const c = fingerprintColumns(this.rows);
    this.model = Model.fromPacked(packStrings(c.strings), c.fields, c.flags,
      c.boxes, c.volumes, c.componentOffsets, c.componentPairs);
  }

  compare(head: PreparedDiffModel<TRef>, options: DiffOptions = {}): ModelDiff<TRef> {
    if (!this.model || !head.model) throw new Error('Prepared diff model has been disposed.');
    return compareWasmModels(this.model, head.model, this.rows, head.rows, options);
  }

  /** Idempotent; results already returned remain valid after release. */
  dispose(): void {
    const model = this.model;
    this.model = undefined;
    this.rows = [];
    model?.free();
  }
}

/** Initialize the runtime first; ownership is explicit and never identity-cached. */
export function prepareDiffModel<TRef>(entities: Iterable<EntityFingerprint<TRef>>): PreparedDiffModel<TRef> {
  return new PreparedDiffModel(entities);
}
