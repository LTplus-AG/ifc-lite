/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Reviewed native authoring (viewer AI P15A): a serialisable, bounded batch of
 * creation, deletion, placement and relationship edits that the viewer's own
 * builders and modelling commands carry out. A sibling of `model.changes`
 * (P04), not a new version of it: data corrections compare one scalar with
 * an expected scalar, while authoring creates identities, takes lengths in a
 * declared unit and frame, and may refer to an element created earlier in the
 * same batch. Both share the GlobalId resolution, the staleness rule, one
 * native undo batch per model and the receipt library.
 *
 * Every length in a batch is in its declared `units` (`m` or `mm`), in the
 * storey-local frame (IFC Z-up, metres from the storey's placement after
 * conversion), the frame the in-store builders take. Rotation angles are degrees;
 * canonical stair Direction is radians and expected stair snapshots remain verbatim.
 * Other angles are degrees,
 * counter-clockwise seen from above. Nothing here writes.
 */

import { parseStoreyReassignment, type StoreyReassignmentOp } from './model-authoring-storey-reassignment';
import { parseLayerFields, type LayerFields } from './model-authoring-layer-params';
import { parseReplacementFields,type NativeReplacementOp } from './model-authoring-replacement-fields';
import { parseSlabOpeningFields, type SlabOpeningCreate } from './model-authoring-slab-opening';
import { parseExpectedHostedEdit, parseHostedEdit, type ExpectedHostedEdit } from './model-authoring-hosted-edit';
import { parseNativePlacement, type NativePlacement } from './model-authoring-placement';
import { parseAlignment, type AlignmentOp } from './model-authoring-align-fields';
import type { HostedElementEdit } from '@ifc-lite/create';
import { parseShapeParams, parseProfileSectionParams, AUTHORING_OUTLINE_WORK_LIMIT, type ShapeParams } from './model-authoring-shape-params';
import { MAX_GRID_AXES } from '@/lib/commands/modeling/commands/grid-place-geometry';
import { parseGridParams, parseGridColumnParams, parseGridBinding, parseGridStorey, type ReviewedGridOp } from './model-authoring-grid-fields';
import { parseReachFields, type ReachFields } from './model-authoring-reach-fields';
import { parseSplitSnapshot, parseSplitCut, type SplitCut } from './model-authoring-split-params';
import type { SplitSnapshot } from './model-authoring-split-state';
import { parseSizeParams, type ExpectedSize } from './model-authoring-size-params';
import { parseCurtainWallParams, curtainWallPartWork, CURTAIN_WALL_PART_LIMIT } from './model-authoring-curtain-wall-fields';
import type { CurtainWallInStoreParams } from '@ifc-lite/create';
import { parseStairRailingParams, parseStairPatch, parseExpectedStair, railingPostWork, STAIR_RAILING_WORK_LIMIT } from './model-authoring-stair-railing-fields';
import type { RailingInStoreParams, StairInStoreParams, StairDimensions, StairDimensionEdit, ProfileSection } from '@ifc-lite/create';
import type { ElementSizePatch } from '@/store/slices/mutation-element-size';
import { parseCopyFields, type CopyFields, type ArrayFields } from './model-authoring-copy-fields';
import { parseGlobalIdTarget, parseLength, parsePoint, parseRef, parseText, record, type LengthRange } from './model-authoring-fields';

export const AUTHORING_CLASSES = ['IfcWall', 'IfcSlab', 'IfcRoof', 'IfcPlate', 'IfcColumn', 'IfcBeam', 'IfcMember', 'IfcSpace'] as const;
export type AuthoringClass = typeof AUTHORING_CLASSES[number];
export const HOSTED_KINDS = ['door', 'window', 'opening'] as const;
export type HostedKind = typeof HOSTED_KINDS[number];
export type AuthoringUnits = 'm' | 'mm';
export type Point3 = [number, number, number];

/** An element of a loaded model, with the class and name the proposal expects it to have now. */
export interface ExistingElement { globalId: string; modelId?: string; ifcClass: string; name: string }
/** An element created by an earlier `element.create`, `hosted.create`, copy or array of the same batch. */
export interface NewElement { ref: string }
export type ElementTarget = ExistingElement | NewElement;
export interface StoreyTarget { globalId: string; modelId?: string }

/** Axis from `start` to `end` (walls: `thickness` across, `height` up; beams and members: `width` × `height` section). */
export interface AxisParams { start: Point3; end: Point3; thickness?: number; width?: number; height: number }
/** Rectangle from the `position` corner along +X (`width`) and +Y (`depth`); slabs, roofs and plates use `thickness`, spaces `height`. */
export interface BoxParams { position: Point3; width: number; depth: number; thickness?: number; height?: number }

export type AuthoringOp =
  | StoreyReassignmentOp
  | { op: 'curtainWall.create'; ref: string; storey: StoreyTarget; params: CurtainWallInStoreParams }
