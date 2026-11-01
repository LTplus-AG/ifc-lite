// SPDX-License-Identifier: MPL-2.0
//! Whether the source authors a tessellated face set open (#7955 F3). An open set is
//! not a closed solid, so closure and the volume it implies do not apply to it; only
//! the source decides, never the published mesh.
use ifc_lite_core::{slot, DecodedEntity, IfcType};

/// `Closed` is FALSE, or the set is a TIN, which IFC4X3 never closes. Unknown (`$`,
/// `.U.`) and TRUE are not open, and neither is any other item kind.
pub fn authored_open(item: &DecodedEntity) -> bool {
    match item.ifc_type {
        IfcType::IfcTriangulatedIrregularNetwork => true,
        IfcType::IfcTriangulatedFaceSet => item.logical_at(slot::IfcTriangulatedFaceSet::CLOSED) == Some(false),
        IfcType::IfcPolygonalFaceSet => item.logical_at(slot::IfcPolygonalFaceSet::CLOSED) == Some(false),
        _ => false,
    }
}
