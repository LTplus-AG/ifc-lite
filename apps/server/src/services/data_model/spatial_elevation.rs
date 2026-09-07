// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Storey-elevation extraction, split out of `spatial.rs` (#3965 follow-up):
//! reading `IfcBuildingStorey.Elevation`, with the `ObjectPlacement` Z
//! fallback, is a self-contained concern the tree-building code merely calls
//! into. `spatial_tests.rs` (attached to the parent `spatial` module, not
//! this one) exercises these functions directly via `use super::*`.

use ifc_lite_core::EntityDecoder;

/// Attribute index of `IfcBuildingStorey.Elevation`, the same in IFC2X3 and IFC4:
///
/// ```text
/// [0] GlobalId   [1] OwnerHistory    [2] Name            [3] Description
/// [4] ObjectType [5] ObjectPlacement [6] Representation  [7] LongName
/// [8] CompositionType                                    [9] Elevation
/// ```
///
/// This MUST stay in step with `IFC_BUILDING_STOREY_ELEVATION_INDEX` in
/// `packages/data/src/storey-elevation.ts` — the two paths must read the same
/// slot (issue #1841). It previously read 8 (CompositionType, an enum) and fell
/// back to 7 (LongName, a string): both yield no float, so every storey reported
/// no elevation and the UI showed 0.
const STOREY_ELEVATION_INDEX: usize = 9;

/// Attribute index of `IfcBuildingStorey.ObjectPlacement`.
const STOREY_PLACEMENT_INDEX: usize = 5;

/// `IfcLocalPlacement.RelativePlacement` - the storey's own offset from its
/// parent spatial container.
const LOCAL_PLACEMENT_RELATIVE_INDEX: usize = 1;

/// `IfcAxis2Placement3D.Location` - an `IfcCartesianPoint`.
const AXIS_PLACEMENT_LOCATION_INDEX: usize = 0;

/// Extract elevation from an IFCBUILDINGSTOREY entity, in metres.
///
/// Mirrors `SpatialHierarchyBuilder.extractElevation` in `@ifc-lite/parser`:
/// read `Elevation`, and when it is null (common in Revit / ArchiCAD exports,
/// #1289) fall back to the Z of the storey's own `ObjectPlacement`. Both results
/// are raw IFC lengths, so the unit scale applies either way.
pub(super) fn extract_elevation_if_storey(
    type_name: &str,
    entity_id: u32,
    decoder: &mut EntityDecoder,
    length_unit_scale: f64,
) -> Option<f64> {
    if !type_name.eq_ignore_ascii_case("IFCBUILDINGSTOREY") {
        return None;
    }

    let entity = decoder.decode_by_id(entity_id).ok()?;

    // Read ONLY the Elevation slot. Scanning for "some attribute that parses as
    // a number" would pick up entity references (bare express ids) as bogus
    // elevations, which is the trap `@ifc-lite/parser` documents at #1289.
    let raw = match entity.get_float(STOREY_ELEVATION_INDEX) {
        Some(elevation) => elevation,
        None => {
            let placement_id = entity.get_ref(STOREY_PLACEMENT_INDEX)?;
            extract_placement_elevation(placement_id, decoder)?
        }
    };

    Some(raw * length_unit_scale)
}

/// Resolve a storey's Z from its `ObjectPlacement`, following
/// `IfcLocalPlacement -> RelativePlacement (IfcAxis2Placement3D) -> Location
/// (IfcCartesianPoint).Coordinates[2]`.
///
/// This is the placement RELATIVE to the parent spatial container, matching the
/// semantics of the `Elevation` attribute — deliberately not the absolute world
/// Z, so site-level georeferencing is not folded in. Returns the raw (unscaled)
/// value, or `None` when the chain cannot be resolved.
fn extract_placement_elevation(placement_id: u32, decoder: &mut EntityDecoder) -> Option<f64> {
    let placement = decoder.decode_by_id(placement_id).ok()?;
    let axis_id = placement.get_ref(LOCAL_PLACEMENT_RELATIVE_INDEX)?;

    let axis = decoder.decode_by_id(axis_id).ok()?;
    let location_id = axis.get_ref(AXIS_PLACEMENT_LOCATION_INDEX)?;

    let (_x, _y, z) = decoder.get_cartesian_point_fast(location_id)?;
    Some(z)
}
