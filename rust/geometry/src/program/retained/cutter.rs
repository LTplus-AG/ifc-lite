// SPDX-License-Identifier: MPL-2.0
//! Shared finite cutters. No product path admits these until its slice qualifies.
#![allow(dead_code)] // #7955: CUT-0 foundation consumed by M4/M5/M6.
use super::*;
use crate::document::{PrismLoop, PrismRole, PrismSegment, RetainedPrism, RetainedRefusal};
use nalgebra::{Matrix4, Vector3};
/// Construction padding, in metres and relative to the host diagonal; not a tolerance.
pub(in crate::program) const MARGIN_MIN_M: f64 = 0.01;
pub(in crate::program) const MARGIN_DIAGONAL: f64 = 0.05;
#[derive(Debug)]
pub(in crate::program) enum CutterError { Recipe(RetainedRefusal), Control(crate::Error) }
impl From<RetainedRefusal> for CutterError { fn from(error: RetainedRefusal) -> Self { Self::Recipe(error) } }
pub(in crate::program) enum CutterStep { Skip, Cutter(RetainedPlanOperation) }

pub(in crate::program) fn prism_operation(host: &LogicalRetainedValue, prism: RetainedPrism) -> crate::Result<RetainedPlanOperation> {
    host.validate_identity()?;
    proper_rigid(&host.world_from_evaluation())?;
    let payload = prism.lower().map_err(|error| crate::Error::geometry(error.to_string()))?;
    crate::resource::charge(crate::resource::Cost { work: 1, occurrences: 1,
        live_bytes: std::mem::size_of::<LogicalRetainedValue>() as u64, ..Default::default() })?.retain();
    let slot = next_slot(host.slot.program)?;
    let object_frame = frame::compose_frame(&host.object_frame, &prism.frame)?;
    // The derived recipe is already in metres: do not apply IFC unit scaling.
    let value = LogicalRetainedValue {
        definition: LogicalRetainedDefinition::Source { slot, source_epoch: host.contract.source_epoch,
            source_revision: host.contract.source_revision, source_id: prism.source_id },
        length_unit_scale: host.length_unit_scale, contract: host.contract, slot,
        source_from_evaluation: payload.source_from_evaluation, evaluation_from_source: payload.evaluation_from_source,
        object_frame, world_from_source: object_frame, bounds: payload.evaluation_bounds,
        placements: Vec::new(), presentation: Vec::new(), product_placed: false, outcome: outcome::new()?,
    };
    value.validate_identity()?;
    Ok(RetainedPlanOperation { opening: None, value, kind: RetainedOperationKind::Construction(RetainedRecipe::Prism(prism)) })
}
/// `source_id` is the halfspace's id, so the derived Source retains its attribution.
pub(in crate::program) fn halfspace_box(host: &LogicalRetainedValue, source_id: u32, p_e: [f64; 3], r_e: [f64; 3])
    -> Result<CutterStep, CutterError> {
    let Some(prism) = halfspace_prism(host, source_id, p_e, r_e)? else { return Ok(CutterStep::Skip); };
    prism_operation(host, prism).map(CutterStep::Cutter).map_err(CutterError::Control)
}
pub(super) fn halfspace_prism(host: &LogicalRetainedValue, source_id: u32, p_e: [f64; 3], r_e: [f64; 3])
    -> Result<Option<RetainedPrism>, CutterError> {
    let b = host.bounds.filter(|b| b.valid())
        .ok_or_else(|| RetainedRefusal::UnsupportedSource("unbounded_host".into()))?;
    let (p, r) = (Vector3::from(p_e), Vector3::from(r_e));
    if p.iter().chain(r.iter()).any(|v| !v.is_finite())
        || (r.norm() - 1.).abs() > crate::math::tol::RETAINED_RIGID_DOT_EPS {
        return Err(RetainedRefusal::InvalidSource("invalid cutter plane").into());
    }
    let corners = b.corners().map(Vector3::from);
    let h = corners.iter().map(|c| r.dot(&(c - p))).fold(f64::NEG_INFINITY, f64::max);
    if h <= 0. { return Ok(None); }
    let center = Vector3::from(std::array::from_fn::<_, 3, _>(|i| b.0[i] / 2. + b.0[i + 3] / 2.));
    let origin = center - r * r.dot(&(center - p));
    let (u, v) = plane_axes(r);
    let diagonal = Vector3::new(b.0[3] - b.0[0], b.0[4] - b.0[1], b.0[5] - b.0[2]).norm();
    let margin = MARGIN_MIN_M.max(MARGIN_DIAGONAL * diagonal);
    let mut low = [f64::INFINITY; 2]; let mut high = [f64::NEG_INFINITY; 2];
    for c in corners { for (i, a) in [u, v].iter().enumerate() {
        let coordinate = a.dot(&(c - origin)); low[i] = low[i].min(coordinate); high[i] = high[i].max(coordinate);
    } }
    for i in 0..2 { low[i] -= margin; high[i] += margin; }
    let vertices = [low, [high[0], low[1]], high, [low[0], high[1]]];
    let frame = Matrix4::from_columns(&[u.push(0.), v.push(0.), r.push(0.), origin.push(1.)]);
    let prism = RetainedPrism { source_id, role: PrismRole::HalfSpace,
        frame: crate::math::mat4::col_major_array(&frame), direction: [0., 0., 1.], depth: h + margin,
        loops: vec![PrismLoop { outer: true, segments: (0..4).map(|i| PrismSegment::Line {
            start: vertices[i], end: vertices[(i + 1) % 4] }).collect() }] };
    prism.lower()?;
    Ok(Some(prism))
}

/// CUT-0's deterministic plane basis, shared by plane and bounded cutters.
pub(in crate::program) fn plane_axes(r: Vector3<f64>) -> (Vector3<f64>, Vector3<f64>) {
    let k = (0..3).min_by(|&a, &b| r[a].abs().total_cmp(&r[b].abs())).unwrap();
    let mut axis = Vector3::zeros(); axis[k] = 1.;
    let u = r.cross(&axis).normalize();
    (u, r.cross(&u))
}

#[cfg(test)]
#[path = "cutter_tests.rs"]
mod tests;
