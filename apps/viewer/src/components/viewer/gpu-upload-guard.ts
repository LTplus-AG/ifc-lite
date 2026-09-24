/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { posthog } from '@/lib/analytics';
import { classifyLoadError, errorCaptureProps } from '@/lib/load-errors';

/**
 * Containment for GPU upload work (`createBuffer` and friends).
 *
 * Uploading a batch can throw for reasons entirely outside the app's control:
 * the GPU device was lost (Windows TDR, GPU-process crash, driver reset), or
 * the host ran out of memory for the CPU side of the upload. Before #5429 the
 * renderer's mapped-at-creation uploads added a third, reported by Chromium as
 *
 *   RangeError: Failed to execute 'createBuffer' on 'GPUDevice': createBuffer
 *   failed, size (193836) is too large for the implementation when
 *   mappedAtCreation == true
 *
 * — misleading wording, since 193 KB is nowhere near any device limit. The
 * renderer now uploads static geometry via `queue.writeBuffer`, which cannot
 * raise it; the classifier still recognises the wording (`gpu_alloc_failed`)
 * so a regression is triaged as what it is.
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
//
// `reportedKinds` is keyed by the classified `error_kind` (#4885), not one
// shared flag: a session that already reported a `gpu_alloc_failed` must
// still report the FIRST `out_of_memory` it sees, because those are different
// bugs with different fixes and muting the second behind the first would
// hide it from triage entirely, not just de-duplicate it.
const reportedKinds = new Set<string>();
const loggedLabels = new Set<string>();
// The user-facing toast is its OWN latch, separate from `reportedKinds`
// (review, #4885): it says "part of the model may not be drawn", true for
// every kind this guard sees, so showing it again per distinct kind would
// just be the same sentence twice for one still-broken session.
let toastShown = false;

/** Reset the once-per-session latches. Test seam — not used in production. */
export function resetGpuUploadGuardForTests(): void {
  reportedKinds.clear();
  loggedLabels.clear();
  toastShown = false;
}

/**
 * Run GPU upload work, containing any throw.
 *
 * @param label Call site identifier, used to de-duplicate console warnings.
 * @param run   The upload work.
 * @param opts.isDeviceLost (#4885) Renderer's `isDeviceLost()`, consulted only
 *   when the failure classifies as `gpu_alloc_failed` — tags the captured
 *   event with `device_lost_at_time` so triage can tell device-loss fallout
 *   from real host memory pressure, which the message alone cannot.
 * @returns The callback's value, or `undefined` if it threw.
 */
export function runGpuUpload<T>(
  label: string,
  run: () => T,
  opts?: { isDeviceLost?: () => boolean },
): T | undefined {
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
    const kind = classifyLoadError(err);
    if (!reportedKinds.has(kind)) {
      reportedKinds.add(kind);
      const deviceLost = kind === 'gpu_alloc_failed' ? opts?.isDeviceLost?.() : undefined;
      posthog.captureException(err, {
        context: 'gpu_upload',
        gpu_upload_site: label,
        ...errorCaptureProps(err, undefined, deviceLost),
      });
    }
    if (!toastShown) {
      toastShown = true;
      // Tell the user once. Containment keeps the session alive, but a lost
      // device does not come back on its own and the affected batches will not
      // draw — silently showing an incomplete model would be worse than the
      // crash this replaces. Imported lazily to keep the render-path module
      // free of UI imports (same pattern as useKeyboardShortcuts).
      void import('@/components/ui/toast').then((m) => {
        m.toast.error(
          'The graphics device stopped accepting new geometry, so part of the ' +
          'model may not be drawn. Reload the page to restore full rendering.',
        );
      }).catch(() => { /* toast is best-effort; never mask the original failure */ });
    }
    return undefined;
  }
}
