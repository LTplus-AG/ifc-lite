/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Loading and unloading MapLibre for the Location panel's minimap.
 *
 * Split out of LocationMap.tsx, which was past the ~400-line rule. This is
 * where the panel's hard-won failure handling lives: a module namespace that
 * resolves to `undefined` after a chunk-load failure, a v6 worker URL that
 * neither the dev server nor the production build resolves on its own, and a
 * teardown that must not throw on a half-initialised map. Keeping those three
 * together, and out of the component, is what makes any of it readable.
 */

// See `loadMaplibre` below for why the worker URL is threaded in by hand.
import maplibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';

// Lazy-load maplibre-gl to avoid bloating the initial bundle
let maplibrePromise: Promise<typeof import('maplibre-gl')> | null = null;
export function loadMaplibre() {
  if (!maplibrePromise) {
    const pending = import('maplibre-gl').then(ml => {
      // Defence in depth against a namespace that resolves without throwing.
      // Vite's preload helper returns `undefined` from a failed import whenever
      // a `vite:preloadError` listener calls `preventDefault()` (ours no longer
      // does - see lib/chunk-version-skew.ts), and every consumer below reads
      // `.Map` / `.Marker` off this value. Failing here routes the problem into
      // the `.catch` backstop, which degrades the panel with the right reason,
      // instead of throwing a bare "Cannot read properties of undefined
      // (reading 'Map')" that the WebGL try/catch misreads as a dead GPU.
      if (!ml) throw new Error('Failed to load the maplibre-gl module');
      // v6 ships its tile-parsing worker as a SIBLING FILE and resolves it as
      // `new URL('./maplibre-gl-worker.mjs', import.meta.url)`. Neither end of
      // our pipeline satisfies that on its own: the dev server rewrites the
      // module into node_modules/.vite/deps (handled by `optimizeDeps.exclude`
      // in vite.config.ts), and the production build emits the chunk under
      // /assets without ever emitting that sibling, because the filename is
      // computed at runtime and so is invisible to static analysis.
      //
      // The failure is silent and looks like data rather than breakage: the
      // style, sprite and TileJSON are all fetched on the main thread, so the
      // canvas, the marker and the attribution all appear, and only the vector
      // tiles never arrive. In the production build the request would have
      // resolved to the SPA's index.html with a 200, so even a network panel
      // reads as healthy. v5 inlined the worker as a blob and had no such seam.
      //
      // `?worker&url` makes Vite bundle the worker (following its own import of
      // `maplibre-gl-shared.mjs`) and hand back a real, hashed URL, in dev and
      // in the build alike. `setWorkerUrl` then keeps MapLibre from ever
      // computing the sibling path. It must run after the guard above: on the
      // undefined namespace this call is what would throw first, and it would
      // throw the wrong thing.
      ml.setWorkerUrl(maplibreWorkerUrl);
      return ml;
    });
    // A rejected promise stays rejected, so memoising one would make a single
    // transient chunk failure permanent for the rest of the session - every
    // later remount would degrade instantly without retrying. Drop the memo on
    // failure so the next mount gets a real attempt.
    maplibrePromise = pending;
    void pending.catch((err) => {
      if (maplibrePromise === pending) maplibrePromise = null;
      // Logged per the no-silent-catch rule. This handler exists only to clear
      // the memo; `pending` itself stays rejected for its real callers.
      console.warn('[location-map] maplibre module load failed; a retry will be allowed:', err);
    });
  }
  return maplibrePromise;
}

/**
 * Dispose a MapLibre map, containing any throw from its teardown.
 *
 * After a context loss MapLibre has already run `painter.destroy()`, and
 * `remove()` runs it again and then reaches through `painter.context.gl` — so
 * teardown is exactly the moment a second throw is most likely. This runs from
 * React cleanup, where an uncaught throw unmounts the surrounding tree, so the
 * failure has to stop here.
 */
export function disposeMap(map: InstanceType<typeof import('maplibre-gl').Map>) {
  try {
    map.remove();
  } catch (err) {
    console.warn('[location-map] map teardown failed; continuing:', err);
  }
}

/**
 * Undo what MapLibre's `_setupContainer` did to our div.
 *
 * It adds its class and builds the canvas plus control containers BEFORE the
 * context is requested, so both failure paths (v5 threw, v6 leaves `painter`
 * undefined) leave that debris behind with `mapRef` never assigned, which puts
 * it out of reach of the unmount cleanup. Purging before the fallback renders
 * keeps any frame from showing a dead canvas.
 */
export function purgeMapContainer(container: HTMLElement) {
  container.replaceChildren();
  container.classList.remove('maplibregl-map');
}
