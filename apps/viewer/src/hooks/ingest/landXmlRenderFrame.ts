/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { MeshData, ModelSpatialReference } from '@ifc-lite/geometry';
import { createEmptyBounds, type Bounds3D } from '../../utils/localParsingUtils.js';
import type { SourceSpatialMetadata } from './sourceSpatialReference.js';

/**
 * A single LandXML mesh may only span this much in its local f32 vertex
 * buffer. The streaming geometry path partitions bounded mesh data below this
 * emergency envelope. A component must also remain within that envelope of
 * the shared frame origin. Its own span is deliberately not a federation
 * refusal: wide components are partitioned by the precision pipeline, and a
 * [-750 km, +750 km] component is valid relative to the shared frame.
 */
export const MAX_RENDER_FRAME_LOCAL_EXTENT_METRES = 1_000_000;
/** Current name retained by federation callers; see the local-extent note above. */
export const MAX_RENDER_FRAME_ORIGIN_METRES = MAX_RENDER_FRAME_LOCAL_EXTENT_METRES;

/** Canonical parse and streamed-completion diagnostic for frozen-frame drops. */
export function landXmlRenderFrameWarning(droppedComponents: number): string {
  return `Skipped ${droppedComponents} LandXML surface component(s) outside the ${MAX_RENDER_FRAME_LOCAL_EXTENT_METRES / 1000} km shared render-frame envelope`;
}

interface RenderFrameComponent {
  mesh: MeshData;
  bounds: Bounds3D;
  /** Components split from one connected surface must be accepted atomically. */
  frameGroup?: string;
}

/** Stable frame chosen during the cursor's geometry-free preflight pass. */
export interface LandXmlRenderFramePlan {
  originShift: { x: number; y: number; z: number };
  hasLargeCoordinates: boolean;
}

/** Derive the exact frame after a preflight has retained only bounds probes. */
export function deriveLandXmlRenderFrameFromMeasurement(
  sourceBounds: Bounds3D,
  dominantBounds: Bounds3D,
): LandXmlRenderFramePlan {
  const maxAbs = Math.max(
    Math.abs(sourceBounds.min.x), Math.abs(sourceBounds.min.y), Math.abs(sourceBounds.min.z),
    Math.abs(sourceBounds.max.x), Math.abs(sourceBounds.max.y), Math.abs(sourceBounds.max.z),
  );
  const hasLargeCoordinates = maxAbs > 10_000;
  return hasLargeCoordinates
    ? { originShift: {
      x: (dominantBounds.min.x + dominantBounds.max.x) / 2,
      y: (dominantBounds.min.y + dominantBounds.max.y) / 2,
      z: (dominantBounds.min.z + dominantBounds.max.z) / 2,
    }, hasLargeCoordinates }
    : { originShift: { x: 0, y: 0, z: 0 }, hasLargeCoordinates };
}

function mergeBounds(target: Bounds3D, source: Bounds3D): void {
  target.min.x = Math.min(target.min.x, source.min.x);
  target.min.y = Math.min(target.min.y, source.min.y);
  target.min.z = Math.min(target.min.z, source.min.z);
  target.max.x = Math.max(target.max.x, source.max.x);
  target.max.y = Math.max(target.max.y, source.max.y);
  target.max.z = Math.max(target.max.z, source.max.z);
}

/** Whether a component lies inside the shared render-frame acceptance envelope. */
export function boundsFitRenderFrame(
  bounds: Bounds3D,
  originShift: Readonly<{ x: number; y: number; z: number }>,
): boolean {
  const coordinates = [
    bounds.min.x, bounds.min.y, bounds.min.z,
    bounds.max.x, bounds.max.y, bounds.max.z,
  ];
  if (!coordinates.every(Number.isFinite) || !Object.values(originShift).every(Number.isFinite)) return false;
  const frameFit = [
    bounds.min.x - originShift.x, bounds.min.y - originShift.y, bounds.min.z - originShift.z,
    bounds.max.x - originShift.x, bounds.max.y - originShift.y, bounds.max.z - originShift.z,
  ].every((coordinate) => Math.abs(coordinate) <= MAX_RENDER_FRAME_LOCAL_EXTENT_METRES);
  return frameFit;
}

/**
 * Parser components are one GPU mesh today, so an unpartitioned connected
 * component still needs a bounded local extent. This is deliberately separate
 * from `boundsFitRenderFrame`: a wide component may fit a shared frame once
 * the precision pipeline has partitioned it, but raw connected geometry cannot
 * be narrowed safely by merely changing its origin.
 */
/** Whether one RTE-local mesh can preserve its full f32 spatial extent. */
export function boundsFitLandXmlPrecisionBatch(bounds: Bounds3D): boolean {
  const span = Math.max(
    bounds.max.x - bounds.min.x,
    bounds.max.y - bounds.min.y,
    bounds.max.z - bounds.min.z,
  );
  return Number.isFinite(span) && span <= MAX_RENDER_FRAME_LOCAL_EXTENT_METRES;
}

/**
 * Place parsed mesh components in their model-local frame.
 *
 * Every accepted component must fit the same shared-frame envelope. The mesh
 * and instanced RTE paths both pack drawable-minus-camera deltas with this
 * limit, so admitting a remote disconnected island here would only defer an
 * unavoidable render failure until draw submission. This applies equally to
 * primary and federated loads; federation must never be the first place a
 * model discovers that it was not renderable.
 */
export function placeComponentsInRenderFrame<T extends RenderFrameComponent>(
  components: T[],
  warnings: string[] = [],
): { placed: T[]; dropped: T[]; bounds: Bounds3D; originShift: { x: number; y: number; z: number }; hasLargeCoordinates: boolean } {
  const sourceBounds = createEmptyBounds();
  for (const component of components) mergeBounds(sourceBounds, component.bounds);
  const dominant = components.reduce((best, component) => (
    component.mesh.indices.length > best.mesh.indices.length ? component : best
  ));
  return placeComponentsInKnownRenderFrame(
    components,
    deriveLandXmlRenderFrameFromMeasurement(sourceBounds, dominant.bounds),
    warnings,
  );
}

/** Apply a frame selected by an earlier bounded preflight pass. */
export function placeComponentsInKnownRenderFrame<T extends RenderFrameComponent>(
  components: T[],
  frame: LandXmlRenderFramePlan,
  warnings: string[],
): { placed: T[]; dropped: T[]; bounds: Bounds3D; originShift: { x: number; y: number; z: number }; hasLargeCoordinates: boolean } {
  const originShift = frame.originShift;
  const placed: T[] = [];
  const dropped: T[] = [];
  const bounds = createEmptyBounds();
  const rejectedGroups = new Set(components
    .filter((component) => !boundsFitLandXmlPrecisionBatch(component.bounds)
      || !boundsFitRenderFrame(component.bounds, originShift))
    .map((component) => component.frameGroup)
    .filter((group): group is string => group !== undefined));
  for (const component of components) {
    if (!boundsFitLandXmlPrecisionBatch(component.bounds)
      || !boundsFitRenderFrame(component.bounds, originShift)
      || (component.frameGroup !== undefined && rejectedGroups.has(component.frameGroup))) {
      dropped.push(component);
      continue;
    }
    const origin = component.mesh.origin ?? [0, 0, 0];
    component.mesh.origin = [
      origin[0] - originShift.x,
      origin[1] - originShift.y,
      origin[2] - originShift.z,
    ];
    placed.push(component);
    mergeBounds(bounds, component.bounds);
  }
  if (dropped.length > 0) {
    warnings.push(landXmlRenderFrameWarning(dropped.length));
  }
  return { placed, dropped, bounds, originShift, hasLargeCoordinates: frame.hasLargeCoordinates };
}

/** Derive the canonical dominant-component frame without allocating geometry. */
export function deriveLandXmlRenderFrame<T extends RenderFrameComponent>(components: readonly T[]): LandXmlRenderFramePlan {
  const sourceBounds = createEmptyBounds();
  for (const component of components) mergeBounds(sourceBounds, component.bounds);
  const dominant = components.reduce((best, component) => (
    component.mesh.indices.length > best.mesh.indices.length ? component : best
  ));
  return deriveLandXmlRenderFrameFromMeasurement(sourceBounds, dominant.bounds);
}

/** Return one mesh's complete bounds in its current render frame. */
export function meshRenderFrameBounds(mesh: MeshData): Bounds3D | null {
  const origin = mesh.origin ?? [0, 0, 0];
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let index = 0; index < mesh.positions.length; index += 3) {
    const x = mesh.positions[index] + origin[0];
    const y = mesh.positions[index + 1] + origin[1];
    const z = mesh.positions[index + 2] + origin[2];
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return null;
    minX = Math.min(minX, x); minY = Math.min(minY, y); minZ = Math.min(minZ, z);
    maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); maxZ = Math.max(maxZ, z);
  }
  return Number.isFinite(minX)
    ? { min: { x: minX, y: minY, z: minZ }, max: { x: maxX, y: maxY, z: maxZ } }
    : null;
}

/** Whether a mesh's complete render-frame extent remains safe for f32 upload. */
export function meshFitsRenderFrame(mesh: MeshData): boolean {
  const bounds = meshRenderFrameBounds(mesh);
  return bounds !== null && boundsFitRenderFrame(bounds, { x: 0, y: 0, z: 0 });
}

/*
 * Why a federated LandXML has no surface inside the shared render frame (#7605).
 *
 * The admission guard is right to refuse here. A LandXML that was not aligned
 * keeps its map coordinates, and against a georeferenced anchor those sit
 * thousands of kilometres from the anchor's engineering origin, beyond what
 * the f32 render-frame envelope can hold. What the user can act on is why it
 * was not aligned: a declaration the spatial resolver needs and was not given.
 * This names every such declaration on both sides. It does not relax the
 * fail-closed rules: unknown vertical datums still refuse
 * (`resolveSpatialPlacement`), and a CRS is still never inferred from a
 * display name or a coordinate magnitude.
 *
 * Both federated paths use it: the streaming plan's frozen admission and the
 * whole-document reframe.
 */

/** The CRS identifiers a LandXML `CoordinateSystem` declares, as the adapter reads them. */
export type LandXmlDeclaredCrs = Pick<SourceSpatialMetadata, 'horizontalId' | 'verticalId'>;

export interface LandXmlFrameRefusalContext {
  /** What the LandXML declares; absent identifiers are what blocked alignment. */
  declared: LandXmlDeclaredCrs;
  /** The georeferenced federation anchor, or null when no loaded model is georeferenced. */
  anchor: ModelSpatialReference | null;
  /** Whether the surfaces were brought into the anchor's frame before the guard ran. */
  aligned: boolean;
}

/** The declaration carried by an already-complete reference, for callers holding only that. */
export function declaredCrsOf(reference: ModelSpatialReference | undefined): LandXmlDeclaredCrs {
  return { horizontalId: reference?.horizontal?.id, verticalId: reference?.vertical?.id };
}

const KM = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });

/** The render-frame predicate's own measure: the largest per-axis offset from the frame origin. */
export function renderFrameDistanceMetres(
  bounds: Bounds3D,
  originShift: Readonly<{ x: number; y: number; z: number }>,
): number {
  return Math.max(
    Math.abs(bounds.min.x - originShift.x), Math.abs(bounds.min.y - originShift.y), Math.abs(bounds.min.z - originShift.z),
    Math.abs(bounds.max.x - originShift.x), Math.abs(bounds.max.y - originShift.y), Math.abs(bounds.max.z - originShift.z),
  );
}

function anchorField(anchor: ModelSpatialReference, ifcField: string, landXmlField: string, otherwise: string): string {
  const format = anchor.sourceMetadata?.format;
  return format === 'ifc' ? ifcField : format === 'landxml' ? landXmlField : otherwise;
}

/** Every missing or conflicting declaration that keeps the LandXML out of the anchor's frame. */
function landXmlAlignmentBlockers(declared: LandXmlDeclaredCrs, anchor: ModelSpatialReference | null): string[] {
  if (anchor === null) return ['none of the loaded models is georeferenced, so there is no map frame to place it in'];
  const blockers: string[] = [];
  const missing: string[] = [];
  if (!declared.horizontalId) missing.push('horizontal CRS (CoordinateSystem epsgCode, or an EPSG:<n> horizontalDatum)');
  if (!declared.verticalId) missing.push('vertical datum (CoordinateSystem verticalDatum, as EPSG:<n>)');
  if (missing.length > 0) blockers.push(`this LandXML declares no ${missing.join(' and no ')}`);
  if (!anchor.horizontal) {
    blockers.push(`the anchor's projected CRS is not an EPSG:<n> identifier (${anchorField(anchor, 'IfcProjectedCRS.Name', 'CoordinateSystem epsgCode', 'horizontal CRS')})`);
  }
  if (!anchor.vertical) {
    blockers.push(`the anchor declares no vertical datum (${anchorField(anchor, 'IfcProjectedCRS.VerticalDatum', 'CoordinateSystem verticalDatum', 'vertical CRS')})`);
  } else if (declared.verticalId && declared.verticalId !== anchor.vertical.id) {
    blockers.push(`the vertical datums differ (${declared.verticalId} here, ${anchor.vertical.id} on the anchor)`);
  }
  if (blockers.length === 0 && declared.horizontalId && anchor.horizontal && declared.horizontalId !== anchor.horizontal.id) {
    blockers.push(`${declared.horizontalId} could not be reprojected to ${anchor.horizontal.id}`);
  }
  return blockers;
}

function joinClauses(clauses: readonly string[]): string {
  if (clauses.length <= 1) return clauses[0] ?? '';
  // Clauses can contain their own "and", so the last one is always comma-led.
  return `${clauses.slice(0, -1).join(', ')}, and ${clauses[clauses.length - 1]}`;
}

/** The one refusal both federated LandXML paths raise when no surface fits the shared frame. */
export function landXmlFrameRefusalMessage(distanceMetres: number, context: LandXmlFrameRefusalContext): string {
  const where = `its surfaces lie up to ${KM.format(distanceMetres / 1000)} km from the shared render origin, `
    + `outside the ${KM.format(MAX_RENDER_FRAME_LOCAL_EXTENT_METRES / 1000)} km shared render-frame envelope`;
  const target = context.anchor === null ? ''
    : context.anchor.horizontal ? ` to the anchor's ${context.anchor.horizontal.id}` : ' to the anchor';
  let why: string;
  if (context.aligned) {
    why = `It was aligned${target}, so the surfaces are that far from the anchor model.`;
  } else {
    const blockers = landXmlAlignmentBlockers(context.declared, context.anchor);
    why = blockers.length > 0
      ? `It was not aligned${target} because ${joinClauses(blockers)}; its coordinates were kept as authored.`
      : `It could not be aligned${target}; its coordinates were kept as authored.`;
  }
  return `LandXML federation preflight rejected every render component: ${where}. ${why}`;
}
