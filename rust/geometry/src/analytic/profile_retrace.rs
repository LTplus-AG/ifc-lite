// SPDX-License-Identifier: MPL-2.0
//! Retained-only nonzero-winding interpretation of exact, adjacent retraces.
use super::{walk_error::WalkError, AnalyticCurveSegment, AnalyticProfileLoop};
use crate::kernel::{predicates::orient2d, DropAxis, ImplicitPoint, Sign};
use std::cell::Cell;

thread_local! { static ADMITTED: Cell<bool> = const { Cell::new(false) }; }

pub(super) fn admitting<T>(f: impl FnOnce() -> T) -> T {
    struct Restore(bool);
    impl Drop for Restore {
        fn drop(&mut self) { ADMITTED.with(|flag| flag.set(self.0)); }
    }
    let _restore = Restore(ADMITTED.with(|flag| flag.replace(true)));
    f()
}
pub(super) fn admitted() -> bool { ADMITTED.with(Cell::get) }

pub(super) fn line_curve(curve: &ifc_lite_core::DecodedEntity) -> bool {
    match curve.ifc_type {
        ifc_lite_core::IfcType::IfcPolyline => true,
        ifc_lite_core::IfcType::IfcIndexedPolyCurve => curve.get(1)
            .and_then(|v| v.as_list()).is_some_and(|segments| !segments.is_empty() && segments.iter().all(|v|
                matches!(v, ifc_lite_core::AttributeValue::Typed { name, .. } if name.as_ref() == "IFCLINEINDEX"))),
        _ => false,
    }
}

fn collinear(a: [f64; 3], b: [f64; 3], c: [f64; 3]) -> bool {
    orient2d(&ImplicitPoint::Explicit(a), &ImplicitPoint::Explicit(b),
        &ImplicitPoint::Explicit(c), DropAxis::Z) == Sign::Zero
}

pub(super) fn cancel(boundary: &AnalyticProfileLoop) -> Result<Option<Vec<AnalyticCurveSegment>>, WalkError> {
    cancel_segments(&boundary.segments, |_| {})
}

fn cancel_segments(segments: &[AnalyticCurveSegment], mut removed: impl FnMut(usize)) -> Result<Option<Vec<AnalyticCurveSegment>>, WalkError> {
    let mut points = Vec::new();
    let _points_storage = crate::resource::reserve_headers(&mut points, segments.len()).map_err(WalkError::Stopped)?;
    for (i, segment) in segments.iter().enumerate() {
        let AnalyticCurveSegment::Line { start, end } = segment else { return Ok(None) };
        // Never turn a tolerated join/gap into an interpolated source vertex.
        let AnalyticCurveSegment::Line { start: next, .. } = &segments[(i + 1) % segments.len()] else { return Ok(None) };
        if end != next || start.iter().any(|v| !v.is_finite()) { return Ok(None); }
        points.push(*start);
    }
    let original_len = points.len();
    // Each successful pass removes a vertex; at most n passes of at most n
    // predicates. source_step preserves the enclosing ProductBudget stop.
    while points.len() >= 3 {
        let mut found = None;
        for i in 0..points.len() {
            crate::resource::source_step()?;
            let a = points[(i + points.len() - 1) % points.len()];
            let b = points[i];
            let c = points[(i + 1) % points.len()];
            if !collinear(a, b, c) { continue; }
            let axis = usize::from((a[1] - b[1]).abs() > (a[0] - b[0]).abs());
            // Coordinate comparisons, not a rounded dot product or tolerance.
            if (a[axis] < b[axis] && c[axis] < b[axis])
                || (a[axis] > b[axis] && c[axis] > b[axis]) {
                found = Some((i, a == c));
                break;
            }
        }
        let Some((i, equal)) = found else { break };
        points.remove(i); removed(i);
        if equal { let next = i % points.len(); points.remove(next); removed(next); }
    }
    if points.len() < 3 || points.len() == original_len { return Ok(None); }
    let mut segments = Vec::new();
    crate::resource::reserve_headers(&mut segments, points.len()).map_err(WalkError::Stopped)?.retain();
    segments.extend((0..points.len()).map(|i| AnalyticCurveSegment::Line {
        start: points[i], end: points[(i + 1) % points.len()],
    }));
    Ok(Some(segments))
}

/// Harness report of removed authored vertex indices (before revalidation).
/// Call outside an active ProductBudget; a budget stop is a failed report.
#[cfg(feature = "test-support")]
#[doc(hidden)]
pub fn retrace_cancellations(segments: &[AnalyticCurveSegment]) -> Vec<usize> {
    let mut indices: Vec<_> = (0..segments.len()).collect();
    let mut cancelled = Vec::new();
    let _ = cancel_segments(segments, |i| cancelled.push(indices.remove(i)))
        .expect("retrace report interrupted by product budget");
    cancelled
}

pub(super) fn repair(
    boundary: &AnalyticProfileLoop, clearance: f64, join: f64,
    rebuild: impl FnOnce(Vec<AnalyticCurveSegment>) -> Result<AnalyticProfileLoop, WalkError>,
) -> Result<Option<AnalyticProfileLoop>, WalkError> {
    let Some(segments) = cancel(boundary)? else { return Ok(None) };
    let residual = match rebuild(segments) {
        Ok(value) => value,
        Err(WalkError::Unsupported(_)) => return Ok(None),
        Err(stop @ WalkError::Stopped(_)) => return Err(stop),
    };
    // Preregistered sanity check only: collinearity above is always exact.
    if (residual.signed_area - boundary.signed_area).abs() > 1e-12 * boundary.signed_area.abs() {
        return Ok(None);
    }
    match super::profile_topology::validate(std::slice::from_ref(&residual), clearance, join) {
        Ok(()) => {},
        Err(WalkError::Unsupported(_)) => return Ok(None),
        Err(stop @ WalkError::Stopped(_)) => return Err(stop),
    }
    Ok(Some(residual))
}

#[cfg(test)]
#[path = "profile_retrace_tests.rs"]
mod tests;
