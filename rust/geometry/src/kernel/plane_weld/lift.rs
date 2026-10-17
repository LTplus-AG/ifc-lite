// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! The exact on-plane lift of [`super::promote_cutter_verts_onto_host_faces`],
//! moved out of `plane_weld.rs` unchanged to keep that module inside its size
//! budget.

use super::Tri;

/// Weld `v` onto the plane of the (snap-grid) host triangle `(t0,t1,t2)` such
/// that the result is EXACTLY on that plane and EXACTLY representable in f64.
///
/// The foot is solved in the triangle's edge basis (Gram system over `u=t1−t0`,
/// `w=t2−t0`), then α,β are quantized to the 2⁻²⁰ grid and the point
/// `t0 + α·u + β·w` is recombined in INTEGER arithmetic on the 2⁻³⁶ grid
/// (operands are k/2¹⁶ ⇒ α·u terms are k/2³⁶ exactly). Any α,β on that grid
/// yields a point mathematically ON the plane; the only requirement is that the
/// f64 result is exact, which the i128 round-trip check enforces (and which
/// bounds every magnitude case — huge georef coords simply fail the check and
/// skip the weld). The in-plane quantization shift is ≤ edge·2⁻²⁰ (µm). The
/// f64 Gram solve itself may round — harmless, it only picks WHICH on-grid
/// (α,β) is used. |α|,|β| ≤ 8 bounds the integer products (the perpendicular
/// foot of a band-near vertex is always within a few edge lengths; anything
/// farther is a degenerate sliver basis we refuse to weld with).
///
/// DETERMINISM: FMA-free f64 + integer ops, fixed iteration order ⇒
/// byte-identical native==wasm.
pub(super) fn exact_on_plane_weld(v: [f64; 3], [t0, t1, t2]: Tri) -> Option<[f64; 3]> {
    const Q: f64 = 1_048_576.0; // 2^20 — α,β quantization
    const S16: f64 = 65_536.0; // the operand snap grid (1/SNAP_GRID)
    const S36: f64 = 68_719_476_736.0; // 2^36 = S16 · Q — the welded-vertex grid
    let u = [t1[0] - t0[0], t1[1] - t0[1], t1[2] - t0[2]];
    let w = [t2[0] - t0[0], t2[1] - t0[1], t2[2] - t0[2]];
    let p = [v[0] - t0[0], v[1] - t0[1], v[2] - t0[2]];
    let dot = |a: &[f64; 3], b: &[f64; 3]| a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    let (uu, ww, uw) = (dot(&u, &u), dot(&w, &w), dot(&u, &w));
    let (pu, pw) = (dot(&p, &u), dot(&p, &w));
    let det = uu * ww - uw * uw;
    if det == 0.0 || !det.is_finite() {
        return None; // degenerate (collinear) edge basis
    }
    let alpha = ((ww * pu - uw * pw) / det * Q).round();
    let beta = ((uu * pw - uw * pu) / det * Q).round();
    if !alpha.is_finite() || !beta.is_finite() || alpha.abs() > 8.0 * Q || beta.abs() > 8.0 * Q {
        return None;
    }
    let (ai, bi) = (alpha as i128, beta as i128);
    let mut out = [0.0f64; 3];
    for k in 0..3 {
        // scale the on-grid coords to integers (k/2^16 · 2^16); a coordinate
        // off the snap grid (or too large to scale exactly) refuses the weld.
        let (s0, s1, s2) = (t0[k] * S16, t1[k] * S16, t2[k] * S16);
        for s in [s0, s1, s2] {
            if s.fract() != 0.0 || s.abs() >= 9.0e18 {
                return None;
            }
        }
        let (i0, i1, i2) = (s0 as i128, s1 as i128, s2 as i128);
        // the welded coordinate on the 2^-36 grid: t0·2^20 + α·u + β·w
        let r36 = (i0 << 20) + ai * (i1 - i0) + bi * (i2 - i0);
        let rf = r36 as f64;
        if rf as i128 != r36 {
            return None; // not exactly representable in f64 ⇒ skip the weld
        }
        out[k] = rf / S36; // power-of-two divide: exact
    }
    Some(out)
}
