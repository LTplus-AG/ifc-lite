/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Anchored builder for `IfcSpatialZone` - the schema's own name for a region
 * that is not bounded by physical elements (issue #2508 item 3).
 *
 * A location zone is a construction section or takt area a user drew against
 * the rendered scene. `docs/design/zone-emission.md` argues why it must NOT be
 * emitted as an `IfcZone`: that type groups SPACES, its `IsGroupedBy` admits
 * only `IfcSpace` / `IfcSpatialZone` / nested `IfcZone`, and this repo's own
 * reader (`extractGroupMembersOnDemand`) describes an `IfcZone`'s members that
 * way. Assigning walls to one produces a file we would mis-read ourselves.
 *
 * `IfcSpatialZone` is the type that means this, and two of its properties are
 * why it fits where `IfcZone` does not:
 *
 * - Elements attach through **`IfcRelReferencedInSpatialStructure`**, which is
 *   many-to-many and ADDITIVE. It leaves `IfcRelContainedInSpatialStructure` -
 *   the exclusive relation that carries the building's real hierarchy -
 *   untouched, so emitting zones never re-parents anything.
 * - A straddling element can therefore be referenced in BOTH zones it crosses,
 *   which is the truthful statement of the topology.
 *
 * What this cannot say is HOW MUCH of an element is in a zone. That is the
 * quantity write-back's job (`IfcLite_ZoneVolumes`), and the two are
 * complementary rather than alternatives: emit alongside the property sets,
 * never instead of them.
 *
 * Pure: no I/O, no parser access - operates entirely through the editor, like
 * every other builder here.
 */

import { generateIfcGuid } from '@ifc-lite/encoding';
import type { StoreEditor } from '@ifc-lite/mutations';
import { toNativeLength, toNativePoint3, type SpatialAnchor } from './anchor.js';
import { emitPolygonProfile, ownerHistoryRef } from './_emit-helpers.js';

/**
 * One zone to emit. Coordinates are IFC-AXES (Z-up) WORLD metres: the caller
 * has already undone the render frame and swapped axes, because only the
 * viewer knows what shifts its own pipeline applied. See
 * `apps/viewer/src/lib/zones/emit-spatial-zones.ts`.
 */
export interface SpatialZoneInput {
  /** `IfcRoot.Name` - the zone's own name, e.g. "Takt A". */
  Name: string;
  /** Base centre of the zone in IFC world metres (Z-up). */
  Position: [number, number, number];
  /** Extent along world X, metres. Ignored when `Footprint` is given. */
  Width: number;
  /** Extent along world Y, metres. Ignored when `Footprint` is given. */
  Depth: number;
  /** Extrusion height along +Z, metres. */
  Height: number;
  /** Rotation about the vertical axis, radians. Carried in the PLACEMENT
   *  rather than baked into the profile, so the profile stays a plain
   *  rectangle a receiving tool can read as one. Ignored with `Footprint`. */
  RotationZ?: number;
  /**
   * Convex footprint in IFC world metres (X/Y pairs), for a prism zone. When
   * present the zone is this polygon extruded by `Height`, and the profile is
   * emitted RELATIVE to `Position` so the placement stays the one thing that
   * positions the zone.
   */
  Footprint?: Array<[number, number]>;
}

export interface SpatialZoneInStoreParams {
  /** `IfcSpatialZone.LongName` - the zone SET's name, e.g. "Takt areas". */
  LongName: string;
  zones: SpatialZoneInput[];
  /**
   * `globalId -> expressIds` the zone references, per zone index. An element
   * appears under every zone it touches, straddlers included.
   */
  referencedElements: Array<number[]>;
  /** `IfcSpatialZone.PredefinedType`. CONSTRUCTION is what a takt area is;
   *  the enum also has FIRESAFETY, LIGHTING, OCCUPANCY, SECURITY, THERMAL,
   *  TRANSPORT, VENTILATION, USERDEFINED, NOTDEFINED. */
  PredefinedType?: string;
}

export interface SpatialZoneBuildResult {
  /** One `IfcSpatialZone` expressId per input zone, in input order. */
  zoneIds: number[];
  /** One `IfcRelReferencedInSpatialStructure` per zone that had elements. */
  relReferencedIds: number[];
}

/**
 * `IfcSpatialZone` does not exist before IFC4. Emitting one into an IFC2X3
 * file would produce an entity no reader of that schema can resolve, so the
 * caller is told rather than handed a file that fails on import.
 */
export function spatialZonesSupported(schema: SpatialAnchor['schema']): boolean {
  return (schema ?? 'IFC4') !== 'IFC2X3';
}

/**
 * Emit one `IfcSpatialZone` per zone, plus the reference relationships.
 *
 * Placement is ABSOLUTE (`PlacementRelTo = $`): the caller supplies world
 * coordinates because that is what it has - the mesh pipeline already resolved
 * every placement chain to world when it drew the zone against the model.
 * Chaining to the site instead would mean inverting that chain to get back a
 * local offset, which is arithmetic with nothing to gain: an absolute local
 * placement is valid IFC and says exactly where the user put the box.
 */
export function addSpatialZonesToStore(
  editor: StoreEditor,
  anchor: SpatialAnchor,
  params: SpatialZoneInStoreParams,
): SpatialZoneBuildResult {
  if (!spatialZonesSupported(anchor.schema)) {
    throw new Error('addSpatialZonesToStore: IfcSpatialZone requires IFC4 or later');
  }

  const zoneIds: number[] = [];
  const relReferencedIds: number[] = [];

  params.zones.forEach((zone, index) => {
    if (!Number.isFinite(zone.Height) || zone.Height <= 0) {
      throw new Error(`addSpatialZonesToStore: zone "${zone.Name}" needs a finite positive Height`);
    }
    // ONE predicate decides the shape, so the rotation and the profile cannot
    // disagree: keying the rotation off "has a Footprint" while the profile
    // needs three points would silently emit a rectangle with the caller's
    // rotation discarded. A Footprint too small to be a polygon is a caller
    // error, not a reason to emit a different shape than was asked for.
    const usePolygon = zone.Footprint !== undefined;
    if (usePolygon && (zone.Footprint as Array<[number, number]>).length < 3) {
      throw new Error(`addSpatialZonesToStore: zone "${zone.Name}" has a Footprint of fewer than 3 points`);
    }
    // Only meaningful for a box: a polygon carries its own extents.
    if (!usePolygon) {
      for (const [name, value] of [['Width', zone.Width], ['Depth', zone.Depth]] as const) {
        if (!Number.isFinite(value) || value <= 0) {
          throw new Error(`addSpatialZonesToStore: zone "${zone.Name}" needs a finite positive ${name}`);
        }
      }
    }

    const position = toNativePoint3(anchor, zone.Position);
    const height = toNativeLength(anchor, zone.Height);

    // Placement: absolute, with the vertical rotation carried as the RefDirection
    // rather than rotated into the profile.
    const originPt = editor.addEntity('IfcCartesianPoint', [position]).expressId;
    const rotation = usePolygon ? 0 : (zone.RotationZ ?? 0);
    const refDirectionId = rotation === 0
      ? null
      : editor.addEntity('IfcDirection', [[Math.cos(rotation), Math.sin(rotation), 0]]).expressId;
    const axisId = editor.addEntity('IfcAxis2Placement3D', [
      `#${originPt}`,
      null,
      refDirectionId === null ? null : `#${refDirectionId}`,
    ]).expressId;
    const placementId = editor.addEntity('IfcLocalPlacement', [null, `#${axisId}`]).expressId;

    // Profile: a rectangle for a box, the polygon for a prism. The prism's
    // points are made RELATIVE to the placement origin so the two do not both
    // carry the position (which would put the zone at twice its coordinates).
    let profileId: number;
    if (usePolygon && zone.Footprint) {
      profileId = emitPolygonProfile(
        editor,
        zone.Footprint.map(([x, y]): [number, number] => [
          toNativeLength(anchor, x - zone.Position[0]),
          toNativeLength(anchor, y - zone.Position[1]),
        ]),
      );
    } else {
      const profileOriginPt = editor.addEntity('IfcCartesianPoint', [[0, 0]]).expressId;
      const profilePos = editor.addEntity('IfcAxis2Placement2D', [`#${profileOriginPt}`, null]).expressId;
      profileId = editor.addEntity('IfcRectangleProfileDef', [
        '.AREA.',
        null,
        `#${profilePos}`,
        toNativeLength(anchor, zone.Width),
        toNativeLength(anchor, zone.Depth),
      ]).expressId;
    }

    const solidOriginPt = editor.addEntity('IfcCartesianPoint', [[0, 0, 0]]).expressId;
    const solidAxis = editor.addEntity('IfcAxis2Placement3D', [`#${solidOriginPt}`, null, null]).expressId;
    const extrudeDirection = editor.addEntity('IfcDirection', [[0, 0, 1]]).expressId;
    const solidId = editor.addEntity('IfcExtrudedAreaSolid', [
      `#${profileId}`,
      `#${solidAxis}`,
      `#${extrudeDirection}`,
      height,
    ]).expressId;

    const shapeRepId = editor.addEntity('IfcShapeRepresentation', [
      `#${anchor.bodyContextId}`,
      'Body',
      'SweptSolid',
      [`#${solidId}`],
    ]).expressId;
    const productShapeId = editor.addEntity('IfcProductDefinitionShape', [
      null,
      null,
      [`#${shapeRepId}`],
    ]).expressId;

    // IfcSpatialZone: GlobalId, OwnerHistory, Name, Description, ObjectType,
    // ObjectPlacement, Representation, LongName, PredefinedType.
    //
    // NINE attributes, not ten: `IfcSpatialZone` derives from
    // `IfcSpatialElement`, NOT from `IfcSpatialStructureElement`, so it has no
    // `CompositionType`. That difference is the schema saying what this type is
    // for - a zone is not part of the containment hierarchy.
    const zoneId = editor.addEntity('IfcSpatialZone', [
      generateIfcGuid(anchor.guidRandom),
      ownerHistoryRef(anchor.ownerHistoryId),
      zone.Name,
      null,
      null,
      `#${placementId}`,
      `#${productShapeId}`,
      params.LongName,
      `.${params.PredefinedType ?? 'CONSTRUCTION'}.`,
    ] as Parameters<StoreEditor['addEntity']>[1]).expressId;
    zoneIds.push(zoneId);

    // REFERENCED, not CONTAINED. The containment relation is exclusive: an
    // element has exactly one, and re-pointing it would move the element out of
    // the storey that owns it. Referencing is additive and many-to-many, which
    // is what lets a straddler belong to both zones it crosses.
    const elements = params.referencedElements[index] ?? [];
    if (elements.length > 0) {
      relReferencedIds.push(editor.addEntity('IfcRelReferencedInSpatialStructure', [
        generateIfcGuid(anchor.guidRandom),
        ownerHistoryRef(anchor.ownerHistoryId),
        null,
        null,
        elements.map((id) => `#${id}`),
        `#${zoneId}`,
      ]).expressId);
    }
  });

  return { zoneIds, relReferencedIds };
}
