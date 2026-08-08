/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * When "degrade this frame" has stopped being a transient blip (issue #2417).
 *
 * `Renderer.render()` deliberately does NOT latch on a throw that is not a
 * device-loss signal: a `RangeError` from a buffer the host cannot back happens
 * on a perfectly healthy device, and turning it into a permanent stop would kill
 * a live session (see `isDeviceLossThrow`). The cost of that choice is that a
 * failure which never clears looks exactly like one that did: the viewport is
 * wedged, and nothing anywhere says so.
 *
 * This is the "and it never cleared" signal — the policy only, kept out of the
 * renderer so the threshold has a home that can be read and tested on its own.
 */

/** Payload of `Renderer.onPersistentRenderDegradation`. */
export interface RenderDegradationInfo {
    /** Frames that threw and were degraded so far in this renderer's life. */
    degradedFrames: number;
    /** Message of the throw that crossed the threshold. */
    detail: string;
    /**
     * Which region of the frame the crossing throw came from: `frame` is
     * everything outside the encode body (canvas resize, context setup,
     * evicted-batch restore), `encode` is the command-encoder region — the one
     * that had no device discrimination at all before #2417.
     */
    origin: 'frame' | 'encode';
}

/**
 * Degraded frames before a session is called persistently degraded.
 *
 * Derived from the retry budget rather than picked: `render()` re-requests at
 * most `MAX_DEGRADED_SELF_RETRIES` (3) frames after a failure and then goes
 * quiet, so a single failure EPISODE costs at most four degraded frames — the
 * one that failed plus its three self-retries — no matter how bad it is. Four
 * such episodes therefore cannot come from one spike: they need four separate
 * render requests, which means the app's own dirty signals (interaction,
 * streaming, animation) drove the renderer back in, and it failed again each
 * time. That is "this viewport is not recovering", not "a transient host-memory
 * spike"; the latter is exactly what the retry budget exists to absorb without
 * telling anyone.
 */
export const PERSISTENT_DEGRADATION_FRAMES = 16;

/**
 * Once-per-session latch over the degraded-frame count. Holds no counter of its
 * own — the renderer already counts every degraded frame in
 * `getDiagnostics().errors`, and a second counter would be a second truth.
 */
export class RenderDegradationMonitor {
    private reported = false;

    /**
     * Record a degraded frame.
     *
     * @param degradedFrames total degraded frames so far this session.
     * @returns the report payload when THIS frame crossed the threshold, and
     *          `null` every other time — before the crossing and, because the
     *          latch is permanent, ever after it.
     */
    note(degradedFrames: number, detail: string, origin: 'frame' | 'encode'): RenderDegradationInfo | null {
        if (this.reported) return null;
        if (degradedFrames < PERSISTENT_DEGRADATION_FRAMES) return null;
        this.reported = true;
        return { degradedFrames, detail, origin };
    }
}
