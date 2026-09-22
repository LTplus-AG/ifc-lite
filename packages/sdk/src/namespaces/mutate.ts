/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { BimBackend, EntityRef } from '../types.js';

/** bim.mutate — Property editing with undo/redo */
export class MutateNamespace {
  constructor(private backend: BimBackend) {}

  /** Asynchronous batches in flight; the backend marker is held by the first and released by the last. */
  private asyncDepth = 0;
  private asyncLabel: string | undefined;

  /** Set a property on an entity */
  setProperty(ref: EntityRef, psetName: string, propName: string, value: string | number | boolean): void {
    this.backend.mutate.setProperty(ref, psetName, propName, value);
  }

  /** Set a root IFC attribute on an entity */
  setAttribute(ref: EntityRef, attrName: string, value: string): void {
    this.backend.mutate.setAttribute(ref, attrName, value);
  }

  /** Delete a property from an entity */
  deleteProperty(ref: EntityRef, psetName: string, propName: string): void {
    this.backend.mutate.deleteProperty(ref, psetName, propName);
  }

  /**
   * Batch multiple mutations into a single undo step.
   * Sends begin/end markers to the backend so the mutation adapter
   * can group all enclosed mutations into one undoable operation.
   */
  batch(label: string, fn: () => void): void {
    this.backend.mutate.batchBegin(label);
    try {
      fn();
    } finally {
      this.backend.mutate.batchEnd(label);
    }
  }

  /**
   * `batch` for asynchronous work (a flow run, a fetch-then-write): the
   * batch stays open across awaits and closes when the promise settles.
   * Other writers on the same backend meanwhile land inside the batch.
   *
   * A `batchAsync` started while another is in flight — nested inside its
   * callback or independent of it — JOINS that batch: no second marker is
   * opened, and the one marker closes when the last of them settles. The
   * two cases cannot be told apart without async context, and both need the
   * same answer: their mutations interleave on the same undo stacks, so one
   * undo step is the only grouping that leaves the model consistent. A
   * second marker would close out of order (label mismatch) or, queued
   * behind its parent, never open.
   */
  async batchAsync<T>(label: string, fn: () => Promise<T>): Promise<T> {
    if (this.asyncDepth === 0) {
      this.backend.mutate.batchBegin(label);
      this.asyncLabel = label;
    }
    this.asyncDepth += 1;
    try {
      return await fn();
    } finally {
      this.asyncDepth -= 1;
      if (this.asyncDepth === 0) {
        const open = this.asyncLabel!;
        this.asyncLabel = undefined;
        this.backend.mutate.batchEnd(open);
      }
    }
  }

  /** Undo last mutation for a model */
  undo(modelId: string): boolean {
    return this.backend.mutate.undo(modelId);
  }

  /** Redo last undone mutation for a model */
  redo(modelId: string): boolean {
    return this.backend.mutate.redo(modelId);
  }
}
