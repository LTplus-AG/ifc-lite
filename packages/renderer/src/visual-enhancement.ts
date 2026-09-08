/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { VisualEnhancementOptions, ContactShadingQuality, SeparationLinesQuality } from './types.js';

export type ResolvedVisualEnhancement = {
    enabled: boolean;
    edgeContrast: {
        enabled: boolean;
        intensity: number;
    };
    contactShading: {
        quality: ContactShadingQuality;
        intensity: number;
        radius: number;
    };
    separationLines: {
        enabled: boolean;
        quality: SeparationLinesQuality;
        intensity: number;
        radius: number;
    };
};

/**
 * Resolves per-frame `VisualEnhancementOptions` against the last-resolved
 * state, so an option omitted on one frame keeps whatever the previous frame
 * (or the default) set rather than reverting.
 *
 * Holds the resolved state itself because nothing outside `resolve()`
 * reads or writes it: `renderFrame` is the sole caller, and no diagnostics
 * or teardown path inspects the merged result independently.
 */
export class VisualEnhancementResolver {
    private state: ResolvedVisualEnhancement = {
        enabled: true,
        edgeContrast: { enabled: true, intensity: 1.0 },
        contactShading: { quality: 'off', intensity: 0.3, radius: 1.0 },
        separationLines: { enabled: true, quality: 'low', intensity: 0.5, radius: 1.0 },
    };

    resolve(options?: VisualEnhancementOptions): ResolvedVisualEnhancement {
        if (!options) {
            return this.state;
        }
        const merged: ResolvedVisualEnhancement = {
            enabled: options.enabled ?? this.state.enabled,
            edgeContrast: {
                enabled: options.edgeContrast?.enabled ?? this.state.edgeContrast.enabled,
                intensity: options.edgeContrast?.intensity ?? this.state.edgeContrast.intensity,
            },
            contactShading: {
                quality: options.contactShading?.quality ?? this.state.contactShading.quality,
                intensity: options.contactShading?.intensity ?? this.state.contactShading.intensity,
                radius: options.contactShading?.radius ?? this.state.contactShading.radius,
            },
            separationLines: {
                enabled: options.separationLines?.enabled ?? this.state.separationLines.enabled,
                quality: options.separationLines?.quality ?? this.state.separationLines.quality,
                intensity: options.separationLines?.intensity ?? this.state.separationLines.intensity,
                radius: options.separationLines?.radius ?? this.state.separationLines.radius,
            },
        };
        this.state = merged;
        return merged;
    }
}
