// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Router-free `IfcAxis2Placement2D` transform, through the placement home.

use crate::placement::Axis2Placement;
use crate::Result;
use ifc_lite_core::{DecodedEntity, EntityDecoder};
use nalgebra::Matrix4;

/// The frame of an `IfcAxis2Placement2D`: Location and optional RefDirection in
/// the XY plane. A missing or zero-length RefDirection falls back to +X, as
/// [`crate::placement::build_axis2_matrix`] repairs it for every placement.
pub(crate) fn parse_axis2_placement_2d(
    placement: &DecodedEntity,
    decoder: &mut EntityDecoder,
) -> Result<Matrix4<f64>> {
    Ok(Axis2Placement::read_2d(placement, decoder)?.matrix())
}
