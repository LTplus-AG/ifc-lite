// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! The heading of a resolved placement about the world vertical.

/// The building/site rotation about the world vertical (Z) axis, derived from a
/// resolved **column-major** 4×4 placement matrix (as returned by
/// [`crate::GeometryRouter::resolve_scaled_placement`]). The local X-axis (the
/// placement's RefDirection, composed through the full parent chain and
/// normalized) is column 0 — elements `[0]`, `[1]`, `[2]` — so its angle in the
/// world XY plane is `atan2(m[1], m[0])`.
///
/// This is the single source of truth for site rotation: the processor consumes
/// the full matrix (baking the inverse rotation into vertices for the
/// `site_local` frame) while the viewer takes this angle for its render-frame
/// rotation — both off the *same* resolved matrix, so they cannot drift on
/// nested, scaled, or tilted-axis placements (where `atan2` of the raw
/// top-level RefDirection is incomplete). Returns `None` for a degenerate
/// (zero-length) projected X-axis.
pub fn rotation_angle_about_z(matrix: &[f64; 16]) -> Option<f64> {
    let x = matrix[0];
    let y = matrix[1];
    if x * x + y * y < 1e-10 {
        return None;
    }
    Some(y.atan2(x))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rotation_angle_about_z_handles_identity_rotation_and_scale() {
        // Identity → 0 rad.
        let mut m = [0.0f64; 16];
        m[0] = 1.0;
        m[5] = 1.0;
        m[10] = 1.0;
        m[15] = 1.0;
        assert!(rotation_angle_about_z(&m).unwrap().abs() < 1e-12);

        // 45° about Z: column-0 X-axis = (cos45, sin45, 0). Matches the legacy
        // atan2(RefDirection.y, RefDirection.x) for an axis-aligned placement.
        let a = std::f64::consts::FRAC_PI_4;
        let mut r = [0.0f64; 16];
        r[0] = a.cos();
        r[1] = a.sin();
        r[4] = -a.sin();
        r[5] = a.cos();
        r[10] = 1.0;
        r[15] = 1.0;
        assert!((rotation_angle_about_z(&r).unwrap() - a).abs() < 1e-12);

        // Uniform scale is angle-invariant (resolve_scaled_placement may carry scale).
        let mut s = r;
        for v in s.iter_mut().take(3) {
            *v *= 3.0;
        }
        assert!((rotation_angle_about_z(&s).unwrap() - a).abs() < 1e-9);

        // Degenerate (zero-length) projected X-axis → None.
        assert!(rotation_angle_about_z(&[0.0f64; 16]).is_none());
    }
}
