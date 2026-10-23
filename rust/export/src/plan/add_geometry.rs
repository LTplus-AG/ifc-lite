// SPDX-License-Identifier: MPL-2.0
//! Geometry for [`super::Disposition::Add`]: an `IfcProductDefinitionShape`
//! from an extrusion or a triangle mesh, with an optional surface colour.
//! Meshes, colours, contexts and the shape around an item are built by
//! [`super::tessellation`], shared with the geometry patch; only the
//! extrusion is Add's own.

use super::add_types::{Extrusion, Representation};
use super::placement::fmt;
use super::props_synth::ref_list;
use super::tessellation::{body_shape, mesh_item, Emit};
use super::types::SurfaceColour;

pub(crate) fn validate_extrusion(e: &Extrusion) -> Result<(), String> {
    let pts = profile_points(&e.profile);
    if pts.len() < 3 {
        return Err("an extrusion profile needs at least 3 distinct points".into());
    }
    if pts.iter().flatten().any(|v| !v.is_finite()) {
        return Err("an extrusion profile point is not finite".into());
    }
    if pts.iter().zip(pts.iter().cycle().skip(1)).any(|(a, b)| a == b) {
        return Err("an extrusion profile repeats a point".into());
    }
    let twice_area: f64 = pts
        .iter()
        .zip(pts.iter().cycle().skip(1))
        .map(|(a, b)| a[0] * b[1] - b[0] * a[1])
        .sum();
    // Against the profile's own size, not its distance from the origin.
    let range = |axis: usize| {
        let (lo, hi) = pts.iter().fold((f64::INFINITY, f64::NEG_INFINITY), |(lo, hi), p| (lo.min(p[axis]), hi.max(p[axis])));
        hi - lo
    };
    let extent = range(0).max(range(1));
    // `!(x > eps)` also refuses a NaN that overflow produced.
    if !(twice_area.abs() > 1e-12 * extent * extent) {
        return Err("an extrusion profile encloses no area".into());
    }
    if pts.len() > MAX_PROFILE_POINTS {
        return Err(format!("an extrusion profile has {} points, more than {MAX_PROFILE_POINTS}", pts.len()));
    }
    if self_intersects(pts) {
        return Err("an extrusion profile crosses itself".into());
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

/// The most corners a profile may have: the crossing check is quadratic.
const MAX_PROFILE_POINTS: usize = 4096;

/// Whether two edges of the closed polygon `pts` that share no corner touch
/// or cross, with exact orientation predicates on the given coordinates.
fn self_intersects(pts: &[[f64; 2]]) -> bool {
    let n = pts.len();
    let orient = |a: [f64; 2], b: [f64; 2], c: [f64; 2]| geometry_predicates::orient2d(a, b, c);
    let on = |a: [f64; 2], b: [f64; 2], p: [f64; 2]| {
        p[0] >= a[0].min(b[0]) && p[0] <= a[0].max(b[0]) && p[1] >= a[1].min(b[1]) && p[1] <= a[1].max(b[1])
    };
    let meet = |a: [f64; 2], b: [f64; 2], c: [f64; 2], d: [f64; 2]| {
        let (d1, d2, d3, d4) = (orient(c, d, a), orient(c, d, b), orient(a, b, c), orient(a, b, d));
        if ((d1 > 0.0 && d2 < 0.0) || (d1 < 0.0 && d2 > 0.0)) && ((d3 > 0.0 && d4 < 0.0) || (d3 < 0.0 && d4 > 0.0)) {
            return true;
        }
        (d1 == 0.0 && on(c, d, a)) || (d2 == 0.0 && on(c, d, b)) || (d3 == 0.0 && on(a, b, c)) || (d4 == 0.0 && on(a, b, d))
    };
    (0..n).any(|i| {
        (i + 2..n).filter(|&j| !(i == 0 && j == n - 1)).any(|j| meet(pts[i], pts[(i + 1) % n], pts[j], pts[(j + 1) % n]))
    })
}

/// The profile without a closing repeat of its first point.
fn profile_points(profile: &[[f64; 2]]) -> &[[f64; 2]] {
    match (profile.first(), profile.last()) {
        (Some(a), Some(b)) if profile.len() > 1 && a == b => &profile[..profile.len() - 1],
        _ => profile,
    }
}

/// Build the product's shape, returning the `IfcProductDefinitionShape` id,
/// or `None` for [`Representation::None`].
pub(crate) fn product_shape(
    emit: &mut Emit,
    context: u32,
    rep: &Representation,
    colour: Option<&SurfaceColour>,
) -> Result<Option<u32>, String> {
    let (item, rep_type) = match rep {
        Representation::None => return Ok(None),
        Representation::Extrusion(e) => (extruded_solid(emit, e)?, "SweptSolid"),
        Representation::Mesh(m) => mesh_item(emit, m)?,
    };
    body_shape(emit, context, item, rep_type, colour).map(Some)
}

fn extruded_solid(emit: &mut Emit, e: &Extrusion) -> Result<u32, String> {
    let pts = profile_points(&e.profile);
    let mut point_ids = Vec::with_capacity(pts.len() + 1);
    for p in pts {
        point_ids.push(emit.record("IFCCARTESIANPOINT", &[("Coordinates", format!("({},{})", fmt(p[0]), fmt(p[1])))])?);
    }
    point_ids.push(point_ids[0]);
    let polyline = emit.record("IFCPOLYLINE", &[("Points", ref_list(&point_ids))])?;
    let profile = emit.record(
        "IFCARBITRARYCLOSEDPROFILEDEF",
        &[("ProfileType", ".AREA.".into()), ("OuterCurve", format!("#{polyline}"))],
    )?;
    let position = emit.identity_placement()?;
    let [dx, dy, dz] = e.direction;
    let direction = emit.record("IFCDIRECTION", &[("DirectionRatios", format!("({},{},{})", fmt(dx), fmt(dy), fmt(dz)))])?;
    emit.record(
        "IFCEXTRUDEDAREASOLID",
        &[
            ("SweptArea", format!("#{profile}")),
            ("Position", format!("#{position}")),
            ("ExtrudedDirection", format!("#{direction}")),
            ("Depth", fmt(e.depth)),
        ],
    )
}

#[cfg(test)]
#[path = "add_geometry_tests.rs"]
mod tests;
