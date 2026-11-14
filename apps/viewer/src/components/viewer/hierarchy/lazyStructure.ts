/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { TreeNode } from './types';

/**
 * The complete structural tree (every branch expanded), built at most once and
 * only when something needs rows the user cannot see yet: search, reveal, or
 * idle time after a load settles (NEW-4). Until then the panel builds just the
 * expanded rows, which the projection contract (#5886,
 * `treeDataBuilder.test.ts`) makes identical to projecting this structure.
 */
export interface LazyStructure {
  /** Build on first call; every later call returns the same rows. */
  get(): TreeNode[];
  readonly built: boolean;
}

export function lazyStructure(build: () => TreeNode[]): LazyStructure {
  let rows: TreeNode[] | null = null;
  return {
    get() {
      rows ??= build();
      return rows;
    },
    get built() {
      return rows !== null;
    },
  };
}

/** Run `task` when the main thread is idle; the returned function cancels it. */
export function scheduleIdle(task: () => void, timeoutMs = 5000): () => void {
  const idle = globalThis as typeof globalThis & {
    requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number;
    cancelIdleCallback?: (handle: number) => void;
  };
  if (typeof idle.requestIdleCallback === 'function' && typeof idle.cancelIdleCallback === 'function') {
    const handle = idle.requestIdleCallback(task, { timeout: timeoutMs });
    return () => idle.cancelIdleCallback!(handle);
  }
  const handle = setTimeout(task, 0);
  return () => clearTimeout(handle);
}
