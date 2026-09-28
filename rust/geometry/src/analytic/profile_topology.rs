// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Conservative material-region validation for #6316. Every accepted pair is
//! separated by analytic interval enclosures or an adjacent-junction plane.
//! Failure to establish separation is unsupported, never a successful scan.

use super::{AnalyticProfileLoop, AnalyticCurveSegment};
use super::topology_interval::{self as iv, Box2, Curve};

const MAX_WORK: usize = 1_000_000;
const MAX_REFINEMENT: u8 = 48;

struct Budget(usize);
impl Budget {
    fn spend(&mut self) -> Result<(), String> {
        self.0 = self.0.checked_sub(1)
            .ok_or("profile topology validation exceeded work budget")?;
        Ok(())
    }
}

pub(super) fn validate(loops: &[AnalyticProfileLoop], clearance: f64, join_precision: f64) -> Result<(), String> {
    validate_bounded(loops, clearance, join_precision, MAX_WORK)
}

fn validate_bounded(loops: &[AnalyticProfileLoop], precision: f64, join_precision: f64, work: usize) -> Result<(), String> {
    if !precision.is_finite() || precision < 0.0 || !join_precision.is_finite() || join_precision < 0.0 {
        return Err("invalid profile topology precision".into());
    }
    let outer = loops.first().ok_or("profile topology: no outer boundary")?;
    let first = outer.segments.first().ok_or("profile topology: empty outer boundary")?;
    let origin = match first {
        AnalyticCurveSegment::Line { start, .. } => [start[0], start[1]],
        AnalyticCurveSegment::Arc { center, .. } => [center[0], center[1]],
    };
    let mut budget = Budget(work);
    let curves: Vec<Vec<_>> = loops.iter().map(|boundary| boundary.segments.iter()
        .map(|segment| Curve::new(segment, origin)).collect::<Result<_, _>>())
        .collect::<Result<_, _>>()?;
    for (i, boundary) in curves.iter().enumerate() {
        // No material region may collapse at the declared resolution. This
        // conservative area/perimeter screen also catches thin two-/three-
        // segment loops, whose every primitive pair is adjacent.
        if iv::point(loops[i].signed_area.abs()).lo <= iv::point(precision)
            .mul(iv::point(loops[i].perimeter)).hi {
            return Err(format!("loop {i}: enclosed region is unresolved at context Precision"));
        }
        if boundary.len() == 1 && !matches!(boundary[0].segment,
            AnalyticCurveSegment::Arc { sweep_angle, radius, .. }
            if sweep_angle.abs() == std::f64::consts::TAU && *radius > precision)
        {
            return Err(format!("loop {i}: one-segment boundary is not a resolved full circle"));
        }
        for (j, a) in boundary.iter().enumerate() {
            if !a.resolved_at(precision)? {
                return Err(format!("loop {i}, segment {j}: endpoints or radius collapse at context Precision"));
            }
            for (k, b) in boundary.iter().enumerate().skip(j + 1) {
                budget.spend()?;
                let mut joins = Vec::with_capacity(2);
                if k == j + 1 { joins.push((1.0, 0.0)); }
                if j == 0 && k + 1 == boundary.len() { joins.push((0.0, 1.0)); }
                separate(a, b, &joins, precision, join_precision, &mut budget)
                    .map_err(|reason| format!("loop {i}, segments {j}/{k}: {reason}"))?;
            }
        }
        for (other_index, other) in curves.iter().enumerate().take(i) {
            for a in boundary { for b in other {
                budget.spend()?;
                separate(a, b, &[], precision, join_precision, &mut budget)
                    .map_err(|reason| format!("loops {other_index}/{i}: {reason}"))?;
            }}
        }
    }
    // Jordan separation: only after simple, pairwise disjoint boundaries
    // have been established does one boundary point decide containment.
    for i in 1..curves.len() {
        let query = curves[i][0].at(0.0)?;
        if !contains(&curves[0], query, &mut budget)? {
            return Err(format!("InnerCurves loop {i} is outside OuterCurve"));
        }
        for j in 1..i {
            if contains(&curves[j], query, &mut budget)?
                || contains(&curves[i], curves[j][0].at(0.0)?, &mut budget)? {
                return Err(format!("InnerCurves loops {j}/{i} are nested"));
            }
        }
    }
    Ok(())
}

/// Adjacent boundaries may meet at their designated endpoint, but may not
/// double back, overlap, or cross elsewhere. A plane through that join with
/// strictly opposite outgoing derivatives establishes local injectivity.
fn junction_separates(a: &Curve<'_>, b: &Curve<'_>, span: [f64; 4], joins: &[(f64, f64)], precision: f64) -> Result<bool, String> {
    for &(ta, tb) in joins {
        if !(span[0] <= ta && ta <= span[1] && span[2] <= tb && tb <= span[3]) { continue; }
        let da = a.bounds(ta, ta, true)?;
        let db = b.bounds(tb, tb, true)?;
        let sa = if ta == 0.0 { 1.0 } else { -1.0 };
        let sb = if tb == 0.0 { 1.0 } else { -1.0 };
        let midpoint = |v: Box2| [v[0].lo * 0.5 + v[0].hi * 0.5, v[1].lo * 0.5 + v[1].hi * 0.5];
        let da = midpoint(da);
        let db = midpoint(db);
        let la = da[0].hypot(da[1]);
        let lb = db[0].hypot(db[1]);
        let axis = [sa * da[0] / la - sb * db[0] / lb, sa * da[1] / la - sb * db[1] / lb];
        if !axis.iter().all(|v| v.is_finite()) { continue; }
        let av = a.bounds(span[0], span[1], true)?;
        let bv = b.bounds(span[2], span[3], true)?;
        let ad = iv::dot(av, axis).mul(iv::point(sa));
        let bd = iv::dot(bv, axis).mul(iv::point(sb));
        if ad.lo > 0.0 && bd.hi < 0.0 {
            let ap = a.at(ta)?;
            let bp = b.at(tb)?;
            let delta = [ap[0].sub(bp[0]), ap[1].sub(bp[1])];
            let distance = |v: Box2| iv::point(v[0].lo.abs().max(v[0].hi.abs()))
                .add(iv::point(v[1].lo.abs().max(v[1].hi.abs())));
            let projected = iv::dot(delta, axis);
            let uncertainty = iv::point(projected.lo.abs().max(projected.hi.abs()));
            // Existing extraction identifies adjacent endpoints within its
            // closure tolerance. Bound the possible meeting neighbourhood:
            // near-parallel departures must not amplify that uncertainty
            // into an undetected remote crossing. No guessed endpoint snap.
            // At a meeting, mA*s + mB*t <= |axis.(B0-A0)|, where s/t
            // are outward parameters and mA/mB the positive slope bounds.
            // Multiplying each parameter bound by max speed bounds its
            // arc length from the designated endpoint by join Precision.
            let speed = distance(av).hi.max(distance(bv).hi);
            let lower_slope = ad.lo.min(-bd.hi);
            if distance(delta).hi <= precision
                && uncertainty.mul(iv::point(speed)).hi <= iv::point(precision).mul(iv::point(lower_slope)).lo {
                return Ok(true);
            }
        }
    }
    Ok(false)
}

fn separate(a: &Curve<'_>, b: &Curve<'_>, joins: &[(f64, f64)], precision: f64, join_precision: f64, budget: &mut Budget) -> Result<(), String> {
    let mut pending = vec![([0.0, 1.0, 0.0, 1.0], 0u8)];
    while let Some((span, depth)) = pending.pop() {
        budget.spend()?;
        let ab = a.bounds(span[0], span[1], false)?;
        let bb = b.bounds(span[2], span[3], false)?;
        if iv::separated(ab, bb, precision) || junction_separates(a, b, span, joins, join_precision)? { continue; }
        if depth >= MAX_REFINEMENT {
            return Err("profile boundaries touch, intersect, or cannot be separated at context Precision".into());
        }
        let mut left = span;
        let mut right = span;
        if iv::width(ab) >= iv::width(bb) {
            let mid = (span[0] + span[1]) * 0.5;
            left[1] = mid;
            right[0] = mid;
        } else {
            let mid = (span[2] + span[3]) * 0.5;
            left[3] = mid;
            right[2] = mid;
        }
        pending.push((right, depth + 1));
        pending.push((left, depth + 1));
    }
    Ok(())
}

fn ray_coordinates(bounds: Box2, query: Box2, slope: f64) -> Box2 {
    let delta = [bounds[0].sub(query[0]), bounds[1].sub(query[1])];
    [delta[0].add(delta[1].mul(iv::point(slope))),
        delta[1].sub(delta[0].mul(iv::point(slope)))]
}

fn contains(boundary: &[Curve<'_>], query: Box2, budget: &mut Budget) -> Result<bool, String> {
    // A ray through a vertex or tangent is deliberately retried, not assigned
    // a guessed crossing. All retries share the caller's aggregate budget.
    for slope in [0.0, 0.375, -0.625, 1.25, -1.75, 2.875, -3.125, 4.625] {
        let mut crossings = 0;
        let mut certain = true;
        for curve in boundary {
            match ray_crossings(curve, query, slope, budget)? {
                Some(count) => crossings += count,
                None => { certain = false; break; }
            }
        }
        if certain { return Ok(crossings % 2 == 1); }
    }
    Err("profile topology containment is numerically indeterminate".into())
}

fn ray_crossings(curve: &Curve<'_>, query: Box2, slope: f64, budget: &mut Budget) -> Result<Option<usize>, String> {
    let mut count = 0;
    let mut pending = vec![(0.0, 1.0, 0u8)];
    while let Some((lo, hi, depth)) = pending.pop() {
        budget.spend()?;
        let bounds = ray_coordinates(curve.bounds(lo, hi, false)?, query, slope);
        if bounds[1].lo > 0.0 || bounds[1].hi < 0.0 || bounds[0].hi < 0.0 { continue; }
        let first = ray_coordinates(curve.at(lo)?, query, slope)[1];
        let last = ray_coordinates(curve.at(hi)?, query, slope)[1];
        let derivative = iv::dot(curve.bounds(lo, hi, true)?, [-slope, 1.0]);
        if derivative.lo > 0.0 || derivative.hi < 0.0 {
            if (first.lo > 0.0 && last.lo > 0.0) || (first.hi < 0.0 && last.hi < 0.0) { continue; }
            if ((first.hi < 0.0 && last.lo > 0.0) || (first.lo > 0.0 && last.hi < 0.0)) && bounds[0].lo > 0.0 {
                count += 1;
                continue;
            }
        }
        if depth >= MAX_REFINEMENT { return Ok(None); }
        // Non-dyadic split reduces repeated rays landing exactly on a circle
        // quadrant. Endpoint ambiguity remains an explicit retry regardless.
        let mid = lo + (hi - lo) * 0.4375;
        pending.push((mid, hi, depth + 1));
        pending.push((lo, mid, depth + 1));
    }
    Ok(Some(count))
}

#[cfg(test)]
#[path = "profile_topology_tests.rs"]
mod tests;
