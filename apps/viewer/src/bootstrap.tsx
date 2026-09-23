/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Viewer bootstrap: everything the app entry does, behind one call.
 *
 * `main.tsx` is `mountViewer(document.getElementById('root')!)`. A host
 * application that builds this viewer from source and needs to compose in
 * its own pieces at build time (today: extra file-source providers, #5228)
 * writes its own entry that calls `mountViewer` with options, instead of
 * patching viewer source. This is build-time composition only: nothing here
 * loads code at runtime, and ordinary `.iflx` extensions gain no new reach.
 */

// MUST be the first import: disables React 19.2's dev-mode component-render
// Performance tracking before react-dom caches `supportsUserTiming`, so large-IFC
// geometry/dataStore props don't blow its recursive prop-diff to a RangeError/OOM
// (the load "stops halfway" stall). See disable-react-dev-perf-track.ts.
import './disable-react-dev-perf-track';
// Must run before react-dom: guards Node.removeChild/insertBefore so a browser
// translation extension mutating the DOM can't crash the reconciler. See
// harden-dom-mutations.ts (PostHog issues #1229/#1230/#1232).
import './harden-dom-mutations';
import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
import './lib/analytics';
import './index.css';
import 'maplibre-gl/dist/maplibre-gl.css';
// Wire the placement-edit helpers' parser-backed source reader. Pure
// side-effect import; keeps `@ifc-lite/parser` out of placement-edit
// itself so its overlay-path logic stays unit-testable.
import './lib/placement-edit.boot';
// Discover contributed `i18n/locales/<tag>.ts` catalogues and activate the
// negotiated one (?lang=, remembered choice, browser languages; English default).
import './i18n/locales.boot';
import { installWasmVersionSkewRecovery } from './lib/wasm-version-skew';
import { installChunkVersionSkewRecovery } from './lib/chunk-version-skew';
import { scheduleWasmPrewarm } from './lib/wasm-prewarm';
import type { FileSourceProviderFactory } from './services/sources/source-host';

export type { FileSourceProviderFactory } from './services/sources/source-host';

export interface ViewerBootstrapOptions {
  /**
   * File-source providers (implementations of `FileSourceProvider` from
   * `@ifc-lite/plugin-api`) to register after the built-in ones. Each factory
   * is constructed and registered independently through
   * `SourceHost.register()`, so it gets the same version, duplicate-name and
   * relay checks, the same sandboxed `PluginContext` (https + allowed-domain
   * fetch, no ambient credentials, no redirects, bounded retries, namespaced
   * storage), and the same failure reporting as a built-in: one that throws
   * or is refused appears in the Sources panel as "failed to register" and
   * never stops any other provider from loading.
   */
  readonly sourceProviders?: readonly FileSourceProviderFactory[];
}

/** Mounts the viewer into `container`. Call once, from the app entry. */
export function mountViewer(container: HTMLElement, options: ViewerBootstrapOptions = {}): void {
  // WASM engine-binary recovery — the sibling of the chunk recovery below for the
  // `ifc-lite_bg.wasm` binary, which wasm-bindgen fetches inside a worker and so
  // is invisible to Vite's `vite:preloadError`. When a deploy rotates the hashed
  // wasm under an open tab the lazy fetch 404s (served as text/plain) and the
  // engine throws an `application/wasm` MIME error (#1363); reload once, debounced,
  // to pull the current deployment's assets.
  installWasmVersionSkewRecovery();

  // Post-mount chunk recovery — complements the inline boot self-heal in
  // index.html. The boot watchdog handles the ENTRY failing to load; this handles
  // a LAZY chunk (exporters / ids / bcf / sandbox …) 404ing after a newer deploy
  // ships fresh hashes mid-session. Vite dispatches `vite:preloadError` for that;
  // reload once (sessionStorage-bounded) to pull the matching new chunks. See
  // chunk-version-skew.ts for why the reload must NOT suppress Vite's re-throw.
  installChunkVersionSkewRecovery();

  ReactDOM.createRoot(container).render(
    <React.StrictMode>
      <App sourceProviders={options.sourceProviders} />
    </React.StrictMode>
  );

  // Pull the geometry engine binary down while the user is still deciding which
  // file to open, instead of on the click that opens it. See wasm-prewarm.ts.
  scheduleWasmPrewarm();
}
