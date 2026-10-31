// SPDX-License-Identifier: MPL-2.0
//! Pure row arithmetic of the face-set surface slice (#8291).

/// The authored row a persistent face role names, ignoring any band qualifier.
pub(super) fn row_of(role: &str) -> Option<u32> {
    role.split(';').next()?.strip_prefix("row(")?.strip_suffix(')')?.parse().ok()
}

/// Weights of `p` over a planar triangle's corners; `None` for a degenerate triangle.
pub(super) fn barycentric(p: [f64; 3], t: &[[f64; 3]; 3]) -> Option<[f64; 3]> {
    let (a, b, c) = (nalgebra::Vector3::from(t[0]), nalgebra::Vector3::from(t[1]), nalgebra::Vector3::from(t[2]));
    let (e, f, q) = (b - a, c - a, nalgebra::Vector3::from(p) - a);
    let (ee, ef, ff, qe, qf) = (e.dot(&e), e.dot(&f), f.dot(&f), q.dot(&e), q.dot(&f));
    let det = ee * ff - ef * ef;
    if !det.is_finite() || det == 0. { return None; }
    let (v, w) = ((ff * qe - ef * qf) / det, (ee * qf - ef * qe) / det);
    Some([1. - v - w, v, w])
}
