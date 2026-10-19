// SPDX-License-Identifier: MPL-2.0
//! Shared numerical lineage and f64 frame admission, without model authority.
use ifc_lite_geometry::document::{BooleanOperation, RetainedRequest};
use std::sync::Arc;

/// Source lineage is separate from temporary SDK face indices and display data.
/// This tree records evaluated operations, not complete representation coverage.
#[derive(Debug, Clone)]
pub enum RetainedLineage {
    /// A realization's raw authored source and its actual evaluation domain.
    Definition { request: Box<RetainedRequest>, source_from_evaluation: [f64;16], evaluation_from_source: [f64;16] },
    /// Actual unary numerical operation in the unchanged selected metre frame.
    PlaneClip { input: Arc<Self>, plane: [f64;6], side: crate::PlaneSide, mode: crate::PlaneClipMode,
        world_from_evaluation: [f64;16], certificate: Arc<crate::PlaneCertificate> },
    AffineCopy { input: Arc<Self>, column_major: [f64;16], certificate: crate::AffineCertificate },
    /// Explicit post-bake placement; never inferred from authored units or RTC.
    Placed { value: Arc<Self>, world_from_evaluation: [f64;16] },
    Source { request: Box<RetainedRequest>, world_from_source: [f64; 16] },
    Boolean { operation: BooleanOperation, left: Arc<Self>, right: Arc<Self> },
}

pub(crate) fn multiply(a: [f64; 16], b: [f64; 16]) -> [f64; 16] {
    std::array::from_fn(|i| (0..4).map(|k| a[k * 4 + i % 4] * b[i / 4 * 4 + k]).sum())
}
pub(crate) fn rigid(m: [f64; 16]) -> Result<(), &'static str> {
    let valid = m.iter().all(|v| v.is_finite()) && m[3] == 0. && m[7] == 0. && m[11] == 0. && m[15] == 1.
        && (0..3).all(|i| (0..3).all(|j| {
            let dot: f64 = (0..3).map(|k| m[i*4+k]*m[j*4+k]).sum();
            (dot - if i == j { 1. } else { 0. }).abs() <= 1e-12
        }));
    let cross = [m[1]*m[6]-m[2]*m[5], m[2]*m[4]-m[0]*m[6], m[0]*m[5]-m[1]*m[4]];
    if valid && (0..3).all(|i| (cross[i] - m[8+i]).abs() <= 1e-12) { Ok(()) }
    else { Err("retained dependency requires proper rigid metre frame") }
}
pub(crate) fn relative(a: [f64; 16], b: [f64; 16]) -> Result<[f64; 16], &'static str> {
    rigid(a)?; rigid(b)?;
    let mut out = [0.; 16]; out[15] = 1.;
    for col in 0..3 { for row in 0..3 {
        out[col*4+row] = (0..3).map(|k| a[row*4+k]*b[col*4+k]).sum();
    }}
    for row in 0..3 { out[12+row] = (0..3).map(|k| a[row*4+k]*(b[12+k]-a[12+k])).sum(); }
    rigid(out)?;
    Ok(out)
}

/// Classification sealed by the runtime from the actual numerical solid and
/// consistent strict mesh metadata. This value alone grants no result authority.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NumericalOutcome { NonEmpty, Empty }
