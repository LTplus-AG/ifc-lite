// SPDX-License-Identifier: MPL-2.0
//! The profile of an [`Extrusion`]: an outer boundary and any voids, checked
//! to be a region IFC can sweep and written as an
//! `IfcArbitraryClosedProfileDef`, or an `IfcArbitraryProfileDefWithVoids`
//! when it has voids.

use super::add_types::Extrusion;
use super::placement::fmt;
use super::props_synth::ref_list;
use super::tessellation::Emit;

/// The most corners a profile may have, voids included: the crossing check
/// is quadratic.
const MAX_PROFILE_POINTS: usize = 4096;

pub(crate) fn validate_extrusion(e: &Extrusion) -> Result<(), String> {
    let outer = loop_points(&e.profile);
    check_loop(outer, "an extrusion profile")?;
    let voids: Vec<&[[f64; 2]]> = e.voids.iter().map(|v| loop_points(v)).collect();
    for (i, v) in voids.iter().enumerate() {
        check_loop(v, &format!("void {i} of an extrusion profile"))?;
    }
    let total = outer.len() + voids.iter().map(|v| v.len()).sum::<usize>();
    if total > MAX_PROFILE_POINTS {
        return Err(format!("an extrusion profile has {total} points, more than {MAX_PROFILE_POINTS}"));
    }
    if self_intersects(outer) {
        return Err("an extrusion profile crosses itself".into());
    }
    for (i, v) in voids.iter().enumerate() {
        if self_intersects(v) {
            return Err(format!("void {i} of an extrusion profile crosses itself"));
        }
        // With no edges touching, one corner says which side a loop is on.
        if loops_touch(outer, v) || !inside(v[0], outer) {
            return Err(format!("void {i} is not strictly inside the extrusion profile"));
        }
        for (j, w) in voids.iter().enumerate().take(i) {
            if loops_touch(v, w) || inside(v[0], w) || inside(w[0], v) {
                return Err(format!("voids {j} and {i} of an extrusion profile overlap"));
            }
        }
    }
    if !(e.depth.is_finite() && e.depth > 0.0) {
        return Err(format!("extrusion depth must be positive and finite, got {}", e.depth));
    }
    let [dx, dy, dz] = e.direction;
    if !(dx.is_finite() && dy.is_finite() && dz.is_finite()) || dz == 0.0 {
        return Err("extrusion direction must be finite and leave the profile plane (non-zero Z)".into());
    }
    Ok(())
}

/// A simple polygon's own rules: enough distinct, finite corners enclosing
/// some area.
fn check_loop(pts: &[[f64; 2]], what: &str) -> Result<(), String> {
    if pts.len() < 3 {
        return Err(format!("{what} needs at least 3 distinct points"));
    }
    if pts.iter().flatten().any(|v| !v.is_finite()) {
        return Err(format!("{what} has a point that is not finite"));
    }
    if pts.iter().zip(pts.iter().cycle().skip(1)).any(|(a, b)| a == b) {
        return Err(format!("{what} repeats a point"));
    }
    let twice_area: f64 = pts.iter().zip(pts.iter().cycle().skip(1)).map(|(a, b)| a[0] * b[1] - b[0] * a[1]).sum();
    // Against the loop's own size, not its distance from the origin.
    let range = |axis: usize| {
        let (lo, hi) = pts.iter().fold((f64::INFINITY, f64::NEG_INFINITY), |(lo, hi), p| (lo.min(p[axis]), hi.max(p[axis])));
        hi - lo
    };
    let extent = range(0).max(range(1));
    // `!(x > eps)` also refuses a NaN that overflow produced.
    if !(twice_area.abs() > 1e-12 * extent * extent) {
        return Err(format!("{what} encloses no area"));
    }
    Ok(())
}

fn orient(a: [f64; 2], b: [f64; 2], c: [f64; 2]) -> f64 {
    geometry_predicates::orient2d(a, b, c)
}

/// Whether segments `ab` and `cd` touch or cross, with exact orientation
/// predicates on the given coordinates.
fn segments_meet(a: [f64; 2], b: [f64; 2], c: [f64; 2], d: [f64; 2]) -> bool {
    let on = |a: [f64; 2], b: [f64; 2], p: [f64; 2]| {
        p[0] >= a[0].min(b[0]) && p[0] <= a[0].max(b[0]) && p[1] >= a[1].min(b[1]) && p[1] <= a[1].max(b[1])
    };
    let (d1, d2, d3, d4) = (orient(c, d, a), orient(c, d, b), orient(a, b, c), orient(a, b, d));
    if ((d1 > 0.0 && d2 < 0.0) || (d1 < 0.0 && d2 > 0.0)) && ((d3 > 0.0 && d4 < 0.0) || (d3 < 0.0 && d4 > 0.0)) {
        return true;
    }
    (d1 == 0.0 && on(c, d, a)) || (d2 == 0.0 && on(c, d, b)) || (d3 == 0.0 && on(a, b, c)) || (d4 == 0.0 && on(a, b, d))
}

fn edges(pts: &[[f64; 2]]) -> impl Iterator<Item = ([f64; 2], [f64; 2])> + '_ {
    pts.iter().zip(pts.iter().cycle().skip(1)).map(|(&a, &b)| (a, b))
}

/// Whether two edges of the closed polygon `pts` that share no corner touch
/// or cross.
fn self_intersects(pts: &[[f64; 2]]) -> bool {
    let n = pts.len();
    (0..n).any(|i| {
        (i + 2..n)
            .filter(|&j| !(i == 0 && j == n - 1))
            .any(|j| segments_meet(pts[i], pts[(i + 1) % n], pts[j], pts[(j + 1) % n]))
    })
}

/// Whether any edge of one closed polygon touches or crosses any of the other's.
fn loops_touch(p: &[[f64; 2]], q: &[[f64; 2]]) -> bool {
    edges(p).any(|(a, b)| edges(q).any(|(c, d)| segments_meet(a, b, c, d)))
}

/// Whether `p` is inside the closed polygon `pts`, for a point on none of its
/// edges: the winding number, from exact orientations.
fn inside(p: [f64; 2], pts: &[[f64; 2]]) -> bool {
    let mut winding = 0i32;
    for (a, b) in edges(pts) {
        if a[1] <= p[1] {
            if b[1] > p[1] && orient(a, b, p) > 0.0 {
                winding += 1;
            }
        } else if b[1] <= p[1] && orient(a, b, p) < 0.0 {
            winding -= 1;
        }
    }
    winding != 0
}

/// A loop without a closing repeat of its first point.
fn loop_points(profile: &[[f64; 2]]) -> &[[f64; 2]] {
    match (profile.first(), profile.last()) {
        (Some(a), Some(b)) if profile.len() > 1 && a == b => &profile[..profile.len() - 1],
        _ => profile,
    }
}

/// A closed `IfcPolyline` through the loop.
fn polyline(emit: &mut Emit, pts: &[[f64; 2]]) -> Result<u32, String> {
    let pts = loop_points(pts);
    let mut point_ids = Vec::with_capacity(pts.len() + 1);
    for p in pts {
        point_ids.push(emit.record("IFCCARTESIANPOINT", &[("Coordinates", format!("({},{})", fmt(p[0]), fmt(p[1])))])?);
    }
    point_ids.push(point_ids[0]);
    emit.record("IFCPOLYLINE", &[("Points", ref_list(&point_ids))])
}

/// The profile record of a checked extrusion.
pub(crate) fn profile(emit: &mut Emit, e: &Extrusion) -> Result<u32, String> {
    let outer = polyline(emit, &e.profile)?;
    if e.voids.is_empty() {
        return emit.record("IFCARBITRARYCLOSEDPROFILEDEF", &[("ProfileType", ".AREA.".into()), ("OuterCurve", format!("#{outer}"))]);
    }
    let inner = e.voids.iter().map(|v| polyline(emit, v)).collect::<Result<Vec<_>, _>>()?;
    emit.record(
        "IFCARBITRARYPROFILEDEFWITHVOIDS",
        &[("ProfileType", ".AREA.".into()), ("OuterCurve", format!("#{outer}")), ("InnerCurves", ref_list(&inner))],
    )
}

#[cfg(test)]
#[path = "add_profile_tests.rs"]
mod tests;
