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

// Post-mount chunk recovery — complements the inline boot self-heal in
// index.html. The boot watchdog handles the ENTRY failing to load; this handles
// a LAZY chunk (exporters / ids / bcf / sandbox …) 404ing after a newer deploy
// ships fresh hashes mid-session. Vite dispatches `vite:preloadError` for that;
// reload once (sessionStorage-bounded) to pull the matching new chunks.
window.addEventListener('vite:preloadError', (event) => {
  const KEY = 'ifc-lite:chunk-reload';
  // Bound the retry with sessionStorage. If storage is unavailable (private mode
  // / sandboxed frame) we can't record the attempt, so we must NOT reload — that
  // would loop forever on a permanently-missing chunk. In that case fall through
  // and let Vite surface the error.
  let attempt = 0;
  try {
    attempt = Number(sessionStorage.getItem(KEY)) || 0;
  } catch (err) {
    console.warn('[chunk-reload] sessionStorage unreadable; letting preload error surface', err);
    return;
  }
  if (attempt >= 1) return; // already retried this session — let the error surface
  let recorded = false;
  try {
    sessionStorage.setItem(KEY, String(attempt + 1));
    recorded = (Number(sessionStorage.getItem(KEY)) || 0) > attempt;
  } catch (err) {
    console.warn('[chunk-reload] sessionStorage unwritable; letting preload error surface', err);
  }
  if (!recorded) return; // couldn't bound the retry → don't suppress Vite's error or loop
  // Stop Vite from re-throwing as an unhandled rejection; we own the recovery.
  event.preventDefault();
  window.location.reload();
});

// Reaching here means the entry executed and is about to mount, so any prior
// boot/chunk reload succeeded — reset the chunk guard for a fresh budget.
try {
  sessionStorage.removeItem('ifc-lite:chunk-reload');
} catch (err) {
  // Storage unavailable — nothing was persisted to clear; log per the no-silent-catch rule.
  console.warn('[chunk-reload] could not clear retry guard', err);
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
