/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Mount the viewer shell before the first file arrives (fixed load floor).
 *
 * Until the first open, the viewport showed only the welcome layer, so the open
 * itself paid for mounting the viewer (one 130-180 ms long task) and for the
 * WebGPU device and pipelines its `Viewport` creates (0.15 s of device creation
 * alone; a snapshot reopen waits 0.33-0.46 s for it). Here the shell mounts at
 * the first idle period after the welcome screen is up, hidden and inert under
 * the welcome layer, so an open is a state change on an already-mounted viewer.
 *
 * The render runs as a transition, so React yields to input while it builds the
 * shell; only its commit is one task. Skipped (the shell then mounts on the
 * first open, as before) when the kill switch `perf.warmShell=0` is set, when
 * the browser reports under 4 GB of device memory or asks to save data, and
 * while the tab is hidden (it then waits for the tab to become visible).
 */

import { startTransition, useEffect, useState } from 'react';
import { readPerfFlag } from '@/lib/perf/flags';
import { holdBootSettled } from '@/lib/boot-settled';
import { scheduleWhenIdle, warmRuntimeEnvironment, warmRuntimeRefusal } from '@/lib/warm-runtime-gate';

function refused(): boolean {
  return warmRuntimeRefusal(warmRuntimeEnvironment(readPerfFlag('warmShell'))) !== null;
}

/** Once the shell has been warmed in this page, a remounted container mounts it at once. */
let warmedInPage = false;
/**
 * Boot is not settled until the shell is warm (its renderer ready) or refused.
 * Held from module evaluation, so it is pending before the first commit.
 */
const settleBoot = holdBootSettled('warm-shell');
const rendererReady = () => typeof (globalThis as { __ifc_lite_render_stats__?: unknown }).__ifc_lite_render_stats__ === 'function';

/** Settle boot once the warm shell's renderer has initialised (its debug hooks install on init). */
function settleWhenRendererReady(): void {
  let frames = 0;
  const poll = () => {
    if (rendererReady() || ++frames > 600) { settleBoot(); return; }
    requestAnimationFrame(poll);
  };
  poll();
}

/**
 * True once the viewer shell should be mounted under the welcome layer.
 * `eligible` is false until WebGPU is known to be usable (without it the shell
 * would only mount an error state); `decided` is true once that check has
 * finished, so an ineligible browser settles boot instead of holding it.
 * `welcome` is whether the welcome layer shows: an open that comes first
 * mounts the shell itself, and the pending warm-up is cancelled rather than
 * re-rendering the viewport in the middle of that load.
 */
export function useWarmShell(eligible: boolean, decided: boolean, welcome: boolean): boolean {
  const [warm, setWarm] = useState(warmedInPage);
  useEffect(() => {
    if (warm || typeof window === 'undefined') return;
    if (!welcome) { settleBoot(); return; }
    if (!eligible) { if (decided) settleBoot(); return; }
    if (refused()) { settleBoot(); return; }
    return scheduleWhenIdle(() => startTransition(() => { warmedInPage = true; setWarm(true); }));
  }, [eligible, decided, welcome, warm]);
  useEffect(() => { if (warm && eligible) settleWhenRendererReady(); }, [warm, eligible]);
  return warm && eligible;
}
