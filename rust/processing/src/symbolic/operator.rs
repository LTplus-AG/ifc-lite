// SPDX-License-Identifier: MPL-2.0
//! Symbolic mapped targets use the existing canonical router seam (#7779 P2).
use super::Transform2D;
use ifc_lite_core::{DecodedEntity, EntityDecoder, Error as CoreError};
use ifc_lite_geometry::{Error, GeometryRouter};
use nalgebra::Matrix4;

/// `item` is the actual IfcMappedItem. Its MappingOrigin is composed separately
/// by the symbolic walk, without the router's approximate identity shortcut.
/// The public router scales target translation once; do not scale it again.
pub(in super::super) fn resolve_mapping_target(
    item: &DecodedEntity,
    decoder: &mut EntityDecoder,
    router: &GeometryRouter,
) -> Transform2D {
    match router
        .resolve_scaled_mapped_item_transform_with_origin_loader(item, decoder, |_| Ok(None))
    {
        Ok(Some(matrix)) => Transform2D::from_matrix_xy(&Matrix4::from_column_slice(&matrix), 1.0),
        Ok(None) => Transform2D::unresolved(),
        Err(Error::ProgramStopped(stop)) => Transform2D::stopped(stop),
        Err(Error::CoreError(
            CoreError::MalformedRecord(_) | CoreError::UnrepresentableReal(_),
        )) => Transform2D::refused(),
        Err(_) => Transform2D::unresolved(),
    }
}
