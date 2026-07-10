// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Representation-type predicates: the single canonical definition of which
//! `IfcShapeRepresentation`s carry renderable body geometry.

use ifc_lite_core::DecodedEntity;

/// Whether an `IfcShapeRepresentation.RepresentationType` names a meshable
/// body/surface (as opposed to a curve/axis/annotation/footprint/box). This is
/// the SINGLE canonical definition of "renderable 3D geometry", shared by the
/// element meshing path (`processing.rs`), the void probe (opening extraction),
/// RTC-offset detection, and material-layer slicing so every site agrees on what
/// counts as real geometry. Drift here is a bug: an element meshed as body but
/// judged non-body by RTC detection casts a spurious origin vote (see
/// `rtc_offset::sample_element_translation`).
///
/// `MappedRepresentation` is included (its `IfcMappedItem`s expand to real
/// solids); callers that specifically mean DIRECT (non-mapped) geometry use
/// [`is_direct_body_representation`] instead.
pub(crate) fn is_body_representation(rep_type: &str) -> bool {
    matches!(
        rep_type,
        "Body"
            | "SweptSolid"
            | "Brep"
            | "CSG"
            | "Clipping"
            | "Tessellation"
            | "MappedRepresentation"
            | "SolidModel"
            | "SurfaceModel"
            | "Surface3D"
            | "AdvancedSweptSolid"
            | "AdvancedBrep"
    )
}

/// Whether a `RepresentationType` names DIRECT (non-mapped) body geometry, i.e.
/// [`is_body_representation`] minus the `MappedRepresentation` sentinel. Used to
/// decide whether an element's `MappedRepresentation` duplicates geometry it
/// already carries directly (and so can be skipped to avoid double-meshing).
pub(crate) fn is_direct_body_representation(rep_type: &str) -> bool {
    rep_type != "MappedRepresentation" && is_body_representation(rep_type)
}

/// The string that should drive body-representation filtering for an
/// `IfcShapeRepresentation`: `RepresentationType` (attribute 2) when present
/// and non-blank, else the `RepresentationIdentifier` (attribute 1).
///
/// CATIA exports write `IFCSHAPEREPRESENTATION(#ctx,'Body','',(items))` —
/// the TYPE is an empty string while the IDENTIFIER carries 'Body'. Filtering
/// on the raw type alone vetoes the whole representation and the element
/// meshes to zero triangles (issue #1661: both reported walls). A `$` (null)
/// type never reached the filter, so only the empty-string spelling was
/// affected.
pub(crate) fn effective_rep_type(shape_rep: &DecodedEntity) -> Option<&str> {
    [2usize, 1].into_iter().find_map(|idx| {
        shape_rep
            .get(idx)
            .and_then(|a| a.as_string())
            .filter(|s| !s.trim().is_empty())
    })
}
