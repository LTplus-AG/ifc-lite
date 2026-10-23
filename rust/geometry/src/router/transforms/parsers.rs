// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Leaf IFC primitive placement parsers: axis placements, points, directions.
//! These are one-line delegates to the canonical readers
//! ([`crate::transform`], on `EntityDecoder::{point3, direction3}`), kept
//! `pub(crate)` until C2 moves `router/voids/probe.rs` off them. The
//! `IfcCartesianTransformationOperator` lives in `operator.rs` and the
//! `IfcMappedItem` target/origin composition in `mapped.rs`.

use super::super::GeometryRouter;
use crate::{Result, Vector3};
use ifc_lite_core::{DecodedEntity, EntityDecoder};
use nalgebra::Matrix4;

impl GeometryRouter {
    /// Parse IfcAxis2Placement3D into transformation matrix
    pub(crate) fn parse_axis2_placement_3d(
        &self,
        placement: &DecodedEntity,
        decoder: &mut EntityDecoder,
    ) -> Result<Matrix4<f64>> {
        crate::transform::parse_axis2_placement_3d(placement, decoder)
    }

    /// Parse IfcDirection
    #[inline]
    pub(crate) fn parse_direction(&self, direction_entity: &DecodedEntity) -> Result<Vector3<f64>> {
        crate::transform::parse_direction(direction_entity)
    }
}
