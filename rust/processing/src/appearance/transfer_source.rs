// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//! One registered capture behind the shared atlas sampler: a textured mesh
//! answers with UVs into its image, an RGB point cloud answers with a colour.
use super::{
    transfer_budget::TransferBudget,
    transfer_math::Point,
    transfer_occlusion::Occluder,
    transfer_points::PointSurface,
    transfer_surface::{Observation, Surface},
    transfer_target::TargetTriangle,
    transfer_types::*,
};

pub(super) enum Sample {
    Uv([f64; 2]),
    Rgba([f64; 4]),
}
pub(super) enum ScanSource {
    Mesh(Surface),
    Points(Box<PointSurface>, Option<Occluder>),
}
impl ScanSource {
    pub fn new(
        request: &MeshTransferRequest,
        payload: Option<&TransferPointPayload<'_>>,
        frame: &TransferFrame,
        budget: &mut TransferBudget,
    ) -> Result<Self, String> {
        match (&request.source, payload) {
            (TransferSource::Mesh(_), None) => Ok(Self::Mesh(Surface::new(request, frame, budget)?)),
            (TransferSource::Points(spec), Some(points)) => {
                Ok(Self::Points(Box::new(PointSurface::new(request, spec, points, frame, budget)?), None))
            }
            (TransferSource::Mesh(_), Some(_)) => Err("Transfer mesh source must not carry a point payload".into()),
            (TransferSource::Points(_), None) => Err("Transfer point source needs its binary point payload".into()),
        }
    }
    pub fn summary(request: &MeshTransferRequest) -> TransferSourceSummary {
        match &request.source {
            TransferSource::Mesh(_) => TransferSourceSummary { kind: "mesh".into(), orientation: None, point_count: None },
            TransferSource::Points(spec) => TransferSourceSummary {
                kind: "points".into(),
                orientation: Some(spec.orientation),
                point_count: Some(spec.point_count),
            },
        }
    }
    /// Point sources refuse captures beyond the current item's other faces.
    pub fn begin_item(&mut self, targets: &[TargetTriangle], budget: &mut TransferBudget) -> Result<(), String> {
        if let Self::Points(_, occluder) = self {
            *occluder = Some(Occluder::new(targets, budget)?);
        }
        Ok(())
    }
    pub fn observe(
        &mut self,
        point: Point,
        target_normal: Point,
        budget: &mut TransferBudget,
    ) -> Result<(Observation, Sample), String> {
        match self {
            Self::Mesh(surface) => {
                let (observation, uv) = surface.observe(point, target_normal, budget)?;
                Ok((observation, Sample::Uv(uv)))
            }
            Self::Points(surface, occluder) => {
                let occluder = occluder.as_mut().ok_or("Transfer point observation outside an item")?;
                let (observation, rgba) = surface.observe(point, target_normal, occluder, budget)?;
                Ok((observation, Sample::Rgba(rgba)))
            }
        }
    }
}
