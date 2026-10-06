/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * One WASM streaming operation at a time per GeometryProcessor module: the
 * streaming entry points share engine state, so a second stream must not start
 * while the first is still running.
 */
let activeWasmStreamingOperation: string | null = null;

export function acquireWasmStreamingOperation(operation: string): () => void {
  if (activeWasmStreamingOperation) {
    throw new Error(
      `GeometryProcessor ${operation} cannot start while ${activeWasmStreamingOperation} is still running. ` +
      'Wait for the active stream to finish, or cancel it before starting another geometry operation.',
    );
  }
  activeWasmStreamingOperation = operation;
  return () => {
    if (activeWasmStreamingOperation === operation) {
      activeWasmStreamingOperation = null;
    }
  };
}
