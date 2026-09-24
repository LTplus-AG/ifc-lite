/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** The scene-overlay kernel's public surface (#5486, charter #5478). */

export { SceneOverlayRoot } from './SceneOverlayRoot';
export { OverlayDefs, OVERLAY_GLOW_FILTER, OVERLAY_ARROWHEAD_ACCENT_MARKER, OVERLAY_ARROWHEAD_INK_MARKER } from './OverlayDefs';
export { SceneProjector } from './projector';
export { useSceneProjector } from './SceneProjectorProvider';
export { useSceneLayer } from './SceneLayers';
export { useWorldAnchor, defaultApplyTransform } from './useWorldAnchor';
export type { WorldAnchorHandle, UseWorldAnchorOptions } from './useWorldAnchor';
export type {
  Vec3,
  ScreenPoint,
  CanvasSize,
  AnchorProjection,
  ProjectorCamera,
  ProjectorSource,
  ProjectorListener,
  Unregister,
} from './types';

export { Handle } from './primitives/Handle';
export type { HandleProps } from './primitives/Handle';
export { AxisArrow } from './primitives/AxisArrow';
export type { AxisArrowProps, AxisArrowVariant } from './primitives/AxisArrow';
export { SnapGlyph } from './primitives/SnapGlyph';
export type { SnapGlyphProps, SnapGlyphKind } from './primitives/SnapGlyph';
export { Leader } from './primitives/Leader';
export type { LeaderProps } from './primitives/Leader';
export { Pin } from './primitives/Pin';
export type { PinProps, PinStatus } from './primitives/Pin';
export { PlaneOutline } from './primitives/PlaneOutline';
export type { PlaneOutlineProps } from './primitives/PlaneOutline';
export { WorldLabel } from './primitives/WorldLabel';
export type { WorldLabelProps } from './primitives/WorldLabel';
export { AnchoredCard } from './primitives/AnchoredCard';
export type { AnchoredCardProps } from './primitives/AnchoredCard';
export { CursorInput } from './primitives/CursorInput';
export type { CursorInputProps } from './primitives/CursorInput';
