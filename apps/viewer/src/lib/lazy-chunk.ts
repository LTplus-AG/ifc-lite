/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `React.lazy` for the viewer (#10684). A rejected `lazy()` import re-throws
 * from render, and most lazy roots have no error boundary, so one chunk that
 * would not load unmounted the whole app. Here a chunk-load failure renders
 * nothing, unless a `ChunkErrorBoundary` is above it, which then shows its
 * labelled card as before. Any other rejection still rejects.
 *
 * Vite usually sees the failure first. The same recovery handles loaders
 * whose rejection arrives without a preload event.
 */

import { createContext, lazy, useContext, useEffect, type ComponentType, type LazyExoticComponent } from 'react';
import { isChunkLoadError } from './chunk-load-error.js';
import { afterChunkReloadWindow, recoverChunkLoad } from './chunk-version-skew.js';
import { posthog } from './analytics.js';

/** True under a `ChunkErrorBoundary`, which has a fallback for a failed chunk. */
export const ChunkBoundaryContext = createContext(false);

const reportedChunks = new WeakSet<object>();

/** Share reporting when the same rejected import reaches multiple consumers. */
export function captureUnavailableChunk(error: unknown, label?: string): void {
  if (typeof error === 'object' && error !== null) {
    if (reportedChunks.has(error)) return;
    reportedChunks.add(error);
  }
  afterChunkReloadWindow(() => {
    posthog.captureException(error, label
      ? { context: 'lazy_chunk_boundary', lazy_chunk: label }
      : { context: 'lazy_chunk_unavailable' });
  });
}

function unavailable(err: unknown): () => null {
  let reported = false;
  return function ChunkUnavailable() {
    const hasBoundary = useContext(ChunkBoundaryContext);
    useEffect(() => {
      if (reported || hasBoundary) return;
      reported = true;
      captureUnavailableChunk(err);
    }, [hasBoundary]);
    if (hasBoundary) throw err;
    return null;
  };
}

// Same constraint as React.lazy.
export function lazyChunk<T extends ComponentType<any>>(
  load: () => Promise<{ default: T }>,
): LazyExoticComponent<T> {
  return lazy(() =>
    load().catch((err: unknown) => {
      if (!isChunkLoadError(err)) throw err;
      recoverChunkLoad();
      console.warn('[lazy-chunk] chunk unavailable; rendering nothing until reload', err);
      return { default: unavailable(err) as unknown as T };
    }),
  );
}
