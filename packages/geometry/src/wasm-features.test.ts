/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, expect } from 'vitest';
import { supportsWasmThreads, isThreadedWasmUsable } from './wasm-features.js';

describe('wasm-features — threaded bundle selection', () => {
  it('detects WASM threads support via the shared-memory probe', () => {
    // The threads proposal (shared memory) shipped in every current engine,
    // including the Node test runner's V8.
    expect(supportsWasmThreads()).toBe(true);
  });

  it('gates the threaded bundle on cross-origin isolation', () => {
    // Node supports threads but is not cross-origin isolated
    // (globalThis.crossOriginIsolated is undefined), so the threaded bundle is
    // NOT usable here and callers must fall back to the single-thread bundle.
    expect(isThreadedWasmUsable()).toBe(false);
  });
});
