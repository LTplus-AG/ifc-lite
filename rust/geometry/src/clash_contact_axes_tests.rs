// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Unit tests for [`super`] (clash contact candidate axes). Split into a
//! `*_tests.rs` file (module-size-ratchet exempt) and attached via `#[path]`.

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
