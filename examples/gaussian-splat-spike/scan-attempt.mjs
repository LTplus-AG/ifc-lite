/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Research witness state, not a production viewer loader. read owns its source
// lifetime; only the latest live attempt may commit GPU work or publish evidence.
export function createScanLoader({ state, read, commit, onStart, onSuccess, onError }) {
  let generation = state.scanAttempt ?? 0;
  let disposed = false;
  return {
    async loadScan(file) {
      if (!file) return; // A canceled picker did not start an attempt.
      if (disposed) throw new Error('Scan loader is disposed');
      const attempt = ++generation;
      state.scanAttempt = attempt;
      state.scan = null;
      state.error = null;
      state.scanPending = true;
      try {
        onStart?.();
        const result = await read(file);
        if (attempt !== generation || disposed) return;
        commit(result);
        state.scan = result.summary;
        onSuccess?.();
      } catch (error) {
        if (attempt === generation && !disposed) {
          state.scan = null;
          state.error = error instanceof Error ? error.message : String(error);
          onError?.(error);
        }
        throw error;
      } finally {
        if (attempt === generation) state.scanPending = false;
      }
    },
    dispose() {
      disposed = true;
      state.scanAttempt = ++generation;
      state.scanPending = false;
      state.scan = null;
      state.error = null;
    },
  };
}
