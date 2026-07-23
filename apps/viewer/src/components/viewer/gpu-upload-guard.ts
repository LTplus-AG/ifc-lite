/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { posthog } from '@/lib/analytics';
import { classifyLoadError } from '@/lib/load-errors';

/**
 * Containment for GPU upload work (`createBuffer` and friends).
 *
 * Uploading a batch can throw for reasons entirely outside the app's control:
 * the GPU device was lost (Windows TDR, GPU-process crash, driver reset), or
 * the browser could not map host memory for a new buffer. Chromium reports the
 * latter as
 *
 *   RangeError: Failed to execute 'createBuffer' on 'GPUDevice': createBuffer
 *   failed, size (193836) is too large for the implementation when
 *   mappedAtCreation == true
 *
 * — misleading wording, since 193 KB is nowhere near any device limit.
 *
 * Where such a throw lands decides how bad it is, and both landing sites are
 * fatal to the viewport:
 *  - inside a React effect, an uncaught throw unmounts the tree — the <canvas>
 *    goes with it and the user is left with a blank viewer;
 *  - inside the rAF callback, it skips the tail-position
 *    `requestAnimationFrame(animate)` that re-arms the loop, so rendering stops
 *    permanently with no further frames.
 *
 * Neither is recoverable by the user without a reload, and neither is worth it:
 * a batch that fails to upload should cost that batch, not the session. This
 * helper swallows the failure, keeps a console breadcrumb, and reports ONCE per
 * session to error tracking — once, because these failures repeat every frame
 * and would otherwise flood both the console and the exception quota.
 */

// Session-scoped latches. Module state is deliberate: the failure is a property
// of the device, not of any one component instance, so remounting must not
// re-open the floodgates.
let reportedToErrorTracking = false;
const loggedLabels = new Set<string>();

/** Reset the once-per-session latches. Test seam — not used in production. */
export function resetGpuUploadGuardForTests(): void {
  reportedToErrorTracking = false;
  loggedLabels.clear();
}

/**
 * Run GPU upload work, containing any throw.
 *
 * @param label Call site identifier, used to de-duplicate console warnings.
 * @param run   The upload work.
 * @returns The callback's value, or `undefined` if it threw.
 */
export function runGpuUpload<T>(label: string, run: () => T): T | undefined {
  try {
    return run();
  } catch (err) {
    if (!loggedLabels.has(label)) {
      loggedLabels.add(label);
      console.warn(
        `[gpu] ${label} failed (device lost or out of GPU memory); ` +
        'skipping this batch and continuing to render:',
        err,
      );
    }
    if (!reportedToErrorTracking) {
      reportedToErrorTracking = true;
      posthog.captureException(err, {
        context: 'gpu_upload',
        gpu_upload_site: label,
        error_kind: classifyLoadError(err),
      });
    }
    return undefined;
  }
}
