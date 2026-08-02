/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Adaptive governor for post-processing effects during camera interaction.
 *
 * Historically the renderer hard-disabled contact shading + separation lines
 * while orbiting/zooming (PR #409) to protect weak integrated GPUs — at the
 * cost of the lines visibly popping off/on around every gesture on machines
 * that could easily afford them (the post pass is ~0.3-0.6 ms on Apple
 * Silicon at CSS resolution). Production viewers measure instead of presume:
 * Autodesk's viewer keeps effects on during desktop navigation and adapts a
 * frame budget from an EMA of rAF deltas; drei/Babylon degrade only when
 * sampled fps actually drops. WebGPU timestamp queries are not portable
 * (absent in Safari), so render-call cadence is the only universal signal.
 *
 * Policy: effects stay enabled during interaction as long as the cadence of
 * interactive frames holds. If a meaningful share of recent interactive
 * frames miss the (estimated) display refresh interval, effects degrade for
 * the rest of the gesture — i.e. exactly the old behaviour — and the
 * governor re-probes later. Degradation is never permanent: misses are often
 * environmental (model still streaming in, GC, tab contention), so probing
 * resumes after a cooldown that grows with consecutive degraded gestures,
 * and one clean gesture resets the penalty. Frames rendered while geometry
 * is still streaming are excluded from the verdict entirely — the upload
 * jank would otherwise strike out the session before the user ever saw the
 * effects (the "load model, orbit immediately" path).
 */

/** Gap between interactive frames that splits two gestures/bursts. */
const BURST_GAP_MS = 250;
/** Sliding window of recent interactive frame deltas. */
const WINDOW = 24;
/** Minimum samples in the window before a degrade verdict is allowed. */
const MIN_SAMPLES = 8;
/** Misses within the window that trigger degradation (25%). */
const MISS_LIMIT = 6;
/** A frame counts as missed when its delta exceeds the baseline * MISS_FACTOR. */
const MISS_FACTOR = 1.6;
/**
 * Refresh-interval estimate clamp. The upper clamp assumes at least a 60 Hz
 * display when the app declares no slower target: a GPU that can only
 * sustain ~30 fps must register misses (its cadence is the problem), while
 * an app-side render throttle for huge models raises the baseline through
 * `expectedIntervalMs` instead.
 */
const REFRESH_MIN_MS = 4;
const REFRESH_MAX_MS = 17;
/**
 * Re-probe cooldown after a degraded gesture, growing with consecutive
 * degradations and capped — a persistently weak GPU re-probes at most once
 * a minute (a single sub-second quality pop), never continuously flickering.
 */
const REPROBE_BASE_MS = 3_000;
const REPROBE_MAX_MS = 60_000;
/** Interactive frames a gesture must sustain cleanly to reset the penalty. */
const CLEAN_GESTURE_FRAMES = 30;

export class InteractionEffectsGovernor {
    private lastInteractiveTs: number | null = null;
    private deltas: number[] = [];
    private degraded = false;
    private strikes = 0;
    private lastStrikeTs = -Infinity;
    private cleanStreak = 0;

    /**
     * Record one rendered frame and decide whether post effects may run.
     * Call exactly once per render() with the frame timestamp.
     * Idle (non-interacting) frames always render at full quality.
     *
     * `unstable` marks frames whose timing does not reflect steady-state
     * rendering (geometry still streaming/uploading): they neither count
     * toward degradation nor toward a clean streak.
     *
     * `expectedIntervalMs` is the app's own intentional cap on continuous
     * render cadence (the large-model interaction throttle). When set, a
     * frame is only "missed" relative to that slower schedule — otherwise
     * the deliberately throttled cadence would read as GPU misses.
     */
    frame(
        interacting: boolean,
        now: number,
        unstable = false,
        expectedIntervalMs = 0,
    ): boolean {
        if (!interacting) {
            this.lastInteractiveTs = null;
            return true;
        }

        const last = this.lastInteractiveTs;
        this.lastInteractiveTs = now;

        if (last === null || now - last > BURST_GAP_MS) {
            // New gesture: clear the window; re-probe when the cooldown
            // (growing with consecutive degraded gestures) has elapsed.
            this.deltas.length = 0;
            this.cleanStreak = 0;
            if (this.degraded) {
                const cooldown = Math.min(
                    REPROBE_BASE_MS * Math.pow(2, Math.max(0, this.strikes - 1)),
                    REPROBE_MAX_MS,
                );
                if (now - this.lastStrikeTs >= cooldown) {
                    this.degraded = false;
                }
            }
            return !this.degraded;
        }

        if (unstable) {
            // Streaming/upload jank: keep effects in their current state but
            // do not let these frames influence the verdict either way.
            this.deltas.length = 0;
            this.cleanStreak = 0;
            return !this.degraded;
        }

        const delta = now - last;

        if (!this.degraded) {
            this.deltas.push(delta);
            if (this.deltas.length > WINDOW) {
                this.deltas.shift();
            }
            // Refresh estimate from the CURRENT window (not a lifetime
            // minimum): moving the window between displays with different
            // refresh rates re-calibrates within one gesture instead of
            // permanently judging a 60 Hz screen by a stale 120 Hz minimum.
            let windowMin = Infinity;
            for (const d of this.deltas) {
                if (d < windowMin) windowMin = d;
            }
            const refresh = Math.min(
                Math.max(windowMin, REFRESH_MIN_MS),
                REFRESH_MAX_MS,
            );
            const baseline = Math.max(refresh, expectedIntervalMs);
            const missThreshold = baseline * MISS_FACTOR;
            if (this.deltas.length >= MIN_SAMPLES) {
                let misses = 0;
                for (const d of this.deltas) {
                    if (d > missThreshold) misses++;
                }
                if (misses >= MISS_LIMIT) {
                    this.degraded = true;
                    this.strikes++;
                    this.lastStrikeTs = now;
                    this.deltas.length = 0;
                    this.cleanStreak = 0;
                } else {
                    this.cleanStreak++;
                    if (this.cleanStreak >= CLEAN_GESTURE_FRAMES && this.strikes > 0) {
                        // Sustained clean interaction: forgive past strikes so
                        // a transient bad phase doesn't dampen future probing.
                        this.strikes = 0;
                    }
                }
            }
        }

        return !this.degraded;
    }
}
