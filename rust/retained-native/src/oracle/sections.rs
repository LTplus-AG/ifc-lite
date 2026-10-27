// SPDX-License-Identifier: MPL-2.0
//! V(extrusion ∩ halfspaces), by exact Green section areas and adaptive GL8.
//! No retained request, kernel output, mesh sampling or fitted profile enters.
use super::{clipping::{clipped_area, HalfPlane}, math::*};
pub use super::sections_source::ExtrudedHost;
#[path = "section_events.rs"]
mod events;
const RELATIVE: f64 = 1e-13;
const WORK: usize = 2_000_000;

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
        (sum.is_finite() && sum >= -1e-13).then_some(sum.max(0.))
    };
    let mut volume = 0.;
    for span in breaks.windows(2) {
        volume += integrate(&area, span[0], span[1], &mut work)?;
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
fn integrate(area: &impl Fn(f64, &mut usize) -> Option<f64>, a: f64, b: f64, work: &mut usize) -> Option<f64> {
    let mut coarse = gauss(area, a, b, work)?;
    let mut pieces = 1usize;
    loop {
        pieces = pieces.checked_mul(2)?;
        let width = (b - a) / pieces as f64;
        if width <= 0. || a + width == a { return None; }
        // Compare whole levels, not each leaf's relative error. At a circular
        // tangency, area grows like t^(3/2): a leaf touching zero has the same
        // relative quadrature error however small it gets, while its absolute
        // contribution to this span converges. Compensate the level's sum.
        let (mut fine, mut correction) = (0., 0.);
        for i in 0..pieces {
            let low = a + (b - a) * (i as f64 / pieces as f64);
            let high = a + (b - a) * ((i + 1) as f64 / pieces as f64);
            let term = gauss(area, low, high, work)? - correction;
            let next = fine + term;
            correction = (next - fine) - term;
            fine = next;
        }
        if !fine.is_finite() || !coarse.is_finite() { return None; }
        if (fine - coarse).abs() <= RELATIVE * fine.abs().max(coarse.abs()) {
            return Some(fine);
        }
        coarse = fine;
    }
}
