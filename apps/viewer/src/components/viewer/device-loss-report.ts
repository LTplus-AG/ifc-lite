/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { posthog } from '@/lib/analytics';

/**
 * What the user and error tracking are told when the GPU device dies.
 *
 * The renderer already contains a device loss: `render()` degrades to a quiet
 * skip and `pick()` to "no hit", so nothing crashes. That containment is also
 * the problem — until #2229, NOTHING in the app subscribed to
 * `renderer.onDeviceLost()`, so a loss looked exactly like a viewer that had
 * simply stopped: no toast, no telemetry, and (on Safari, whose loss signal is
 * a synchronous throw rather than the `device.lost` promise) an uncaught
 * DOMException as the only trace.
 *
 * This module is that missing subscriber's body: one toast in the same wording
 * `gpu-upload-guard` uses for the neighbouring failure, and one tagged
 * exception so future losses arrive in error tracking as `device_lost` rather
 * than as raw stack frames nobody can attribute.
 */

// Session-scoped latch. Module state is deliberate: the loss is a property of
// the device, not of a component instance, so a remount must not re-toast.
let reported = false;

/** Reset the once-per-session latch. Test seam — not used in production. */
export function resetDeviceLossReportForTests(): void {
  reported = false;
}

/**
 * Report a GPU device loss to the user and to error tracking, once per
 * session. Never throws: it runs from a renderer callback whose other
 * listeners must still fire.
 */
export function reportDeviceLost(info: { message: string; reason: string }): void {
  if (reported) return;
  reported = true;

  console.warn('[Viewport] GPU device lost:', info.reason, info.message);

  try {
    posthog.captureException(
      new Error(`GPU device lost (${info.reason}): ${info.message}`),
      {
        context: 'device_lost',
        device_lost_reason: info.reason,
        device_lost_message: info.message,
      },
    );
  } catch (err) {
    // Telemetry must never be the thing that breaks the loss path.
    console.warn('[Viewport] device-loss capture failed:', err);
  }

  // Imported lazily to keep the render-path module free of UI imports (same
  // pattern as gpu-upload-guard). Wording follows that guard's toast, but says
  // "stopped drawing" rather than its "part of the model may not be drawn":
  // a lost device stops the WHOLE view, not one batch, and it does not come
  // back without a reload.
  void import('@/components/ui/toast').then((m) => {
    m.toast.error(
      'The graphics device was lost, so the 3D view has stopped drawing. ' +
      'Reload the page to restore rendering.',
    );
  }).catch((err) => {
    // Best-effort: a failed toast must never mask the device loss itself. But
    // swallow it SILENTLY and the one case that matters — the toast chunk
    // failing to load, so the user gets no notification at all about a view
    // that has stopped — becomes invisible to us too. Log, do not rethrow.
    console.warn('[device-loss] toast unavailable; loss reported to telemetry only:', err);
  });
}
