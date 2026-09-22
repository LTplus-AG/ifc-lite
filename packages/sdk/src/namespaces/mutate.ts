/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { BimBackend, EntityRef } from '../types.js';

/** bim.mutate — Property editing with undo/redo */
export class MutateNamespace {
  constructor(private backend: BimBackend) {}

  /** The asynchronous batch in flight, if any; the next one queues behind it. */
  private asyncBatch: Promise<unknown> = Promise.resolve();

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
   * Batches are serialised: a second `batchAsync` waits for the first to
   * settle before it opens. The backend's begin/end markers are a stack, so
   * two interleaved batches whose first opened settled first would close
   * the second's marker and fail with a label mismatch.
   */
  batchAsync<T>(label: string, fn: () => Promise<T>): Promise<T> {
    const run = this.asyncBatch.then(async () => {
      this.backend.mutate.batchBegin(label);
      try {
        return await fn();
      } finally {
        this.backend.mutate.batchEnd(label);
      }
    });
    // The previous batch's failure is its own caller's; the queue never rejects.
    this.asyncBatch = run.catch(() => undefined);
    return run;
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
