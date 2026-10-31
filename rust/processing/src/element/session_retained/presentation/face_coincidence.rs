// SPDX-License-Identifier: MPL-2.0
//! When two source faces are one surface (#7955 M11-F, spec §3.3). Coincident
//! candidates are broken by the tie-break; any other pair refuses `ambiguous`.
//! Two faces coincide when every corner of each one's bounded extent lies on
//! the other's support within the incidence tolerance, so supports that merely
//! cross along a thin strip are never merged.
use super::face_attribution::{Choice, Extent, Operand, Region, Role, Segment, SourceFace, Support, INCIDENCE_CURVED_EXTRA_M, INCIDENCE_PLANAR_M};

type V = [f64; 3];
fn transform(m: &[f64; 16], p: V) -> V {
    std::array::from_fn(|i| m[i] * p[0] + m[i + 4] * p[1] + m[i + 8] * p[2] + m[i + 12])
}
fn compose(a: &[f64; 16], b: &[f64; 16]) -> [f64; 16] {
    std::array::from_fn(|i| (0..4).map(|k| a[k * 4 + i % 4] * b[i / 4 * 4 + k]).sum())
}
fn transposed(m: &[f64; 16]) -> [f64; 16] { std::array::from_fn(|i| m[i % 4 * 4 + i / 4]) }
fn inverse(m: &[f64; 16]) -> Option<[f64; 16]> {
    ifc_lite_geometry::math::mat4::affine_inverse(&transposed(m)).map(|r| transposed(&r))
}

/// Profile-plane point at sweep parameter `s`.
fn lift(region: &Region, q: [f64; 2], s: f64) -> V {
    let g = region.generator;
    [q[0] + s * g[0], q[1] + s * g[1], s * g[2]]
}
/// A boundary curve's ends and middle.
fn marks(segment: &Segment) -> Vec<[f64; 2]> {
    match *segment {
        Segment::Line { a, b } => vec![a, b],
        Segment::Arc { center, radius, x, nz, start, sweep } => [0., 0.5, 1.].iter()
            .map(|f| { let (sin, cos) = (start + f * sweep).sin_cos();
                [center[0] + radius * (x[0] * cos - nz * x[1] * sin), center[1] + radius * (x[1] * cos + nz * x[0] * sin)] })
            .collect(),
    }
}
/// Corners of a face's bounded extent in its operand's evaluation frame;
/// `None` where the extent has none (a swept-disk wall).
fn probes(operand: &Operand, face: &SourceFace) -> Option<Vec<V>> {
    match (&face.extent, &operand.region, &face.support) {
        (Extent::Side { segment }, Some(region), _) => Some([0., region.depth].iter()
            .flat_map(|&s| marks(segment).into_iter().map(move |q| lift(region, q, s))).collect()),
        (Extent::Cap, Some(region), _) => {
            let s = if face.role == (Role::Cap { end: true }) { region.depth } else { 0. };
            Some(region.loops.iter().flatten().flat_map(marks).map(|q| lift(region, q, s)).collect())
        }
        (Extent::Row { triangles }, _, _) => Some(triangles.iter().flatten().copied().collect()),
        (Extent::Plane, _, Support::Plane { origin, normal }) => {
            // Three non-collinear points determine the unbounded source plane.
            // They are support probes, never artificial finite cutter extents.
            let helper = if normal[0].abs() < 0.9 { [1., 0., 0.] } else { [0., 1., 0.] };
            let u = super::face_attribution::unit(cross(*normal, helper))?;
            let v = cross(*normal, u);
            Some(vec![*origin, std::array::from_fn(|i| origin[i] + u[i]),
                std::array::from_fn(|i| origin[i] + v[i])])
        }
        (Extent::Disk { center, radius }, _, Support::Plane { normal, .. }) => {
            let helper = if normal[0].abs() < 0.9 { [1., 0., 0.] } else { [0., 1., 0.] };
            let u = super::face_attribution::unit(cross(*normal, helper))?;
            let v = cross(*normal, u);
            Some([u, v, u.map(|c| -c), v.map(|c| -c)].iter()
                .map(|d| std::array::from_fn(|i| center[i] + radius * d[i])).collect())
        }
        _ => None,
    }
}
fn cross(a: V, b: V) -> V { [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]] }

/// Every probe of `b`'s bounded face lies on `a`'s support (planes and cylinders only).
fn covers(operands: &[Operand], a: Choice, b: Choice, chord: f64) -> bool {
    let (oa, ob) = (&operands[a.0], &operands[b.0]);
    let (fa, fb) = (&oa.faces[a.1], &ob.faces[b.1]);
    let (Some(back), Some(points)) = (inverse(&ob.from_part), probes(ob, fb)) else { return false };
    let into_a = compose(&oa.from_part, &back);
    let tolerance = oa.stretch * match fa.support { Support::Plane { .. } => INCIDENCE_PLANAR_M, _ => chord + INCIDENCE_CURVED_EXTRA_M };
    points.into_iter().all(|p| fa.support.flat_distance(transform(&into_a, p)).is_some_and(|d| d <= tolerance))
}

/// `a` and `b` are one surface: same kind, and each bounded face lies on the
/// other's support. Swept-disk walls coincide only as the same placed curve.
pub(crate) fn coincident(operands: &[Operand], a: Choice, b: Choice, chord: f64) -> bool {
    if a == b { return true; }
    let (oa, ob) = (&operands[a.0], &operands[b.0]);
    match (&oa.faces[a.1].support, &ob.faces[b.1].support) {
        (Support::Plane { .. }, Support::Plane { .. }) | (Support::Cylinder { .. }, Support::Cylinder { .. }) =>
            covers(operands, a, b, chord) && covers(operands, b, a, chord),
        (Support::Tube { curve: ca, radius: ra }, Support::Tube { curve: cb, radius: rb }) =>
            ra == rb && oa.from_part == ob.from_part && oa.sign == ob.sign && ca.same(cb),
        _ => false,
    }
}
