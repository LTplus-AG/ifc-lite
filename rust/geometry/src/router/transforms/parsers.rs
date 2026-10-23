// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Leaf IFC primitive placement parsers: axis placements and directions.
//! These are one-line delegates to the canonical readers
//! ([`crate::placement::Axis2Placement`], `EntityDecoder::direction3_of`), kept
//! `pub(crate)` until C2 moves `router/voids/probe.rs` off them. The
//! `IfcCartesianTransformationOperator` lives in `operator.rs` and the
//! `IfcMappedItem` target/origin composition in `mapped.rs`.

use super::super::GeometryRouter;
use crate::placement::Axis2Placement;
use crate::{Error, Result, Vector3};
use ifc_lite_core::{DecodedEntity, EntityDecoder};
use nalgebra::Matrix4;

impl GeometryRouter {
    /// Parse IfcAxis2Placement3D into transformation matrix
    pub(crate) fn parse_axis2_placement_3d(
        &self,
        placement: &DecodedEntity,
        decoder: &mut EntityDecoder,
    ) -> Result<Matrix4<f64>> {
        Ok(Axis2Placement::read_3d(placement, decoder)?.matrix())
    }

    /// Parse IfcDirection under the leaf rule (2 or 3 finite ratios, raw).
    /// A malformed one is an error, which the void probe's `.ok()` turns into
    /// a deferral to the exact kernel.
    #[inline]
    pub(crate) fn parse_direction(&self, direction_entity: &DecodedEntity) -> Result<Vector3<f64>> {
        EntityDecoder::direction3_of(direction_entity)
            .map(Vector3::from)
            .ok_or_else(|| Error::geometry(format!("#{} is not a readable IfcDirection", direction_entity.id)))
    }
}
