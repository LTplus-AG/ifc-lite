// SPDX-License-Identifier: MPL-2.0
//! V((extrusion ∩ kept halfspaces) minus a union of convex cutters), source only (#7955).
//! Inclusion-exclusion over the cutter subsets whose intersection is non-empty: every
//! superset of an empty intersection is empty, so disjoint cutters cost nothing and the
//! cutter count has no cap, only the work budget. A non-convex cutter is one solid of
//! partition pieces, whose mutual intersections have no volume and are never formed.
use super::{bounded_partition::extrusion_pieces, clipping::{convex_planes, Edge}, math::*, sections::{section_volume, ExtrudedHost}};

pub(super) type Halfspace = ([f64; 3], f64);
pub(super) type ConvexCut = Vec<Halfspace>;
/// Section integrals for one net volume. `None` past it, never a truncated sum.
const WORK: usize = 100_000;
/// An intersection this far below the kept volume is rounding on a shared boundary, not
/// material: at the work budget the dropped terms stay under 1e-9, far below every limit.
const EMPTY_RELATIVE: f64 = 1e-14;

pub(super) fn net_volume(host: &ExtrudedHost, kept: &[Halfspace], solids: &[Vec<ConvexCut>]) -> Option<f64> {
    net_of(&|planes: &[Halfspace]| section_volume(host, planes), kept, solids)
}
/// [`net_volume`] for any host whose volume inside halfspaces the caller can integrate.
pub(super) fn net_of(volume_in: &dyn Fn(&[Halfspace]) -> Option<f64>, kept: &[Halfspace], solids: &[Vec<ConvexCut>]) -> Option<f64> {
    let mut work = WORK;
    let mut planes = kept.to_vec();
    let mut volume = volume_in(&planes)?;
    let empty = volume * EMPTY_RELATIVE;
    let mut active = Vec::new();
    for (solid, pieces) in solids.iter().enumerate() {
        for cut in pieces {
            work = work.checked_sub(1)?;
            planes.extend_from_slice(cut);
            let overlap = volume_in(&planes)?;
            planes.truncate(kept.len());
            if overlap > empty { active.push((solid, cut, overlap)); }
        }
    }
    for i in 0..active.len() {
        volume -= active[i].2;
        planes.extend_from_slice(active[i].1);
        volume += deeper(volume_in, &mut planes, active[i].0, &active[i + 1..], 1., empty, &mut work)?;
        planes.truncate(kept.len());
    }
    (volume.is_finite() && volume >= -1e-9).then_some(volume.max(0.))
}
/// The alternating sum over `planes` intersected with each further subset of `rest`. Pieces
/// of one solid's partition share at most a boundary, so only another solid's can add a term.
fn deeper(volume_in: &dyn Fn(&[Halfspace]) -> Option<f64>, planes: &mut Vec<Halfspace>, solid: usize, rest: &[(usize, &ConvexCut, f64)], sign: f64, empty: f64, work: &mut usize) -> Option<f64> {
    let mut sum = 0.;
    let base = planes.len();
    for (i, (other, cut, _)) in rest.iter().enumerate() {
        if *other == solid { continue; }
        *work = work.checked_sub(1)?;
        planes.extend_from_slice(cut);
        let overlap = volume_in(planes)?;
        if overlap > empty {
            sum += sign * overlap + deeper(volume_in, planes, *other, &rest[i + 1..], -sign, empty, work)?;
        }
        planes.truncate(base);
    }
    Some(sum)
}

/// Target chord height of a polygonised arc, up to MAX_ARC_CHORDS (a full circle of 1 m is
/// then 0.3 mm). At the cap the inscribed polygon removes 4e-4 less than the arc, under the
/// 2e-3 curved limit even with no host left around it, and a result that used one is judged as curved.
const CHORD_HEIGHT_METRES: f64 = 1e-4;
const MAX_ARC_CHORDS: usize = 128;
const MAX_CONVEX_SIDES: usize = 12;
/// `edges` with each arc replaced by inscribed chords; `scale` is metres per profile unit.
pub(super) fn polygonised(edges: &[Edge], scale: f64) -> Option<Vec<Edge>> {
    let mut out = Vec::new();
    for edge in edges {
        let Edge::Arc { u, v, sweep, .. } = *edge else { out.push(edge.clone()); continue };
        let radius = u[0].hypot(u[1]).max(v[0].hypot(v[1])) * scale;
        if !radius.is_finite() || radius <= 0. { return None; }
        let step = 2. * (1. - (CHORD_HEIGHT_METRES / radius).min(1.)).acos();
        // A tiny radius meets the chord height at once: 16 chords per turn keep its shape,
        // removing 2.6% less of a full circle, which the curved judgement then answers for.
        let floor = (16. * sweep.abs() / std::f64::consts::TAU).ceil() as usize;
        let chords = ((sweep.abs() / step).ceil() as usize).max(floor).clamp(2, MAX_ARC_CHORDS);
        let point = |i: usize| edge.point(i as f64 / chords as f64);
        out.extend((0..chords).map(|i| Edge::Line(point(i), point(i + 1))));
    }
    Some(out)
}
/// One source extrusion as convex world cutters, and whether an arc was polygonised.
/// A convex profile stays whole; a non-convex one is its ear partition, never its hull.
pub(super) fn extrusion_cutters(host: &ExtrudedHost) -> Option<(Vec<ConvexCut>, bool)> {
    if host.loops.len() != 1 || !host.loops[0].0 { return None; }
    let curved = host.loops[0].1.iter().any(|e| matches!(e, Edge::Arc { .. }));
    let scale = dot(vector(&host.frame, [1., 0., 0.]), vector(&host.frame, [1., 0., 0.])).sqrt();
    let edges = polygonised(&host.loops[0].1, scale)?;
    // A many-sided convex cutter would pass `section_volume`'s plane limit in any overlap.
    if edges.len() <= MAX_CONVEX_SIDES { if let Some(cut) = convex_prism(host, &edges) { return Some((vec![cut], curved)); } }
    let polygon = ExtrudedHost { loops: vec![(true, edges)], frame: host.frame, direction: host.direction, depth: host.depth, jacobian: host.jacobian };
    Some((extrusion_pieces(&polygon)?, curved))
}
fn convex_prism(host: &ExtrudedHost, edges: &[Edge]) -> Option<ConvexCut> {
    use ifc_lite_geometry::{Matrix4, Vector3};
    let profile = convex_planes(edges)?;
    let x = Vector3::from(vector(&host.frame, [1., 0., 0.]));
    let y = Vector3::from(vector(&host.frame, [0., 1., 0.]));
    let z = Vector3::from(host.direction); let origin = Vector3::from(transform(&host.frame, [0.; 3]));
    let frame = Matrix4::from_columns(&[x.push(0.), y.push(0.), z.push(0.), origin.push(1.)]);
    let inverse = frame.try_inverse()?.transpose();
    let mut local: Vec<_> = profile.into_iter().map(|p| ([-p.n[0], -p.n[1], 0.], p.d)).collect();
    local.extend([([0., 0., -1.], 0.), ([0., 0., 1.], host.depth)]);
    Some(local.into_iter().map(|(n, c)| {
        let n = inverse.fixed_view::<3, 3>(0, 0) * Vector3::from(n); let n = [n.x, n.y, n.z];
        (n, c + dot(n, [origin.x, origin.y, origin.z]))
    }).collect())
}
