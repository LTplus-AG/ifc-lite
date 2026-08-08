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
    /**
     * Degraded frames in an UNBROKEN run — counted since the last frame that
     * completed, and reset to zero by any frame that does.
     *
     * Consecutive, never cumulative, and the distinction is the whole signal:
     * a renderer-lifetime total would also be reached by isolated failures
     * spread across an hour of otherwise healthy rendering, each of which
     * recovered on the next frame. Those are exactly the transient host-memory
     * spikes the non-latching branch exists to absorb silently, and reporting
     * them would fire this on the wrong population while telling us nothing new
     * about the wedged viewports it was built for.
     */
    consecutiveDegradedFrames: number;
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
 * CONSECUTIVE degraded frames before a viewport is called persistently
 * degraded — i.e. frames that all failed with not one success between them.
 *
 * Derived from the retry budget rather than picked: `render()` re-requests at
 * most `MAX_DEGRADED_SELF_RETRIES` (3) frames after a failure and then goes
 * quiet, so the renderer can drive at most four consecutive degraded frames on
 * its own — the one that failed plus its three self-retries. Past that, every
 * further frame in the run was driven back in by the app's own dirty signals
 * (interaction, streaming, animation) and failed again, having never once
 * succeeded in between. Four times that budget is a dozen externally-driven
 * frames that all failed: "this viewport is not recovering", not "a transient
 * host-memory spike", which is exactly what the retry budget absorbs silently.
 */
export const PERSISTENT_DEGRADATION_FRAMES = 16;

/**
 * Once-per-session latch over the consecutive-degraded-frame count. Holds no
 * counter of its own — the renderer already tracks the run in
 * `consecutiveDegradedFrames`, which its own reset-on-success is responsible
 * for, and a second counter here would be a second truth that can drift out of
 * step with that reset.
 */
export class RenderDegradationMonitor {
    private reported = false;

    /**
     * Record a degraded frame.
     *
     * @param consecutiveDegradedFrames length of the CURRENT unbroken run of
     *        degraded frames, as reset by the renderer on any frame that
     *        completes. Passing a lifetime total here would silently turn this
     *        into "the Nth failure ever", which fires on sessions that
     *        recovered every time.
     * @returns the report payload when THIS frame crossed the threshold, and
     *          `null` every other time — before the crossing and, because the
     *          latch is permanent, ever after it.
     */
    note(
        consecutiveDegradedFrames: number,
        detail: string,
        origin: 'frame' | 'encode',
    ): RenderDegradationInfo | null {
        if (this.reported) return null;
        // `>=`, not `===`: the renderer is not obliged to call this on every
        // single degraded frame, and a run that steps over the threshold must
        // still report rather than sail past it forever.
        if (consecutiveDegradedFrames < PERSISTENT_DEGRADATION_FRAMES) return null;
        this.reported = true;
        return { consecutiveDegradedFrames, detail, origin };
    }
}
