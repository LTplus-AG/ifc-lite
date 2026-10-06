// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Walls from vertical planes.
//!
//! Two faces make one wall when they are parallel within
//! `pairingAngleDegrees`, `minWallThicknessMetres..=maxWallThicknessMetres`
//! apart, overlap along the wall by `minWallOverlapFraction` of the shorter
//! face and share some height. When both normals face the scanner and point
//! into the gap between them, the gap was seen from inside, so it is open
//! space (a niche), not wall material: that pair is refused. Candidate pairs
//! are taken greedily, nearest first, each face used once. The wall spans
//! the union of both faces along its axis and in height; its axis sits
//! halfway between them.
//!
//! An unpaired face gets `defaultWallThicknessMetres`, placed behind the
//! scanned side: opposite a scanner-facing normal, else away from the
//! interior point.
//!
//! Bottom and top then snap to a floor or ceiling within `levelSnapMetres`
//! whose outline reaches the wall.
use super::frame::{dot, sub, Face, V3};
use super::levels::{snap_to, Level, Role};
use super::options::Params;
use super::report::{ProposalBasis, ProposalClass, ProposalGeometry, ScanProposalStats};
use super::score::{confidence, face_fit, Draft};

/// Horizontal unit normal with a deterministic sign (largest component
/// positive, x on ties).
fn wall_normal(face: &Face) -> V3 {
    let (x, y) = (face.normal[0], face.normal[1]);
    let length = x.hypot(y);
    let (x, y) = (x / length, y / length);
    if x.abs() >= y.abs() && x < 0. || y.abs() > x.abs() && y < 0. { [-x, -y, 0.] } else { [x, y, 0.] }
}

/// Along-wall direction: up x normal.
fn along(n: V3) -> V3 {
    [-n[1], n[0], 0.]
}

struct Pair {
    a: usize,
    b: usize,
    gap: f64,
    overlap: f64,
}

fn pair_of(faces: &[Face], a: usize, b: usize, params: &Params) -> Option<Pair> {
    let (fa, fb) = (&faces[a], &faces[b]);
    let n = wall_normal(fa);
    if dot(n, wall_normal(fb)).abs() < params.cos_pair {
        return None;
    }
    let gap = (dot(n, fa.centroid) - dot(n, fb.centroid)).abs();
    if gap < params.min_thickness || gap > params.max_thickness {
        return None;
    }
    if fa.scanner_facing && fb.scanner_facing {
        let into_gap_a = dot(fa.normal, sub(fb.centroid, fa.centroid)) > 0.;
        let into_gap_b = dot(fb.normal, sub(fa.centroid, fb.centroid)) > 0.;
        if into_gap_a && into_gap_b {
            return None;
        }
    }
    let u = along(n);
    let ((a0, a1), (b0, b1)) = (fa.span_along(u), fb.span_along(u));
    let overlap = a1.min(b1) - a0.max(b0);
    if overlap < params.min_overlap * (a1 - a0).min(b1 - b0) {
        return None;
    }
    let ((za0, za1), (zb0, zb1)) = (fa.z_range(), fb.z_range());
    if za1.min(zb1) <= za0.max(zb0) {
        return None;
    }
    Some(Pair { a, b, gap, overlap })
}

/// The wall between offsets along `n`, spanning `span` along the wall and
/// `z` in height, with its sources.
struct Body<'a> {
    n: V3,
    axis_offset: f64,
    span: (f64, f64),
    z: (f64, f64),
    thickness: f64,
    sources: Vec<&'a Face>,
    basis: ProposalBasis,
}

fn draft(body: Body, faces: &[Face], levels: &[Level], params: &Params) -> Draft {
    let u = along(body.n);
    let at = |s: f64| [body.n[0] * body.axis_offset + u[0] * s, body.n[1] * body.axis_offset + u[1] * s];
    let middle = at((body.span.0 + body.span.1) / 2.);
    let margin = params.snap + params.max_thickness;
    let bottom = snap_to(levels, faces, Role::Floor, middle, body.z.0, params.snap, margin);
    let top = snap_to(levels, faces, Role::Ceiling, middle, body.z.1, params.snap, margin);
    let length = body.span.1 - body.span.0;
    let (start, end) = (at(body.span.0), at(body.span.1));
    let (sources, fit) = face_fit(&body.sources);
    let observed = length * (body.z.1 - body.z.0) * body.sources.len() as f64;
    let coverage = if observed > 0. { fit.area_square_metres / observed } else { 0. };
    Draft {
        class: ProposalClass::IfcWall,
        basis: body.basis,
        confidence: confidence(body.basis, fit.rms_metres, coverage),
        sources,
        support: fit.area_square_metres,
        fit,
        geometry: ProposalGeometry::Wall {
            start: [start[0], start[1], bottom],
            end: [end[0], end[1], bottom],
            thickness_metres: body.thickness,
            height_metres: top - bottom,
        },
    }
}

pub(crate) fn propose(
    faces: &[Face],
    vertical: &[usize],
    levels: &[Level],
    interior: V3,
    params: &Params,
    stats: &mut ScanProposalStats,
) -> Vec<Draft> {
    let eligible: Vec<usize> = vertical
        .iter()
        .copied()
        .filter(|&i| {
            let face = &faces[i];
            let (lo, hi) = face.span_along(along(wall_normal(face)));
            let (bottom, top) = face.z_range();
            let ok = hi - lo >= params.min_wall_length && top - bottom >= params.min_wall_height;
            if !ok {
                stats.faces_too_small += 1;
            }
            ok
        })
        .collect();
    let mut pairs: Vec<Pair> = Vec::new();
    for (k, &a) in eligible.iter().enumerate() {
        for &b in &eligible[k + 1..] {
            pairs.extend(pair_of(faces, a, b, params));
        }
    }
    pairs.sort_by(|p, q| p.gap.total_cmp(&q.gap).then(q.overlap.total_cmp(&p.overlap)).then((p.a, p.b).cmp(&(q.a, q.b))));
    let mut used = vec![false; faces.len()];
    let mut drafts = Vec::new();
    for pair in pairs {
        if used[pair.a] || used[pair.b] {
            continue;
        }
        used[pair.a] = true;
        used[pair.b] = true;
        let (fa, fb) = (&faces[pair.a], &faces[pair.b]);
        let n = wall_normal(fa);
        let u = along(n);
        let ((a0, a1), (b0, b1)) = (fa.span_along(u), fb.span_along(u));
        let ((za0, za1), (zb0, zb1)) = (fa.z_range(), fb.z_range());
        let body = Body {
            n,
            axis_offset: (dot(n, fa.centroid) + dot(n, fb.centroid)) / 2.,
            span: (a0.min(b0), a1.max(b1)),
            z: (za0.min(zb0), za1.max(zb1)),
            thickness: pair.gap,
            sources: vec![fa, fb],
            basis: ProposalBasis::PairedFaces,
        };
        drafts.push(draft(body, faces, levels, params));
        stats.paired_walls += 1;
    }
    for &i in &eligible {
        if used[i] {
            continue;
        }
        let face = &faces[i];
        let n = wall_normal(face);
        let observed_side = if face.scanner_facing {
            dot(face.normal, n)
        } else {
            dot(n, sub(interior, face.centroid))
        };
        let body_side = if observed_side < 0. { 1. } else { -1. };
        let t = params.wall_thickness;
        let body = Body {
            n,
            axis_offset: dot(n, face.centroid) + body_side * t / 2.,
            span: face.span_along(along(n)),
            z: face.z_range(),
            thickness: t,
            sources: vec![face],
            basis: ProposalBasis::SingleFace,
        };
        drafts.push(draft(body, faces, levels, params));
        stats.single_face_walls += 1;
    }
    drafts
}
