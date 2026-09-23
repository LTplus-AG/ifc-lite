/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Application entry point. Everything, including the load-bearing
 * side-effect import order, lives in `bootstrap.tsx`; a host application
 * building the viewer from source calls `mountViewer` from its own entry
 * with options instead of editing this file.
 */

// turbo-cache-bust: the OOM'd 2fd153e7 build cached a partial apps/viewer/dist
// for this viewer:build input hash (built under fat-LTO memory pressure), so
// every later FULL-TURBO build restored the broken dist → READY-but-404. This
// content change forces a cache miss so the viewer rebuilds fresh now that
// thin-LTO removes the OOM. Safe to delete once a clean build is cached.

import { mountViewer } from './bootstrap';

mountViewer(document.getElementById('root')!);
