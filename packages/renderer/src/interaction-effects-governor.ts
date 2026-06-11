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
 * governor re-probes on later gestures. After MAX_STRIKES degraded gestures
 * it stops probing for the session, so a weak GPU sees at most a few brief
 * quality pops before converging to the legacy always-off behaviour, while
 * a capable GPU keeps the architectural look permanently.
 */

/** Gap between interactive frames that splits two gestures/bursts. */
const BURST_GAP_MS = 250;
/** Sliding window of recent interactive frame deltas. */
const WINDOW = 24;
/** Minimum samples in the window before a degrade verdict is allowed. */
const MIN_SAMPLES = 8;
/** Misses within the window that trigger degradation (25%). */
const MISS_LIMIT = 6;
/** A frame counts as missed when its delta exceeds refresh * MISS_FACTOR. */
const MISS_FACTOR = 1.6;
/** Refresh-interval estimate clamp (covers 40-240 Hz displays). */
const REFRESH_MIN_MS = 4;
const REFRESH_MAX_MS = 25;
/** Degraded gestures before the governor stops re-probing this session. */
const MAX_STRIKES = 3;

export class InteractionEffectsGovernor {
    private lastInteractiveTs: number | null = null;
    /** Rolling minimum of interactive deltas — refresh-interval estimate. */
    private minDelta = Infinity;
    private deltas: number[] = [];
    private degraded = false;
    private strikes = 0;

    /**
     * Record one rendered frame and decide whether post effects may run.
     * Call exactly once per render() with the frame timestamp.
     * Idle (non-interacting) frames always render at full quality.
     */
    frame(interacting: boolean, now: number): boolean {
        if (!interacting) {
            this.lastInteractiveTs = null;
            return true;
        }

        const last = this.lastInteractiveTs;
        this.lastInteractiveTs = now;

        if (last === null || now - last > BURST_GAP_MS) {
            // New gesture: clear the window and re-probe unless struck out.
            this.deltas.length = 0;
            if (this.degraded && this.strikes < MAX_STRIKES) {
                this.degraded = false;
            }
            return !this.degraded;
        }

        const delta = now - last;
        if (delta >= REFRESH_MIN_MS && delta < this.minDelta) {
            this.minDelta = delta;
        }

        if (!this.degraded) {
            this.deltas.push(delta);
            if (this.deltas.length > WINDOW) {
                this.deltas.shift();
            }
            const refresh = Math.min(
                Math.max(this.minDelta, REFRESH_MIN_MS),
                REFRESH_MAX_MS,
            );
            const missThreshold = refresh * MISS_FACTOR;
            if (this.deltas.length >= MIN_SAMPLES) {
                let misses = 0;
                for (const d of this.deltas) {
                    if (d > missThreshold) misses++;
                }
                if (misses >= MISS_LIMIT) {
                    this.degraded = true;
                    this.strikes++;
                    this.deltas.length = 0;
                }
            }
        }

        return !this.degraded;
    }

    /** True once the governor has permanently settled on degraded mode. */
    isPermanentlyDegraded(): boolean {
        return this.degraded && this.strikes >= MAX_STRIKES;
    }
}
