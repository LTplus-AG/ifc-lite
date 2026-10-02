/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Heartbeat from INSIDE one synchronous geometry batch call.
 *
 * The worker used to be able to speak only between WASM calls, so a single
 * slow element (tens of seconds on a wall with hundreds of curved openings)
 * looked exactly like a hung call. The pool's hung-call recovery then replaced
 * the worker after 45 s and skipped the element after 90 s more, so whether
 * the element appeared depended on the user's CPU speed: the same file loaded
 * with different geometry on different machines, and the replay alone added
 * 45 s plus a full re-run of the element.
 *
 * The geometry kernel now reports progress at coarse points of every long
 * path (`ifc_lite_geometry::progress`); the WASM binding rate-limits that to
 * at most one callback a second. This module turns those callbacks into the
 * worker's existing liveness message, but only while a geometry batch call is
 * running, so nothing else the worker does (pre-pass, style resolution) emits
 * a geometry-call heartbeat. A call that stops reporting is still recovered
 * by the pool exactly as before.
 */

import type { GeometryWorkerProgressMessage } from './geometry.worker.js';

/** Liveness ping without slice context: the in-call heartbeat, and the
 *  recovery paths that recurse or re-init inside one batch. */
export function postWorkerHeartbeat(): void {
  (self as unknown as Worker).postMessage(
    { type: 'progress', processedJobs: 0, totalJobs: 0 } satisfies GeometryWorkerProgressMessage,
  );
}

export interface InCallHeartbeat {
  /** Passed to the WASM binding; posts a heartbeat while a batch call runs. */
  readonly callback: () => void;
  /** Run one geometry batch call with heartbeats enabled. */
  run<T>(call: () => Promise<T>): Promise<T>;
}

export function createInCallHeartbeat(postHeartbeat: () => void): InCallHeartbeat {
  let active = false;
  return {
    callback: () => {
      if (active) postHeartbeat();
    },
    async run<T>(call: () => Promise<T>): Promise<T> {
      active = true;
      try {
        return await call();
      } finally {
        active = false;
      }
    },
  };
}
