// SPDX-License-Identifier: MPL-2.0
//! V(extrusion ∩ halfspaces), by exact Green section areas and adaptive GL8.
//! No retained request, kernel output, mesh sampling or fitted profile enters.
use super::{clipping::{clipped_area, HalfPlane, Edge}, math::*};
pub use super::sections_source::ExtrudedHost;
#[path = "section_events.rs"]
mod events;
const RELATIVE: f64 = 1e-13;
const WORK: usize = 2_000_000;

#[cfg(test)]
#[path = "sections_tests.rs"]
mod tests;

/// World halfspaces n·x <= c. `None` means unsupported or work exhausted,
/// never a truncated integral. Direction can be oblique or reversed.
pub fn section_volume(host: &ExtrudedHost, halfspaces: &[([f64; 3], f64)]) -> Option<f64> {
    if halfspaces.len() > 64 { return None; }
    let origin = transform(&host.frame, [0.; 3]);
    let x = vector(&host.frame, [1., 0., 0.]); let y = vector(&host.frame, [0., 1., 0.]);
    let mut planes = Vec::new();
    for &(n, c) in halfspaces {
        if n.iter().any(|v| !v.is_finite()) || !c.is_finite() || dot(n, n) == 0. { return None; }
        // a*x+b*y+q*t <= h in the unswept profile coordinates.
        let row = [dot(n, x), dot(n, y), dot(n, host.direction), c - dot(n, origin)];
        if row.iter().any(|v| !v.is_finite()) { return None; }
        planes.push(row);
    }
    let breaks = events::breakpoints(host, &planes)?;
    let mut work = WORK;
    let unclipped: f64 = host.loops.iter().map(|(outer, edges)| {
        let area = edges.iter().map(Edge::integral).sum::<f64>().abs();
        if *outer { area } else { -area }
    }).sum();
    let profile = unclipped.abs();
    let area = |t: f64, work: &mut usize| -> Option<f64> {
        *work = work.checked_sub(1)?;
        let mut cuts = Vec::with_capacity(planes.len());
        for &[a, b, q, h] in &planes {
            if a == 0. && b == 0. { if q * t > h { return Some(0.); } }
            else { cuts.push(HalfPlane { n: [-a, -b], d: h - q * t }); }
        }
        let mut sum = 0.;
        for (outer, edges) in &host.loops {
            let a = clipped_area(edges, &cuts, work)?;
            sum += if *outer { a } else { -a };
        }
        // A cut inside a void leaves outer minus hole, rounding about the whole profile's area
        // (Snowdon #81962): zero material, whichever side of zero it lands on.
        (sum.is_finite() && sum >= -1e-13 * profile.max(1.)).then_some(sum.max(0.))
    };
    let linear = host.loops.iter().all(|(_,edges)|edges.iter().all(|edge|matches!(edge,Edge::Line(..))));
    let tolerance = RELATIVE * profile * host.depth;
    let mut volume = 0.;
    for span in breaks.windows(2) {
        // Between topology events, line intersections move affinely with t,
        // so Green area is a quadratic polynomial. GL8 is exact for it; a
        // convergence loop adds no evidence and can exhaust on an adjacent-ULP
        // event interval (the real FZK #60012/#67828 bounded cuts, #7955).
        volume += if linear {gauss(&area,span[0],span[1],&mut work)?}
            else {integrate(&area, span[0], span[1], tolerance, &mut work)?};
    }
    let volume = volume * host.jacobian;
    (volume.is_finite() && volume >= 0.).then_some(volume)
}
fn gauss(area: &impl Fn(f64, &mut usize) -> Option<f64>, a: f64, b: f64, work: &mut usize) -> Option<f64> {
    const X: [f64; 4] = [0.1834346424956498, 0.5255324099163290, 0.7966664774136267, 0.9602898564975363];
    const W: [f64; 4] = [0.3626837833783620, 0.3137066458778873, 0.2223810344533745, 0.1012285362903763];
    let mid = a + (b - a) / 2.; let half = (b - a) / 2.;
    let mut sum = 0.;
    for i in 0..4 { sum += W[i] * (area(mid - half * X[i], work)? + area(mid + half * X[i], work)?); }
    Some(sum * half)
}
/// Adaptive GL8: only intervals holding a singularity split. At a circular tangency area
/// grows like t^(3/2), so uniform refinement ran out of work (#7955: Snowdon #28109), and a
/// sliver span's own relative error is rounding noise however small it gets. `tolerance`
/// is absolute, from the host's whole integral, so neither can stall a converged sum.
fn integrate(area: &impl Fn(f64, &mut usize) -> Option<f64>, a: f64, b: f64, tolerance: f64, work: &mut usize) -> Option<f64> {
    let whole = gauss(area, a, b, work)?;
    refine(area, a, b, whole, tolerance, work)
}
fn refine(area: &impl Fn(f64, &mut usize) -> Option<f64>, a: f64, b: f64, whole: f64, tolerance: f64, work: &mut usize) -> Option<f64> {
    let mid = a + (b - a) / 2.;
    // No representable midpoint: this span has no width left to integrate.
    if mid <= a || mid >= b { return Some(whole); }
    let (left, right) = (gauss(area, a, mid, work)?, gauss(area, mid, b, work)?);
    if !left.is_finite() || !right.is_finite() { return None; }
    if (left + right - whole).abs() <= tolerance { return Some(left + right); }
    Some(refine(area, a, mid, left, tolerance, work)? + refine(area, mid, b, right, tolerance, work)?)
}
