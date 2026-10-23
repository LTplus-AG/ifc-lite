// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Owned inputs of an `IfcPolygonalBoundedHalfSpace` cutter prism: the
//! preflight half. Everything that touches the decoder (Position, boundary
//! curve, the boundary vertex cap and its record) is read here, in the
//! original order; the prism numerics consume the plan afterwards.

use super::BooleanClippingProcessor;
use crate::placement::Axis2Placement;
use crate::{Error, Point2, Point3, Result, TessellationQuality, Vector3};
use ifc_lite_core::{slot, DecodedEntity, EntityDecoder};

/// The boundary contour in Position's XY plane and Position's frame.
#[derive(Debug, Clone)]
pub(crate) struct BoundedPrismPlan {
    pub(super) contour: Vec<Point2<f64>>,
    pub(super) origin: Point3<f64>,
    pub(super) x_axis: Vector3<f64>,
    pub(super) y_axis: Vector3<f64>,
    /// Position's Z-axis: the boundary is extruded along it.
    pub(super) z_axis: Vector3<f64>,
}

impl BoundedPrismPlan {
    /// `Ok(None)`: the boundary is over the vertex cap; the refusal is already
    /// on record and the caller leaves the host uncut (#7786).
    pub(crate) fn lower(
        processor: &BooleanClippingProcessor,
        half_space: &DecodedEntity,
        decoder: &mut EntityDecoder,
        quality: TessellationQuality,
    ) -> Result<Option<Self>> {
        let position_attr = half_space
            .get(slot::IfcPolygonalBoundedHalfSpace::POSITION.index())
            .ok_or_else(|| {
                Error::geometry("PolygonalBoundedHalfSpace missing Position".to_string())
            })?;
        let position = decoder.resolve_ref(position_attr)?.ok_or_else(|| {
            Error::geometry("Failed to resolve bounded half-space Position".to_string())
        })?;
        let transform = Axis2Placement::read_3d(&position, decoder)?.matrix();

        let Some(contour) = processor.bounded_half_space_contour(half_space, decoder, quality)?
        else {
            return Ok(None);
        };

        let origin = Point3::new(transform[(0, 3)], transform[(1, 3)], transform[(2, 3)]);
        let x_axis =
            Vector3::new(transform[(0, 0)], transform[(1, 0)], transform[(2, 0)]).normalize();
        let y_axis =
            Vector3::new(transform[(0, 1)], transform[(1, 1)], transform[(2, 1)]).normalize();
        // Per IFC spec (IfcPolygonalBoundedHalfSpace): the polygon is in
        // Position's XY plane and is extruded INFINITELY along Position's
        // Z-axis to form an unbounded prism.
        let z_axis =
            Vector3::new(transform[(0, 2)], transform[(1, 2)], transform[(2, 2)]).normalize();

        Ok(Some(Self {
            contour,
            origin,
            x_axis,
            y_axis,
            z_axis,
        }))
    }
}
