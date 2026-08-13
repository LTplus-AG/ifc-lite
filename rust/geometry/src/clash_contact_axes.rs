// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Which DIRECTIONS the [`clash_solid`](crate::clash_solid) trust gate measures
//! the intersection's thickness along.
//!
//! Split out of `clash_solid.rs` to keep that module inside the repository's
//! 400-line ceiling; it is one cohesive question — "what could the contact
//! normal of this pair be?" — and the gate itself is the only caller.
//!
//! The short version, in full in [`gate_axes`]: the world axes are always in
//! the set, and when both operands present a box frame the classical 15 OBB
//! separating-axis candidates join them. Because the gate takes the MINIMUM
//! extent over the set, adding an axis can only tighten it.

use crate::mesh::Mesh;

/// Tolerance for collapsing per-triangle face normals into direction families.
/// Same literal as the sibling OBB kernel's `OBB_EPS` (`rust/clash/src/obb.rs`,
/// `packages/clash/src/engine-ts/obb.ts`), which certifies boxes the same way.
const AXIS_EPS: f64 = 1.0e-6;

/// Tolerance for "these three families are mutually perpendicular".
///
/// Deliberately looser than [`AXIS_EPS`]: [`Mesh::positions`] is **f32**, so a
/// face normal reconstructed from a tessellated box's edge vectors carries
/// ~1e-6 rad of round-off, which a 1e-6 dot-product test would reject — and a
/// rejection here silently drops back to the world axes, i.e. back to the very
/// bug this machinery exists to fix. 1e-4 (0.006 rad) admits that round-off
/// while still rejecting a genuinely non-orthogonal frame; the axes are only
/// ever used as *directions to measure an extent along*, where a 0.006 rad
/// error is worth ~2e-5 of the extent.
const ORTHO_EPS: f64 = 1.0e-4;

/// Flip `n` so its largest-magnitude component is positive, collapsing a face
/// and its antipodal opposite onto one canonical direction. Ties break x, y, z.
/// Same rule as the sibling OBB kernel's `canonical`.
pub(crate) fn canonical(n: [f64; 3]) -> [f64; 3] {
    let (ax, ay, az) = (n[0].abs(), n[1].abs(), n[2].abs());
    let mut idx = 0usize;
    if ay > ax && ay >= az {
        idx = 1;
    } else if az > ax && az > ay {
        idx = 2;
    }
    if n[idx] < 0.0 {
        [-n[0], -n[1], -n[2]]
    } else {
        n
    }
}

pub(crate) fn dot3(a: [f64; 3], b: [f64; 3]) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

fn cross3(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ]
}

fn normalize3(v: [f64; 3]) -> Option<[f64; 3]> {
    let len = dot3(v, v).sqrt();
    if !(len > AXIS_EPS) {
        return None;
    }
    Some([v[0] / len, v[1] / len, v[2] / len])
}

/// The three mutually perpendicular face-normal directions of a box-shaped
/// operand, or `None` when the mesh's faces do not fall into exactly three such
/// families.
///
/// This is the *direction* half of the sibling PR's `detect_obb` and nothing
/// more: the gate below needs candidate contact normals, not a certified box,
/// so the offset-plane and positive-extent checks that `detect_obb` performs to
/// justify a *penetration depth* are not needed here — an operand whose faces
/// span three orthogonal directions contributes exactly those three candidate
/// normals whether or not it is a closed rectangular box, and a wrong guess
/// costs nothing but a redundant axis (see `gate_axes`).
fn orthogonal_face_axes(m: &Mesh) -> Option<[[f64; 3]; 3]> {
    let mut groups: Vec<[f64; 3]> = Vec::with_capacity(3);
    let vert = |i: u32| -> [f64; 3] {
        let o = (i as usize) * 3;
        [
            m.positions[o] as f64,
            m.positions[o + 1] as f64,
            m.positions[o + 2] as f64,
        ]
    };
    for t in m.indices.chunks_exact(3) {
        let (a, b, c) = (vert(t[0]), vert(t[1]), vert(t[2]));
        let n = match normalize3(cross3(
            [b[0] - a[0], b[1] - a[1], b[2] - a[2]],
            [c[0] - a[0], c[1] - a[1], c[2] - a[2]],
        )) {
            Some(n) => n,
            // Degenerate triangle: carries no face-normal evidence either way.
            None => continue,
        };
        let cn = canonical(n);
        if groups.iter().any(|g| dot3(*g, cn) > 1.0 - ORTHO_EPS) {
            continue;
        }
        if groups.len() >= 3 {
            return None; // a fourth direction family: not a box frame
        }
        groups.push(cn);
    }
    if groups.len() != 3 {
        return None;
    }
    for i in 0..3 {
        for j in (i + 1)..3 {
            if dot3(groups[i], groups[j]).abs() > ORTHO_EPS {
                return None;
            }
        }
    }
    Some([groups[0], groups[1], groups[2]])
}

/// Unit directions the thickness is measured along.
///
/// Always the three world axes — that is the historical behaviour and it is the
/// floor, never the ceiling: the thickness below is the MINIMUM extent over
/// this set, so every extra axis can only *lower* the measured thickness and
/// therefore only ever tightens the gate. Adding an axis can withhold a solid
/// that used to be returned; it can never admit one that used to be withheld.
///
/// When BOTH operands present a box frame, the set also carries the classical
/// 15 OBB separating-axis candidates (each operand's three face normals plus
/// their nine pairwise cross products). The true contact normal of a box-box
/// overlap is one of those 15 — analytically, from the operands' own face
/// planes — so for a rotated contact the minimum lands on the real penetration
/// direction instead of on whichever world axis the wedge happens to be
/// thinnest along.
///
/// For a non-box operand the set stays the three world axes. That is
/// **conservative, not correct**: a rotated contact between two general meshes
/// is still measured against the world frame and its thickness can still be
/// overstated. Closing that needs a real contact-normal estimator over the
/// original operand faces; this function deliberately does not improvise one.
pub(crate) fn gate_axes(a: &Mesh, b: &Mesh) -> Vec<[f64; 3]> {
    let mut axes: Vec<[f64; 3]> = vec![[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]];
    let (Some(fa), Some(fb)) = (orthogonal_face_axes(a), orthogonal_face_axes(b)) else {
        return axes;
    };
    axes.extend_from_slice(&fa);
    axes.extend_from_slice(&fb);
    for u in &fa {
        for v in &fb {
            // Parallel axes cross to zero — not a separating-axis candidate.
            if let Some(n) = normalize3(cross3(*u, *v)) {
                axes.push(n);
            }
        }
    }
    axes
}
