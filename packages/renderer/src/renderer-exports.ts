/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Re-exports of `renderer.ts`, kept here so that module stays within its size budget. */
export { DEFAULT_CAP_STYLE, HATCH_PATTERN_IDS } from './section-cap-style.js';
export type { SectionCapStyle, HatchPatternId } from './section-cap-style.js';
export { planeBasis, nearestCardinalAxis } from './section-plane-basis.js';
export type { PlaneBasis, Vec3Tuple } from './section-plane-basis.js';
export { capHighlightKey } from './section-2d-overlay.js';
export { SECTION_BOX_CAP_FACES, sectionBoxCapKey } from './section-box-caps.js';
export type { SectionBoxCapFace } from './section-box-caps.js';
export type { Section2DOverlayOptions, Section2DOverlayCapStyle, CutPolygon2D, DrawingLine2D, LineOverlayChannel, LineOverlayOptions } from './section-2d-overlay.js';
export { LINE_OVERLAY_CHANNELS } from './section-2d-overlay.js';
export { Raycaster } from './raycaster.js';
export { SnapDetector, SnapType } from './snap-detector.js';
export { BVH } from './bvh.js';
export { hostsOtherEntities } from './mesh-entity-hosting.js';
export { materializeShardOccurrences } from './scene-instance-materialization.js';
export { OverlayIdSpaceExhaustedError } from './overlay-id-space-exhausted-error.js';
export { FederationRegistry, federationRegistry, ModelRangeExtensionRefusedError } from './federation-registry.js';
export type { ModelRange, GlobalIdLookup } from './federation-registry.js';
export { MAX_EXTRA_CLIP_PLANES } from './extra-clip-planes.js';
export type { SectionPlaneFrame, SectionFrameInput } from './section-plane-frames.js';
export {
    resolveEnvironment,
    deriveSkyGradient,
    packEnvironmentUniforms,
    ENVIRONMENT_UNIFORM_SIZE,
} from './environment.js';
export type { LightingEnvironment, ResolvedEnvironment, SkyGradient, Vec3Color } from './environment.js';
export { replayReleasedGeometry } from './released-geometry-replay.js';
export type { ReleasedSceneRebuild, ReleasedSceneRebuildContext } from './released-scene-recovery.js';
export type { ReleasedGeometryReplayOptions, ReleasedGeometryReplayResult } from './released-geometry-replay.js';
