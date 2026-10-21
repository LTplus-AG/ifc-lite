// SPDX-License-Identifier: MPL-2.0
//! Rational swept-disk request encoding. The source recipe is never modified;
//! this module grants no execution qualification.
//!
//! Supported family: a solid `IfcSweptDiskSolid` (no `InnerRadius`) whose
//! directrix is one open rational B-spline (optionally parameter-trimmed), one
//! line, or one partial circular arc. Lines and arcs are converted to their
//! exact rational form (degree 1, or quadratic conics of at most a quarter
//! turn each); nothing is fitted or sampled. Hollow disks, full circles,
//! polylines with more than one segment and composite directrices are refused:
//! their joints and seams need an additional qualified route.
//!
//! Wire format 2 (little-endian, evaluation frame in metres):
//! - header: `u32` format = 2, loop count = 1, segment count = 1, reserved 0;
//!   then `f64` radius and inner radius (always 0).
//! - curve: `u32` kind = 4 (rational B-spline), reserved 0, degree, control
//!   count, unique knot count, reserved 0; then `f64` active parameter start
//!   and end.
//! - per control point: `f64` x, y, z (relative to the first control point)
//!   and weight. Points are Euclidean, not weight-multiplied.
//! - per unique knot: `f64` knot, `u32` multiplicity, reserved `u32` 0.
//!
//! Rational directrices keep their original knots, weights and active range.
//! A converted line or arc uses a derived parameter (`0..1` per line, `0..n`
//! for `n` conic spans); the source keeps its authored circle, angles, trims
//! and line magnitude unchanged.

use super::retained_sweep::{array, RegionQualification, SweepPayload, MAX_LOCAL_M, MAX_SEGMENTS};
use super::RetainedRefusal;
use crate::analytic::{
    AnalyticCurveSegment, AnalyticStatus, AnalyticSweptDisk, OwnedDirectrix, OwnedRationalCurve,
};
use crate::math::tol;
use nalgebra::{Matrix4, Vector3};
use std::f64::consts::{FRAC_PI_2, TAU};

/// Wire kind of a rational B-spline curve (formats 1 use kinds 1 to 3).
const RATIONAL_CURVE: u32 = 4;
const MAX_DEGREE: u32 = 32;

/// One authored `IfcSweptDiskSolid`, extracted inside
/// [`crate::analytic::with_source_capture`] so its original records and owned
/// directrix survive. Coefficients stay in raw IFC file length units.
#[derive(Debug, Clone, PartialEq)]
pub struct RetainedSweptDisk {
    /// STEP id of the `IfcSweptDiskSolid`; must be the captured source root.
    pub solid_id: u32,
    pub source: AnalyticSweptDisk,
    /// Raw IFC file length unit -> metres.
    pub length_unit_scale: f64,
}

pub(super) fn lower(recipe: &RetainedSweptDisk) -> Result<SweepPayload, RetainedRefusal> {
    let disk = &recipe.source;
    let original = disk
        .source
        .as_ref()
        .ok_or(RetainedRefusal::SourceNotCaptured)?;
    if let AnalyticStatus::Unsupported(reason) = &original.capture_status {
        return Err(RetainedRefusal::UnsupportedSource(format!(
            "original disk capture: {reason}"
        )));
    }
    if original.root_entity_id != recipe.solid_id
        || !original.records.contains_key(&recipe.solid_id)
    {
        return invalid("invalid original solid metadata");
    }
    if disk.inner_radius.is_some() {
        return Err(RetainedRefusal::UnsupportedSource(
            "hollow swept disks are not supported by this request encoding".into(),
        ));
    }
    let units = recipe.length_unit_scale;
    let radius = disk.radius * units;
    if !units.is_finite() || units <= 0.0 {
        return invalid("invalid source length units");
    }
    if !radius.is_finite() || radius <= tol::RETAINED_MIN_LENGTH_M || radius > MAX_LOCAL_M {
        return invalid("disk radius outside local numerical domain");
    }
    let path = match &disk.owned_directrix {
        Some(OwnedDirectrix::Rational(path)) => path.clone(),
        Some(OwnedDirectrix::Segments(segments)) => exact_path(segments, disk.directrix_id)?,
        None => {
            // A rational directrix the capture could not own keeps the
            // extractor's reason; otherwise there is no exact route at all.
            return Err(RetainedRefusal::UnsupportedSource(match &disk.status {
                AnalyticStatus::Unsupported(reason) => reason.clone(),
                AnalyticStatus::Complete => "directrix has no exact coefficient route".into(),
            }));
        }
    };
    validate(&path)?;
    let anchor = path.control_points[0];
    // Bounded by MAX_SEGMENTS in `validate`, so the counts fit in u32.
    let (controls, knots) = (path.control_points.len(), path.knots.len());
    let mut bytes = Vec::with_capacity(72 + controls * 32 + knots * 16);
    for value in [2u32, 1, 1, 0] {
        bytes.extend(value.to_le_bytes());
    }
    for value in [radius, 0.0] {
        scalar(&mut bytes, value)?;
    }
    for value in [
        RATIONAL_CURVE,
        0,
        path.degree,
        controls as u32,
        knots as u32,
        0,
    ] {
        bytes.extend(value.to_le_bytes());
    }
    for value in path.parameter_range {
        scalar(&mut bytes, value)?;
    }
    for (point, weight) in path.control_points.iter().zip(&path.weights) {
        for axis in 0..3 {
            scalar(&mut bytes, (point[axis] - anchor[axis]) * units)?;
        }
        scalar(&mut bytes, *weight)?;
    }
    for (knot, multiplicity) in path.knots.iter().zip(&path.multiplicities) {
        scalar(&mut bytes, *knot)?;
        bytes.extend(multiplicity.to_le_bytes());
        bytes.extend(0u32.to_le_bytes());
    }
    // The disk has no Position: solid-local coordinates are directrix
    // coordinates. Survey-scale anchors stay here in f64, outside the worker.
    let source_from_evaluation =
        Matrix4::new_translation(&Vector3::from(anchor)) * Matrix4::new_scaling(1.0 / units);
    let evaluation_from_source =
        Matrix4::new_scaling(units) * Matrix4::new_translation(&-Vector3::from(anchor));
    if source_from_evaluation
        .iter()
        .chain(evaluation_from_source.iter())
        .any(|v| !v.is_finite())
    {
        return invalid("disk evaluation frame overflows");
    }
    Ok(SweepPayload {
        format: 2,
        bytes,
        segments: 1,
        loops: 1,
        qualification: RegionQualification::RationalDisk,
        source_from_evaluation: array(source_from_evaluation),
        evaluation_from_source: array(evaluation_from_source),
    })
}

/// Recipe fields are public, so the owned curve is re-checked here.
fn validate(path: &OwnedRationalCurve) -> Result<(), RetainedRefusal> {
    let count = path.control_points.len();
    let degree = path.degree as usize;
    if !(1..=MAX_DEGREE).contains(&path.degree)
        || count <= degree
        || count > MAX_SEGMENTS
        || path.weights.len() != count
        || path.knots.len() < 2
        || path.knots.len() > MAX_SEGMENTS
        || path.multiplicities.len() != path.knots.len()
        || path.control_points.iter().flatten().any(|v| !v.is_finite())
        || path.weights.iter().any(|w| !w.is_finite() || *w <= 0.0)
        || path.knots.iter().any(|k| !k.is_finite())
        || path.knots.windows(2).any(|pair| pair[0] >= pair[1])
    {
        return invalid("invalid exact rational coefficients");
    }
    let mut total = 0usize;
    for (index, &multiplicity) in path.multiplicities.iter().enumerate() {
        let clamped_end = index == 0 || index + 1 == path.knots.len();
        let multiplicity = multiplicity as usize;
        if (clamped_end && multiplicity != degree + 1)
            || (!clamped_end && (multiplicity == 0 || multiplicity > degree))
        {
            return invalid("unsupported rational knot multiplicities");
        }
        total += multiplicity;
    }
    let [start, end] = path.parameter_range;
    let (first, last) = (path.knots[0], path.knots[path.knots.len() - 1]);
    if total != count + degree + 1
        || start.is_nan()
        || end.is_nan()
        || start >= end
        || start < first
        || end > last
    {
        return invalid("invalid rational active domain");
    }
    Ok(())
}

/// Exact rational form of a single line or partial arc. This is DERIVED
/// evaluation data; the recipe keeps the authored segment unchanged.
fn exact_path(
    segments: &[AnalyticCurveSegment],
    source_entity_id: u32,
) -> Result<OwnedRationalCurve, RetainedRefusal> {
    let (degree, control_points, weights, knots, multiplicities) = match segments {
        [AnalyticCurveSegment::Line { start, end }] => (
            1,
            vec![*start, *end],
            vec![1.0, 1.0],
            vec![0.0, 1.0],
            vec![2, 2],
        ),
        [AnalyticCurveSegment::Arc {
            center,
            normal,
            x_axis,
            radius,
            start_angle,
            sweep_angle,
        }] => {
            let (n, x) = (Vector3::from(*normal), Vector3::from(*x_axis));
            if (n.norm() - 1.0).abs() >= tol::RETAINED_CIRCLE_BASIS_EPS
                || (x.norm() - 1.0).abs() >= tol::RETAINED_CIRCLE_BASIS_EPS
                || n.dot(&x).abs() >= tol::RETAINED_CIRCLE_BASIS_EPS
                || !radius.is_finite()
                || *radius <= 0.0
                || !start_angle.is_finite()
            {
                return invalid("invalid circular directrix basis");
            }
            let sweep = sweep_angle.abs();
            if sweep.is_nan()
                || sweep <= tol::RETAINED_ARC_INTERVAL_EPS_RAD
                || sweep >= TAU - tol::RETAINED_ARC_INTERVAL_EPS_RAD
            {
                return Err(RetainedRefusal::UnsupportedSource(
                    "closed circular directrix requires an additional qualified route".into(),
                ));
            }
            arc(
                Vector3::from(*center),
                n,
                x,
                *radius,
                *start_angle,
                *sweep_angle,
            )
        }
        _ => {
            return Err(RetainedRefusal::UnsupportedSource(
                "multi-segment disk directrix requires an additional qualified route".into(),
            ))
        }
    };
    let end = knots[knots.len() - 1];
    Ok(OwnedRationalCurve {
        source_entity_id,
        degree,
        control_points,
        weights,
        knots,
        multiplicities,
        expanded_knots: Vec::new(),
        parameter_range: [0.0, end],
    })
}

type RationalParts = (u32, Vec<[f64; 3]>, Vec<f64>, Vec<f64>, Vec<u32>);

/// Quadratic rational conic spans of at most a quarter turn: span ends on the
/// circle with weight 1, the middle control at `radius / cos(delta / 2)` with
/// weight `cos(delta / 2)`.
fn arc(
    center: Vector3<f64>,
    normal: Vector3<f64>,
    x_axis: Vector3<f64>,
    radius: f64,
    start: f64,
    sweep: f64,
) -> RationalParts {
    let y_axis = normal.cross(&x_axis);
    let point = |angle: f64, distance: f64| -> [f64; 3] {
        (center + (x_axis * angle.cos() + y_axis * angle.sin()) * distance).into()
    };
    // `sweep` is finite and below one turn, so at most four spans.
    let spans = (sweep.abs() / FRAC_PI_2).ceil().max(1.0) as usize;
    let delta = sweep / spans as f64;
    let weight = (delta / 2.0).cos();
    let mut controls = vec![point(start, radius)];
    let mut weights = vec![1.0];
    for span in 0..spans {
        let base = start + delta * span as f64;
        controls.push(point(base + delta / 2.0, radius / weight));
        weights.push(weight);
        controls.push(point(base + delta, radius));
        weights.push(1.0);
    }
    let knots = (0..=spans).map(|i| i as f64).collect();
    let multiplicities = (0..=spans)
        .map(|i| if i == 0 || i == spans { 3 } else { 2 })
        .collect();
    (2, controls, weights, knots, multiplicities)
}

fn scalar(bytes: &mut Vec<u8>, value: f64) -> Result<(), RetainedRefusal> {
    if !value.is_finite() || value.abs() > MAX_LOCAL_M {
        return invalid("disk coefficient outside local numerical domain");
    }
    bytes.extend(value.to_le_bytes());
    Ok(())
}

fn invalid<T>(message: &'static str) -> Result<T, RetainedRefusal> {
    Err(RetainedRefusal::InvalidSource(message))
}

#[cfg(test)]
#[path = "retained_disk_tests.rs"]
mod tests;
