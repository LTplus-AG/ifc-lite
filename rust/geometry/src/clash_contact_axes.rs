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

/// Tolerance for "these three families are mutually perpendicular".
///
/// [`Mesh::positions`] is **f32**, so a face normal reconstructed from a
/// tessellated box's edge vectors carries ~1e-6 rad of round-off, which a
/// 1e-6 dot-product test would reject — and a rejection here silently drops
/// back to the world axes, i.e. back to the very bug this machinery exists to
/// fix. 1e-4 (0.006 rad) admits that round-off while still rejecting a
/// genuinely non-orthogonal frame; the axes are only ever used as *directions
/// to measure an extent along*, where a 0.006 rad error is worth ~2e-5 of the
/// extent.
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

/// Reject only a truly degenerate (zero-length or non-finite) vector — not a
/// scale-dependent magnitude threshold. `v` is a cross product of edge
/// vectors reconstructed from f32 mesh positions, so its length scales with
/// the *square* of the operand's own dimensions: a fixed absolute epsilon
/// here would silently drop every face-normal candidate for any operand
/// small enough that its triangle areas fall under that epsilon, collapsing
/// `orthogonal_face_axes` back to `None` (i.e. the world-axes-only fallback)
/// for small but perfectly valid box operands.
///
/// This function alone cannot distinguish "small but valid" from "sliver
/// noise" — both produce a small `len`, and length is exactly what scales
/// with the operand's own dimensions. That distinction needs the *relative*
/// test in [`face_normal`], which is why every caller that reconstructs a
/// face normal from triangle vertices goes through `face_normal`, not this
/// function directly. `normalize3` stays a plain building block, used
/// directly only where the input is already scale-free (e.g. crossing two
/// unit face-normal candidates in [`gate_axes`]).
fn normalize3(v: [f64; 3]) -> Option<[f64; 3]> {
    let len = dot3(v, v).sqrt();
    if !(len.is_finite()) || len == 0.0 {
        return None;
    }
    Some([v[0] / len, v[1] / len, v[2] / len])
}

/// Minimum `sin(θ)` between a triangle's two edges at the vertex the normal
/// is computed from, where θ is that triangle's interior angle there — a
/// **dimensionless** ratio (`|edge1 × edge2| / (|edge1| · |edge2|)`), not the
/// raw cross-product magnitude. A 1 mm box corner and a 100 m wall corner are
/// both right angles, θ = 90°, sin θ = 1, so this judges them identically —
/// which a length-based cutoff on the cross product cannot do, since that
/// magnitude scales with the *square* of the operand's own dimensions.
///
/// `Mesh::positions` is f32 (~1.2e-7 relative precision), so vertices
/// reconstructed from it carry noise of roughly that order. A genuinely
/// degenerate or near-collinear triangle (three points nearly on a line —
/// e.g. a stray sliver a tessellator emits alongside real box faces)
/// produces sin θ at or below that noise floor; its direction is unrelated
/// to any real geometric feature, verified by construction to swing across
/// dot products of −0.95 to 0.55 against the true face normal for sin θ in
/// the 1e-8 range. `1e-3` (θ ≈ 0.057°) sits three orders of magnitude above
/// that ~1e-7 noise floor while a genuine box-corner triangle sits at
/// sin θ = 1, eight orders of magnitude above the cutoff — so the cutoff
/// rejects noise with a wide margin on both sides regardless of the
/// operand's absolute size.
///
/// Rejected alternatives:
/// - An absolute length threshold on the cross product (the original bug):
///   fails exactly because it is not scale-free.
/// - No threshold at all (this file's prior state): admits ULP-noise
///   directions as described above.
/// - A threshold on the angle itself (`asin`/`acos`) instead of on sin θ:
///   equivalent near this range but costs an extra transcendental call for
///   no precision benefit this close to zero, where sin θ ≈ θ.
const MIN_SIN_THETA: f64 = 1.0e-3;

/// The unit normal of the triangle `(a, b, c)`, or `None` when the triangle
/// is degenerate (zero-length edge, non-finite input) or a sliver relative to
/// its own edge lengths (see [`MIN_SIN_THETA`]).
fn face_normal(a: [f64; 3], b: [f64; 3], c: [f64; 3]) -> Option<[f64; 3]> {
    let e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    let e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    let e1_len = dot3(e1, e1).sqrt();
    let e2_len = dot3(e2, e2).sqrt();
    if !(e1_len.is_finite() && e2_len.is_finite()) || e1_len == 0.0 || e2_len == 0.0 {
        return None;
    }
    let cross = cross3(e1, e2);
    let cross_len = dot3(cross, cross).sqrt();
    if !cross_len.is_finite() || cross_len == 0.0 {
        return None;
    }
    let sin_theta = cross_len / (e1_len * e2_len);
    if !sin_theta.is_finite() || sin_theta < MIN_SIN_THETA {
        return None;
    }
    Some([cross[0] / cross_len, cross[1] / cross_len, cross[2] / cross_len])
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
        let n = match face_normal(a, b, c) {
            Some(n) => n,
            // Degenerate or sliver triangle: carries no face-normal evidence
            // either way.
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

#[cfg(test)]
mod tests {
    use super::*;

    /// A closed axis-aligned box, 12 triangles over 8 vertices, centered at
    /// `center` with half-extents `half`. Winding is not made consistent
    /// (mixed CW/CCW across faces) because `orthogonal_face_axes` canonicalizes
    /// every normal before grouping, so the sign of a raw cross product never
    /// matters here — only its direction family.
    fn box_mesh(center: [f64; 3], half: [f64; 3]) -> Mesh {
        let (cx, cy, cz) = (center[0], center[1], center[2]);
        let (hx, hy, hz) = (half[0], half[1], half[2]);
        let verts: [[f64; 3]; 8] = [
            [cx - hx, cy - hy, cz - hz],
            [cx + hx, cy - hy, cz - hz],
            [cx + hx, cy + hy, cz - hz],
            [cx - hx, cy + hy, cz - hz],
            [cx - hx, cy - hy, cz + hz],
            [cx + hx, cy - hy, cz + hz],
            [cx + hx, cy + hy, cz + hz],
            [cx - hx, cy + hy, cz + hz],
        ];
        let mut m = Mesh::new();
        for v in verts {
            m.positions.push(v[0] as f32);
            m.positions.push(v[1] as f32);
            m.positions.push(v[2] as f32);
        }
        m.indices = vec![
            0, 1, 2, 0, 2, 3, // -z
            4, 5, 6, 4, 6, 7, // +z
            0, 1, 5, 0, 5, 4, // -y
            3, 2, 6, 3, 6, 7, // +y
            0, 4, 7, 0, 7, 3, // -x
            1, 5, 6, 1, 6, 2, // +x
        ];
        m
    }

    /// Append an extra, non-degenerate but numerically-thin "sliver" triangle
    /// to `m`: three points that are almost — but not exactly — collinear
    /// (`c` sits 0.001 off being exactly `a + 2*(b - a)`). Its cross-product
    /// magnitude (~4.2e-3, asserted in `sliver_fixture_is_actually_a_sliver`
    /// below) is small only *relative to its own edge lengths*: sin θ ≈
    /// 7.9e-5, well under [`MIN_SIN_THETA`], while its raw magnitude is far
    /// above the old `AXIS_EPS = 1e-6` absolute cutoff — the fixture is
    /// deliberately NOT a small-magnitude edge case, so it isolates the
    /// relative-vs-absolute distinction the fix makes. `a`, `b`, `c` sit at
    /// ordinary building-scale coordinates (tens of metres), not near the
    /// origin, so this is not a small-operand effect — it is a stray sliver
    /// triangle incidentally present in an otherwise ordinary mesh (the kind
    /// a tessellator can emit alongside real box faces).
    fn push_sliver_triangle(m: &mut Mesh) {
        let a = [50.0_f64, 60.0, 12.5];
        let b = [53.0_f64, 63.0, 15.5]; // a + (3, 3, 3)
        let c = [56.0_f64, 66.0, 18.501]; // a + (6, 6, 6.001): nearly 2*(b-a)
        let base = (m.positions.len() / 3) as u32;
        for v in [a, b, c] {
            m.positions.push(v[0] as f32);
            m.positions.push(v[1] as f32);
            m.positions.push(v[2] as f32);
        }
        m.indices.extend_from_slice(&[base, base + 1, base + 2]);
    }

    /// Sanity check on the fixture itself: the sliver triangle's sin θ and
    /// cross-product magnitude really do land in the ranges the doc comments
    /// claim, so the two tests below are exercising the intended regime.
    #[test]
    fn sliver_fixture_is_actually_a_sliver() {
        let a = [50.0_f64, 60.0, 12.5];
        let b = [53.0_f64, 63.0, 15.5];
        let c = [56.0_f64, 66.0, 18.501];
        let e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
        let e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
        let cross = cross3(e1, e2);
        let cross_len = dot3(cross, cross).sqrt();
        let sin_theta = cross_len / (dot3(e1, e1).sqrt() * dot3(e2, e2).sqrt());
        assert!(
            cross_len > 0.0 && cross_len < 1e-2,
            "cross magnitude out of the intended sliver range: {cross_len}"
        );
        assert!(
            sin_theta < MIN_SIN_THETA,
            "sin theta {sin_theta} is not below MIN_SIN_THETA — fixture is not a sliver"
        );
        assert!(
            face_normal(a, b, c).is_none(),
            "face_normal should reject this sliver"
        );
    }

    /// A box with sub-millimetre edges must still yield 3 orthogonal face
    /// axes. This is exactly what the original `AXIS_EPS = 1e-6` absolute
    /// threshold on the cross-product magnitude broke: a 0.4 mm half-extent
    /// box's corner triangles have cross-product magnitude ~1.6e-7, under
    /// that fixed cutoff, so every face normal was dropped and
    /// `orthogonal_face_axes` fell back to `None`. The sin-θ based test in
    /// `face_normal` is scale-free — a right-angle corner has sin θ = 1
    /// regardless of the operand's absolute size — so this must return
    /// `Some` with 3 mutually perpendicular axes.
    #[test]
    fn small_box_yields_three_orthogonal_axes() {
        let m = box_mesh([0.0, 0.0, 0.0], [0.0002, 0.0002, 0.0002]);
        let axes = orthogonal_face_axes(&m);
        assert!(
            axes.is_some(),
            "sub-millimetre box should still yield 3 orthogonal face axes"
        );
        let axes = axes.unwrap();
        for i in 0..3 {
            for j in (i + 1)..3 {
                assert!(
                    dot3(axes[i], axes[j]).abs() <= ORTHO_EPS,
                    "axes {i} and {j} are not orthogonal: dot = {}",
                    dot3(axes[i], axes[j])
                );
            }
        }
    }

    /// An ordinary (building-scale, non-degenerate) box mesh that also
    /// happens to carry one incidental near-degenerate sliver triangle must
    /// still yield the box's 3 real orthogonal face axes — the sliver must
    /// be excluded, not counted as a spurious 4th direction family. This is
    /// exactly what the threshold-free `normalize3` (checking only
    /// zero-length/non-finite) got wrong: the sliver's direction is
    /// finite and nonzero, so it passed through and `orthogonal_face_axes`
    /// saw 4 families and returned `None` for a mesh that should qualify.
    #[test]
    fn sliver_triangle_does_not_displace_real_box_axes() {
        let mut m = box_mesh([1000.0, 500.0, 20.0], [2.0, 1.5, 1.0]);
        push_sliver_triangle(&mut m);
        let axes = orthogonal_face_axes(&m);
        assert!(
            axes.is_some(),
            "an incidental sliver triangle must not turn a valid box mesh into None"
        );
        let axes = axes.unwrap();
        for i in 0..3 {
            for j in (i + 1)..3 {
                assert!(
                    dot3(axes[i], axes[j]).abs() <= ORTHO_EPS,
                    "axes {i} and {j} are not orthogonal: dot = {}",
                    dot3(axes[i], axes[j])
                );
            }
        }
    }
}
