/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `React.lazy` for the viewer, with a chunk that will not load turned into an
 * empty slot instead of a dead app (#10684).
 *
 * A rejected `lazy()` import is re-thrown from the render phase. Under a
 * `ChunkErrorBoundary` that costs one panel; with no boundary above it, React
 * unmounts the whole root and the user gets a blank page. Most `lazy()` roots
 * have no boundary (export dialogs in the ribbon, overlays, notices), and the
 * one automatic reload in ./chunk-version-skew.ts cannot help once it is spent
 * or when the host keeps failing the asset.
 *
 * So a chunk-load failure resolves to a component that renders nothing, and
 * raises the app-wide "reload to continue" notice (./stale-deployment.ts). Any
 * other rejection (a module that threw while evaluating) still rejects, so a
 * real bug keeps reaching its boundary and error tracking.
 */

import { lazy, type ComponentType, type LazyExoticComponent } from 'react';
import { surfaceStaleDeployment } from './stale-deployment.js';

/** What a lazy slot renders when its chunk is gone. The notice says why. */
function ChunkUnavailable(): null {
  return null;
}

// `ComponentType<any>` is React.lazy's own constraint; a narrower one would
// reject components whose props are not assignable to it.
export function lazyChunk<T extends ComponentType<any>>(
  load: () => Promise<{ default: T }>,
): LazyExoticComponent<T> {
  return lazy(() =>
    load().catch((err: unknown) => {
      if (!surfaceStaleDeployment(err)) throw err;
      console.warn('[lazy-chunk] chunk unavailable; rendering nothing until reload', err);
      // Renders null for any props, so it stands in for every T at runtime.
      return { default: ChunkUnavailable as unknown as T };
    }),
  );
}
