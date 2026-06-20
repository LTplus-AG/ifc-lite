/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Application entry point
 */

// turbo-cache-bust: the OOM'd 2fd153e7 build cached a partial apps/viewer/dist
// for this viewer:build input hash (built under fat-LTO memory pressure), so
// every later FULL-TURBO build restored the broken dist → READY-but-404. This
// content change forces a cache miss so the viewer rebuilds fresh now that
// thin-LTO removes the OOM. Safe to delete once a clean build is cached.

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

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
