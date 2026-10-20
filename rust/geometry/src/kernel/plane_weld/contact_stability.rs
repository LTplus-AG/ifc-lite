// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Sufficient initial-foot contact escape from the existing uncertainty body.
//! This NEW admission restriction is not an intersection-error, intent or
//! composed Boolean theorem. The caller retains every old transversal premise.
use super::{axis_rescue::AxisPlane, selection::Face, NearBand, Tri};
use crate::kernel::{budget, near_band::vertex_bits};
use num_rational::BigRational as R;
use num_traits::{Signed, Zero};
type V = [R; 3];
fn vector(p: [f64; 3]) -> Option<V> {
    Some([R::from_float(p[0])?, R::from_float(p[1])?, R::from_float(p[2])?])
}
fn sub(a: &V, b: &V) -> V { std::array::from_fn(|k| &a[k] - &b[k]) }
fn dot(a: &V, b: &V) -> R { (0..3).map(|k| &a[k] * &b[k]).sum() }
struct Body { noise: V, floor: R }
impl Body {
    fn new(band: &NearBand) -> Option<Self> {
        let (extent, scale, floor) = band.uncertainty_basis();
        let extent = vector(extent)?;
        let scale = R::from_float(scale)?;
        let floor = R::from_float(floor)?;
        if scale.is_negative() || floor.is_negative() || extent.iter().any(Signed::is_negative) { return None; }
        Some(Self { noise: extent.map(|x| x * &scale), floor })
    }
}

/// Exact finite source-triangle/axis-plane contact. Only Point/Segment is
/// supported; a coplanar triangle or an empty contact stays undecided.
fn contact(source: &[V; 3], axis: usize, value: &R) -> Option<Vec<V>> {
    let distances: [R; 3] = std::array::from_fn(|i| &source[i][axis] - value);
    if distances.iter().all(Zero::is_zero) { return None; }
    let mut points = Vec::with_capacity(2);
    for i in 0..3 {
        let j = (i + 1) % 3;
        let mut insert = |p: V| { if !points.contains(&p) { points.push(p); } };
        if distances[i].is_zero() { insert(source[i].clone()); }
        if (&distances[i] * &distances[j]).is_negative() {
            let t = &distances[i] / (&distances[i] - &distances[j]);
            insert(std::array::from_fn(|k| &source[i][k] + (&source[j][k] - &source[i][k]) * &t));
        }
    }
    (points.len() == 1 || points.len() == 2).then_some(points)
}

/// Closest-point normal provides a SUFFICIENT separating support direction.
/// False is undecided, not a certificate of inclusion for an anisotropic body.
fn endpoint_escapes(p: &V, other: &[V], body: &Body) -> bool {
    let q = if other.len() == 1 { other[0].clone() } else {
        let edge = sub(&other[1], &other[0]);
        let length2 = dot(&edge, &edge);
        if length2.is_zero() { return false; }
        let t = (dot(&sub(p, &other[0]), &edge) / length2).max(R::zero()).min(R::from_integer(1.into()));
        std::array::from_fn(|k| &other[0][k] + &edge[k] * &t)
    };
    let d = sub(p, &q);
    let nn = dot(&d, &d);
    if nn.is_zero() { return false; }
    let projected: R = (0..3).map(|k| d[k].abs() * &body.noise[k]).sum();
    let support2 = (&body.floor * &body.floor * &nn).max(&projected * &projected);
    &nn * &nn > support2
}
fn either_direction_escapes(a: &[V], b: &[V], body: &Body) -> bool {
    a.iter().any(|p| endpoint_escapes(p, b, body)) || b.iter().any(|p| endpoint_escapes(p, a, body))
}

pub(super) fn escapes_original_contact(
    source: &Tri, original: [f64; 3], initial_foot: [f64; 3], face: &Face, band: &NearBand,
) -> bool {
    if budget::tripped() || !source.iter().flatten().chain(original.iter()).chain(initial_foot.iter()).all(|x| x.is_finite()) { return false; }
    let Some(plane) = AxisPlane::new(face.t, face.band2) else { return false; };
    let (axis, value) = plane.axis_value();
    if initial_foot[axis] != value || (0..3).any(|k| k != axis && initial_foot[k].to_bits() != original[k].to_bits()) { return false; }
    let matches: Vec<usize> = (0..3).filter(|&i| vertex_bits(&source[i]) == vertex_bits(&original)).collect();
    if matches.len() != 1 { return false; }
    // Charge this bounded exact query under existing caps. No counter resets,
    // new public mode or unbounded exact escalation is introduced.
    budget::note_escalation();
    if budget::tripped() { return false; }
    let Some(body) = Body::new(band) else { return false; };
    let Some(value) = R::from_float(value) else { return false; };
    let Some(a) = vector(source[0]) else { return false; };
    let Some(b) = vector(source[1]) else { return false; };
    let Some(c) = vector(source[2]) else { return false; };
    let source = [a,b,c];
    let distances: [R;3] = std::array::from_fn(|i| &source[i][axis] - &value);
    if !distances.iter().any(Signed::is_positive) || !distances.iter().any(Signed::is_negative) { return false; }
    let Some(old) = contact(&source, axis, &value).filter(|c| c.len() == 2) else { return false; };
    let mut changed = source;
    let Some(foot) = vector(initial_foot) else { return false; };
    changed[matches[0]] = foot;
    let Some(new) = contact(&changed, axis, &value) else { return false; };
    either_direction_escapes(&old, &new, &body) && !budget::tripped()
}

#[cfg(test)]
#[path = "contact_stability_tests.rs"]
mod tests;
