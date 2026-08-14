/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { RenderDegradationInfo } from '@ifc-lite/renderer';
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
// The same, for the neighbouring "degraded and never recovered" signal. A
// separate latch: the two are different failures and one must not mute the
// other (a session can degrade for a while and THEN lose the device).
let degradationReported = false;

/** Reset the once-per-session latches. Test seam — not used in production. */
export function resetDeviceLossReportForTests(): void {
  reported = false;
  degradationReported = false;
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
        // `_detail`, NOT `_message`. The privacy scrubber in
        // `lib/analytics-scrub.ts` deletes any property whose key contains
        // `message` as a `_`-delimited word (`SENSITIVE_KEY`), so
        // `device_lost_message` would be silently dropped in `before_send` and
        // this loss would arrive with no GPU text at all — the exact
        // untriageable shape #2229 exists to fix. Renaming a key into that
        // word list is a silent data loss with a green unit test, because a
        // test that stubs `captureException` sits ABOVE the scrubber; see the
        // scrub-path test in device-loss-report.test.ts, which runs the real
        // `scrubEvent` so this cannot regress unnoticed.
        device_lost_detail: info.message,
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
    // `[Viewport]`, like every other line this module logs. The `[device-loss]`
    // it used to carry was the only prefix in the file that named a failure
    // rather than the subsystem, which made the module ungreppable as a whole
    // and invited its copy on the degradation path to be wrong outright.
    console.warn('[Viewport] device-loss toast unavailable; loss reported to telemetry only:', err);
  });
}

/**
 * Report a viewport that has degraded frame after frame without recovering,
 * once per session (issue #2417).
 *
 * The renderer deliberately does NOT latch on a throw that is not a device-loss
 * signal — host memory pressure on a live device must cost one frame, not the
 * session — so this failure has no `deviceLost` state and no `device.lost`
 * promise behind it. What it does have is the same user-visible outcome as a
 * loss: a 3D view that stopped updating. Sharing this module with
 * `reportDeviceLost` is the point; the renderer stays telemetry-free and there
 * is exactly one place where a stopped viewport becomes a toast and an event.
 *
 * Never throws: it runs from a renderer callback whose other listeners must
 * still fire.
 */
export function reportPersistentRenderDegradation(info: RenderDegradationInfo): void {
  if (degradationReported) return;
  degradationReported = true;

  console.warn(
    '[Viewport] rendering degraded without recovering:',
    info.origin,
    info.consecutiveDegradedFrames,
    info.detail,
  );

  try {
    posthog.captureException(
      new Error(
        `Rendering persistently degraded (${info.origin}, ${info.consecutiveDegradedFrames} consecutive frames): ${info.detail}`,
      ),
      {
        context: 'render_degraded',
        render_degraded_origin: info.origin,
        // Named for what it is: an unbroken run, not a session total. The
        // renderer resets it on any frame that completes, and a chart that
        // read this as "failures this session" would badly overstate how bad
        // the affected sessions were.
        render_degraded_consecutive_frames: info.consecutiveDegradedFrames,
        // `_detail`, NOT `_message` — see the note on `device_lost_detail`
        // above. `lib/analytics-scrub.ts` deletes any property whose key
        // contains `message` as a `_`-delimited word, so the GPU text would be
        // silently dropped in `before_send` while a test that stubs
        // `captureException` (which sits ABOVE the scrubber) stayed green. The
        // scrub-path test in device-loss-report.test.ts runs the real
        // `scrubEvent` over these keys so that cannot regress unnoticed.
        render_degraded_detail: info.detail,
      },
    );
  } catch (err) {
    // Telemetry must never be the thing that breaks the render path.
    console.warn('[Viewport] render-degradation capture failed:', err);
  }

  // Lazily imported for the same reason as above: this module is on the render
  // path and must not pull in UI. Wording deliberately differs from the
  // device-loss toast — the device is alive here, so "lost" would be a lie, but
  // the practical advice is the same.
  void import('@/components/ui/toast').then((m) => {
    m.toast.error(
      'The 3D view has repeatedly failed to draw and has stopped updating. ' +
      'Reload the page to restore rendering.',
    );
  }).catch((err) => {
    // `[Viewport]` like the rest of this module, and the message says
    // "degradation" — not `[device-loss]`, which is what this line carried and
    // which sends anyone debugging a viewport that stopped WITHOUT a lost
    // device into the wrong subsystem entirely.
    console.warn('[Viewport] render-degradation toast unavailable; degradation reported to telemetry only:', err);
  });
}

/**
 * The minimum of a `Renderer` this module needs. Structural so the wiring can
 * be tested without a GPU (and without a React harness the viewer deliberately
 * does not have).
 */
export interface ViewportHealthSource {
  onDeviceLost(listener: (info: { message: string; reason: string }) => void): () => void;
  onPersistentRenderDegradation(listener: (info: RenderDegradationInfo) => void): () => void;
}

/**
 * Subscribe to every way the 3D view can stop being useful, and return one
 * unsubscribe for all of them.
 *
 * Both channels are wired HERE rather than at the `Viewport` call site so that
 * adding a third one, or forgetting the second, is a change to a tested unit
 * instead of an invisible omission inside a 400-line effect.
 */
export function subscribeViewportHealth(renderer: ViewportHealthSource): () => void {
  const unsubscribes = [
    renderer.onDeviceLost(reportDeviceLost),
    renderer.onPersistentRenderDegradation(reportPersistentRenderDegradation),
  ];
  return () => {
    for (const unsubscribe of unsubscribes) unsubscribe();
  };
}
