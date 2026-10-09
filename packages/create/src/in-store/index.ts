/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// In-store builders — emit elements into an existing parsed IfcDataStore
// via a `StoreEditor` overlay (closes the merge-roundtrip gap from #592).
export { linearProfileFrame } from './linear-profile-frame.js';
export { addOrdinaryElementInStore, type OrdinaryInStoreElement } from './ordinary-element.js';
export {
  addColumnToStore,
  type ColumnInStoreParams,
  type ProfiledColumnInStoreParams,
  type ColumnBuildResult,
} from './column.js';
export { addColumnOnGridToStore, type GridColumnBinding, type GridColumnBuildResult } from './grid-column.js';
export { addWallToStore, emitWallAxisRepresentation, emitWallBodyProfile, wallJoinWallFromParams, type WallInStoreParams, type WallBuildResult } from './wall.js';
// Wall joins (L / T / butt) and the IfcRelConnectsPathElements they write; the read side sits in wall-join-read.
export { computeWallJoin, reshapeWallAxis, wallBodyLateralRange, wallBodyOutline } from './wall-join.js';
export type * from './wall-join.js';
export { applyWallJoinToStore, wallJoinTargetFromBuild, type WallJoinApplyOptions, type WallJoinApplyResult, type WallJoinTarget } from './wall-join-apply.js';
export { readWallJoinTarget, readWallJoinRels, type WallJoinRead, type WallJoinRel } from './wall-join-read.js';
export { joinWallsInStore, reshapeWallsInStore, resolveWallJoinAnchor, type WallJoinInStoreResult, type WallReshape, type WallReshapeOptions, type WallReshapeResult } from './wall-join-edit.js';
export { addRelConnectsPathElementsToStore, type RelConnectsAnchor, type RelConnectsPathElementsParams } from './rel-connects-path.js';
export { addSlabToStore, type SlabInStoreParams, type SlabRectangleParams, type SlabPolygonParams, type SlabBuildResult } from './slab.js';
export { addBeamToStore, type BeamInStoreParams, type ProfiledBeamInStoreParams, type BeamBuildResult } from './beam.js';
export {
  emitProfileSection,
  validateProfileSection,
  profileSectionIfcClass,
  profileSectionExtent,
  type ProfileSection,
  type ProfileSectionType,
  type RectangleSection,
  type ISection,
  type LSection,
  type TSection,
  type USection,
  type CSection,
  type CircleSection,
  type RectangleHollowSection,
  type CircleHollowSection,
} from './profile.js';
export { addStairToStore, stairFlightOutline, type StairInStoreParams, type StairBuildResult } from './stair.js';
export { readStairDimensions, editStairDimensionsInStore, type StairDimensions, type StairDimensionEdit } from './stair-edit.js';
export { removeStairInStore } from './stair-removal.js';
export { addRailingToStore, railingPostPoints, type RailingInStoreParams, type RailingBuildResult } from './railing.js';
export { addCurtainWallToStore, curtainWallLayout, type CurtainWallInStoreParams, type CurtainWallGridSpec, type CurtainWallLayout, type CurtainWallBuildResult } from './curtain-wall.js';
export {
  addGridToStore, rectangularGridAxes, gridIntersectionPlacement, type GridInStoreParams, type GridAxisInStoreParams,
  type GridBuildResult, type GridIntersectionParams, type GridPlacementParams, type GridPlacementResult,
} from './grid.js';
export { addDoorToStore, type DoorInStoreParams, type DoorBuildResult } from './door.js';
export { addWindowToStore, type WindowInStoreParams, type WindowBuildResult } from './window.js';
export {
  addOpeningToStore,
  type OpeningInStoreParams,
  type WallOpeningInStoreParams,
  type SlabOpeningInStoreParams,
  type OpeningBuildResult,
} from './opening.js';
export {
  addHostedDoorToStore,
  addHostedWindowToStore,
  type HostedDoorInStoreParams,
  type HostedWindowInStoreParams,
  type HostedFillBuildResult,
} from './hosted-fill.js';
export { hostPlanFrame, readHostedFill, type HostPlanFrame, type HostedFillRead } from './hosted-fill-read.js';
export { addHostedElementInStore, readHostOpeningExtents, type HostedElementInStoreSpec, type HostedElementInStoreResult, type HostedOpeningExtent } from './hosted-element.js';
export { editHostedElementInStore, readHostedElementSize, type HostedElementEdit, type HostedElementSize } from './hosted-element-edit.js';
export {
  addElementTypeToStore,
  assignTypeInStore,
  type AuthoringAnchor,
  type ElementTypeInStoreParams,
  type ElementTypeBuildResult,
} from './element-type.js';
export {
  addMaterialToStore,
  addMaterialLayerSetToStore,
  addMaterialLayerSetUsageToStore,
  assignMaterialInStore,
  type MaterialInStoreParams,
  type MaterialLayerInStoreParams,
  type MaterialLayerSetInStoreParams,
  type MaterialLayerSetBuildResult,
  type MaterialLayerSetUsageInStoreParams,
} from './material.js';
export type { OneToManyResult } from './relate.js';
export { resolveAuthoringAnchor, readRelatedLists, liveEntityType, liveEntityConforms } from './resolve-relations.js';
export { addSpaceToStore, type SpaceInStoreParams, type SpaceRectangleParams, type SpacePolygonParams, type SpaceBuildResult } from './space.js';
export {
  addSpatialZonesToStore,
  spatialZonesSupported,
  type SpatialZoneInput,
  type SpatialZoneInStoreParams,
  type SpatialZoneBuildResult,
  type SpatialZoneType,
} from './spatial-zone.js';
export {
  applyStylesInStore,
  collectLeafRepresentationItems,
  type ApplyStyleOptions,
  type ApplyStyleResult,
  type StyleBatch,
  type SurfaceStyleColor,
} from './apply-style.js';
export { addRoofToStore, type RoofInStoreParams, type RoofRectangleParams, type RoofPolygonParams, type RoofBuildResult } from './roof.js';
export { addPlateToStore, type PlateInStoreParams, type PlateRectangleParams, type PlatePolygonParams, type PlateBuildResult } from './plate.js';
export { addMemberToStore, type MemberInStoreParams, type ProfiledMemberInStoreParams, type MemberBuildResult } from './member.js';
export {
  addCostScheduleToStore, addCostItemToStore, addCostValueToStore, addCostQuantityToStore,
  nestCostItemsInStore, assignCostItemsToScheduleInStore, assignObjectsToCostItemInStore,
  attachCostValuesToItemInStore,
  type CostAnchor, type ExistingRelatedList,
} from './cost.js';
export { removeCostEntityInStore, type CostRemovalReferrers } from './cost-removal.js';
export { resolveSpatialAnchor } from './resolve-anchor.js';
export { placedBodyExtent, resolveHostAnchor } from './resolve-host.js';
export { toNativeLength, fromNativeLength } from './anchor.js';
export type { SpatialAnchor, HostAnchor, HostBounds, HostKind } from './anchor.js';
export {
  duplicateInStore,
  type SourceAttributes,
  type DuplicateInStoreOptions,
  type DuplicateBuildResult,
  type Vec3 as DuplicateVec3,
} from './duplicate.js';
export { resolveDuplicateSource } from './resolve-source.js';
export { createCopyContext, copyProductInStore, copyRefusal, productStoreyOrigin, type CopyContext, type CopyTransform, type CopyProductResult } from './copy-product.js';
export {
  detectEnclosedAreas,
  type Vec2 as AutoSpaceVec2,
  type Segment as AutoSpaceSegment,
  type DetectedSpace,
  type DetectOptions as AutoSpaceDetectOptions,
} from './auto-space-detect.js';
export {
  extractWallSegmentsForStorey,
  type OverlayWallReader,
  type WallExtractionResult,
} from './extract-walls.js';
export { extractGridAxesForStorey, type GridAxisSegment, type StoreyGridAxes } from './extract-grids.js';
export {
  existingSpaceFootprintsByStorey,
  existingSpaceFootprintEntriesByStorey,
  type SpaceFootprint,
} from './space-footprints.js';
export {
  storeyPlanFrame,
  toStoreyLocal,
  fromStoreyLocal,
  type StoreyPlanFrame,
} from './storey-plan-frame.js';
export {
  generateSpacesFromWalls,
  offsetRoomFootprint,
  GENERATED_SPACE_OBJECTTYPE,
  type GenerateSpacesOptions,
  type GenerateSpacesResult,
  type BoundaryMode,
} from './generate-spaces.js';
export {
  generateSpaces,
  listStoreys,
  type GenerateSpacesAllOptions,
  type GenerateSpacesAllResult,
  type GenerateSpacesStoreyResult,
  type StoreyInfo,
} from './generate-spaces-all.js';
// Structural analysis authoring (#5167 task S.1) — IfcStructuralAnalysisModel
// and its members/connections/loads/relationships.
export {
  addStructuralAnalysisModelToStore,
  type StructuralAnalysisModelInStoreParams,
  type StructuralAnalysisModelBuildResult,
  type StructuralAnalysisModelType,
} from './structural-analysis-model.js';
export {
  addStructuralCurveMemberToStore,
  type StructuralCurveMemberInStoreParams,
  type StructuralCurveMemberBuildResult,
  type StructuralCurveMemberType,
} from './structural-curve-member.js';
export {
  addStructuralPointConnectionToStore,
  type StructuralPointConnectionInStoreParams,
  type StructuralPointConnectionBuildResult,
  type StructuralBoundaryConditionParams,
} from './structural-point-connection.js';
export {
  addStructuralLoadGroupToStore,
  type StructuralLoadGroupInStoreParams,
  type StructuralLoadGroupBuildResult,
  type StructuralLoadGroupType,
  type StructuralActionType,
  type StructuralActionSourceType,
} from './structural-load-group.js';
export {
  addStructuralPointActionToStore,
  addStructuralLinearActionToStore,
  type StructuralPointActionInStoreParams,
  type StructuralPointActionBuildResult,
  type StructuralLinearActionInStoreParams,
  type StructuralLinearActionBuildResult,
  type StructuralGlobalOrLocal,
} from './structural-action.js';
export {
  connectStructuralMemberToConnectionInStore,
  connectStructuralActivityToItemInStore,
  assignToStructuralGroupInStore,
} from './structural-relationships.js';

export {
  addDrawingMarkupToStore,
  addMeasureMarkupToStore,
  addPolygonAreaMarkupToStore,
  addTextMarkupToStore,
  addCloudMarkupToStore,
  DRAWING_MARKUP_OBJECTTYPE,
  DRAWING_MARKUP_PSET_NAME,
  DRAWING_MARKUP_QSET_NAME,
  type DrawingMarkupObjectType,
  type MarkupAnchor,
  type MarkupPoint2D,
  type MeasureMarkupParams,
  type MeasureMarkupResult,
  type PolygonAreaMarkupParams,
  type PolygonAreaMarkupResult,
  type TextMarkupParams,
  type TextMarkupResult,
  type CloudMarkupParams,
  type CloudMarkupResult,
  type DrawingMarkupBatchInput,
  type DrawingMarkupBatchResult,
} from './drawing-markup.js';

export { reanchorHostedOpeningsInStore } from './hosted-placement-edit.js';
export { reassignHostedOpeningsInStore, type HostedOpeningReassignment } from './hosted-placement-edit.js';

export { replaceElementInStore, type InStoreReplacementElement } from './element-replacement.js';
