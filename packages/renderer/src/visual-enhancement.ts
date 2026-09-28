/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { AO_RADIUS_RANGE, type AoQuality } from './ao-params.js';
import type { VisualEnhancementOptions, ContactShadingQuality, SeparationLinesQuality } from './types.js';

export type ResolvedVisualEnhancement = {
    enabled: boolean;
    contactShading: {
        quality: ContactShadingQuality;
        /** [0, 1]. */
        intensity: number;
        /** World units, within `AO_RADIUS_RANGE`. */
        radius: number;
    };
    separationLines: {
        enabled: boolean;
        quality: SeparationLinesQuality;
        /** [0, 1]. */
        intensity: number;
        /** Pixels, within `SEPARATION_RADIUS_RANGE_PX`. */
        radius: number;
    };
};

/**
 * Accepted `separationLines.radius`, in pixels: the tap distance the edge
 * pass (#5385) offsets its cardinal and (at `high` quality) diagonal
 * samples by. Widened from 1-2 to 1-3 when the pass gained diagonal taps and
 * a normal-crease/silhouette test alongside the entity-id test, so `high`
 * quality has room to space its 8 taps out from the 4-tap `low` default.
 */
export const SEPARATION_RADIUS_RANGE_PX = { min: 1, max: 3 } as const;

/**
 * `value` clamped to [min, max]; a missing or non-finite value keeps
 * `previous` (which is already in range).
 */
function clampOr(value: number | undefined, previous: number, min: number, max: number): number {
    if (value === undefined || !Number.isFinite(value)) return previous;
    return Math.min(max, Math.max(min, value));
}

/**
 * Resolves per-frame `VisualEnhancementOptions` against the last-resolved
 * state, so an option omitted on one frame keeps whatever the previous frame
 * (or the default) set rather than reverting. Numeric options are clamped to
 * their documented ranges here, once, so every pass reads in-range values.
 *
 * Holds the resolved state itself because nothing outside `resolve()`
 * reads or writes it: `renderFrame` is the sole caller, and no diagnostics
 * or teardown path inspects the merged result independently.
 */
export class VisualEnhancementResolver {
    private state: ResolvedVisualEnhancement = {
        enabled: true,
        contactShading: { quality: 'off', intensity: 0.8, radius: 1.0 },
        separationLines: { enabled: true, quality: 'low', intensity: 0.5, radius: 1.0 },
    };

    resolve(options?: VisualEnhancementOptions): ResolvedVisualEnhancement {
        if (!options) {
            return this.state;
        }
        const prev = this.state;
        const merged: ResolvedVisualEnhancement = {
            enabled: options.enabled ?? prev.enabled,
            contactShading: {
                quality: options.contactShading?.quality ?? prev.contactShading.quality,
                intensity: clampOr(options.contactShading?.intensity, prev.contactShading.intensity, 0, 1),
                radius: clampOr(options.contactShading?.radius, prev.contactShading.radius, AO_RADIUS_RANGE.min, AO_RADIUS_RANGE.max),
            },
            separationLines: {
                enabled: options.separationLines?.enabled ?? prev.separationLines.enabled,
                quality: options.separationLines?.quality ?? prev.separationLines.quality,
                intensity: clampOr(options.separationLines?.intensity, prev.separationLines.intensity, 0, 1),
                radius: clampOr(
                    options.separationLines?.radius,
                    prev.separationLines.radius,
                    SEPARATION_RADIUS_RANGE_PX.min,
                    SEPARATION_RADIUS_RANGE_PX.max,
                ),
            },
        };
        this.state = merged;
        return merged;
    }
}

/** Which post passes a frame runs. */
export interface LivePostEffects {
    /** The quality to run ambient occlusion at, or null when it does not run. */
    ambientOcclusion: AoQuality | null;
    /** The edge pass (#5385): entity-id, normal-crease and silhouette lines. Option name stays `separationLines`. */
    edges: boolean;
}

/**
 * The post passes to run this frame: those the options ask for, while
 * `effectsLive` (the interaction-effects governor's verdict) allows them.
 */
export function livePostEffects(ve: ResolvedVisualEnhancement, effectsLive: boolean): LivePostEffects {
    const live = effectsLive && ve.enabled;
    const aoQuality = ve.contactShading.quality;
    return {
        ambientOcclusion: live && aoQuality !== 'off' ? aoQuality : null,
        edges: live && ve.separationLines.enabled && ve.separationLines.quality !== 'off',
    };
}
