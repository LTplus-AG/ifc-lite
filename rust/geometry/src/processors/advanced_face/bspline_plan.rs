// SPDX-License-Identifier: MPL-2.0
//! Owned admitted control net and surface sampling parameters.
use super::bspline::tessellate_bspline_surface;
use super::bspline_budget::{MAX_BSPLINE_DEGREE, MAX_BSPLINE_SURFACE_SAMPLE_WORK};
use super::bspline_parse::{check_weights_match, parse_control_points, parse_knot_vectors};
use crate::{scale_segments, Error, Point3, Result, TessellationQuality};
use ifc_lite_core::{slot, DecodedEntity, EntityDecoder};
#[derive(Debug, Clone)]
pub(crate) struct BSplinePlan {
    u_degree: usize,
    v_degree: usize,
    control_points: Vec<Vec<Point3<f64>>>,
    u_knots: Vec<f64>,
    v_knots: Vec<f64>,
    weights: Option<Vec<Vec<f64>>>,
    u_segments: usize,
    v_segments: usize,
}
impl BSplinePlan {
    pub(crate) fn evaluate(self) -> Result<(Vec<f32>, Vec<u32>)> {
        let Self {
            u_degree,
            v_degree,
            control_points,
            u_knots,
            v_knots,
            weights,
            u_segments,
            v_segments,
        } = self;
        // Tessellate the surface (returns None if knot data is inconsistent)
        match tessellate_bspline_surface(
            u_degree,
            v_degree,
            &control_points,
            &u_knots,
            &v_knots,
            weights.as_deref(),
            u_segments,
            v_segments,
        ) {
            Some((positions, indices)) => Ok((positions, indices)),
            None => Ok((Vec::new(), Vec::new())),
        }
    }
}
pub(crate) fn lower_bspline(
    bspline: &DecodedEntity,
    decoder: &mut EntityDecoder,
    weights: Option<Vec<Vec<f64>>>,
    quality: TessellationQuality,
    rtc: (f64, f64, f64),
) -> Result<BSplinePlan> {
    // Get degrees
    let u_degree = bspline
        .attr(slot::IfcBSplineSurface::U_DEGREE)
        .and_then(|v| v.as_float())
        .unwrap_or(3.0) as usize;
    let v_degree = bspline
        .attr(slot::IfcBSplineSurface::V_DEGREE)
        .and_then(|v| v.as_float())
        .unwrap_or(1.0) as usize;

    // Reject a file-supplied degree far past any practical NURBS (#4901): the
    // Cox-de Boor evaluation is now memoized (`bspline_basis_table`), but a
    // huge degree still inflates its table (`O(degree * (n + degree))`) and
    // the per-sample weighted sum, and nothing legitimate needs it. This
    // fails LOUDLY (via `GeometryRouter::record_unsupported_item`, through
    // the `Err` propagated to the caller) instead of silently degrading the
    // surface, and it is a deterministic COUNT bound, not a timer, so native
    // and wasm reject the same file identically.
    if u_degree > MAX_BSPLINE_DEGREE || v_degree > MAX_BSPLINE_DEGREE {
        return Err(Error::geometry(format!(
            "BSplineSurface degree ({u_degree}, {v_degree}) exceeds the {MAX_BSPLINE_DEGREE} bound (#4901)"
        )));
    }

    // Read the control-point grid's dimensions from the RAW attribute list —
    // no `CartesianPoint` is resolved or decoded (#4901). Checking the
    // work bound against THESE, before calling `parse_control_points`,
    // means a hostile file with millions of point references is rejected
    // before paying for the decode, not after (a bound enforced only once
    // everything is already parsed and allocated is not a bound at all).
    let (raw_n_u, raw_n_v_max) = super::bspline_parse::control_point_grid_dims(bspline);
    let raw_n_v_first = bspline
        .attr(slot::IfcBSplineSurface::CONTROL_POINTS_LIST)
        .and_then(|a| a.as_list())
        .and_then(|rows| rows.first())
        .and_then(|row| row.as_list())
        .map(<[_]>::len)
        .unwrap_or(0);

    // Determine tessellation resolution based on surface complexity; scaled by quality.
    let u_segments = scale_segments(raw_n_u * 3, 8, 24, quality);
    let v_segments = if raw_n_u > 0 {
        scale_segments(raw_n_v_first * 3, 4, 24, quality)
    } else {
        scale_segments(4, 4, 24, quality)
    };

    // Bound the actual cost driver (#4901): NOT the raw control-point count
    // (a real fixture legitimately carries a 207x180 = 37,260-point patch,
    // see bspline_budget.rs) but a conservative upper bound on total work.
    // #5321 reuses axis tables and skips zero-support terms; retain the dense
    // estimate so the optimization does not change which inputs are admitted:
    // - the weighted-sum loop (`evaluate_bspline_surface`), `samples * n_u * n_v`;
    // - PLUS the per-axis basis-table build (`bspline_basis_table`), which
    //   depends on `n_u` and `n_v` INDEPENDENTLY of each other and of their
    //   product — a grid of many near-empty rows (`n_u` huge, `n_v` tiny)
    //   makes the weighted-sum term small while the U-axis table build alone
    //   is still `O(degree * n_u)` per sample point. Omitting this term let a
    //   ragged/empty-row grid slip past the bound entirely (caught in review).
    let samples = (u_segments as u64 + 1).saturating_mul(v_segments as u64 + 1);
    let n_u = raw_n_u as u64;
    let n_v = raw_n_v_max as u64;
    let deg_u = u_degree as u64;
    let deg_v = v_degree as u64;
    let weighted_sum_work = n_u.saturating_mul(n_v);
    let table_build_work = deg_u
        .saturating_mul(n_u.saturating_add(deg_u))
        .saturating_add(deg_v.saturating_mul(n_v.saturating_add(deg_v)));
    let estimated_work = samples.saturating_mul(weighted_sum_work.saturating_add(table_build_work));
    if estimated_work > MAX_BSPLINE_SURFACE_SAMPLE_WORK {
        return Err(Error::geometry(format!(
            "BSplineSurface sampling work ({estimated_work} = {samples} samples * \
             ({n_u}x{n_v} control points + degree-{u_degree}/{v_degree} basis tables)) \
             exceeds the {MAX_BSPLINE_SURFACE_SAMPLE_WORK} bound (#4901)"
        )));
    }

    // Parse control points (only now — the work bound above already passed
    // on the raw, undecoded grid dimensions).
    let mut control_points = parse_control_points(bspline, decoder)?;
    // Rebase the control net, not the samples (#5698): a B-spline is affine
    // invariant, and evaluating at national-grid magnitude would amplify the
    // basis' partition-of-unity rounding into micrometres. Exact for zero.
    for point in control_points.iter_mut().flatten() {
        point.x -= rtc.0;
        point.y -= rtc.1;
        point.z -= rtc.2;
    }

    if let Some(weights) = weights.as_deref() {
        check_weights_match(weights, &control_points)?;
    }

    // Parse knot vectors
    let (u_knots, v_knots) = parse_knot_vectors(bspline)?;

    Ok(BSplinePlan {
        u_degree,
        v_degree,
        control_points,
        u_knots,
        v_knots,
        weights,
        u_segments,
        v_segments,
    })
}
