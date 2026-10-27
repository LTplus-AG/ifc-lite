// SPDX-License-Identifier: MPL-2.0
//! Shared numerical frame admission for native and browser retained executors.
//! These checks grant no object authority and do not evaluate geometry.

use crate::math::tol::RETAINED_DEPENDENCY_RIGID_EPS;

/// Proper rigid check mirroring the adapter's admission: finite, bottom row
/// (0,0,0,1), orthonormal right-handed rotation.
pub(crate) fn rigid(m: [f64; 16]) -> Result<(), &'static str> {
    let valid = m.iter().all(|v| v.is_finite())
        && m[3] == 0.
        && m[7] == 0.
        && m[11] == 0.
        && m[15] == 1.
        && (0..3).all(|i| {
            (0..3).all(|j| {
                let dot: f64 = (0..3).map(|k| m[i * 4 + k] * m[j * 4 + k]).sum();
                (dot - if i == j { 1. } else { 0. }).abs() <= RETAINED_DEPENDENCY_RIGID_EPS
            })
        });
    let cross = [
        m[1] * m[6] - m[2] * m[5],
        m[2] * m[4] - m[0] * m[6],
        m[0] * m[5] - m[1] * m[4],
    ];
    if valid && (0..3).all(|i| (cross[i] - m[8 + i]).abs() <= RETAINED_DEPENDENCY_RIGID_EPS) {
        Ok(())
    } else {
        Err("transform must be a proper rigid metre frame")
    }
}

/// Column-major 4x4 product `a * b`.
pub(crate) fn multiply(a: [f64; 16], b: [f64; 16]) -> [f64; 16] {
    std::array::from_fn(|i| (0..4).map(|k| a[k * 4 + i % 4] * b[i / 4 * 4 + k]).sum())
}

/// `inverse(a) * b` for proper rigid frames. Translations are subtracted
/// before rotating, so survey-scale origins cancel in f64.
pub(crate) fn relative(a: [f64; 16], b: [f64; 16]) -> Result<[f64; 16], &'static str> {
    rigid(a)?;
    rigid(b)?;
    let mut out = [0.; 16];
    out[15] = 1.;
    for col in 0..3 {
        for row in 0..3 {
            out[col * 4 + row] = (0..3).map(|k| a[row * 4 + k] * b[col * 4 + k]).sum();
        }
    }
    for row in 0..3 {
        out[12 + row] = (0..3)
            .map(|k| a[row * 4 + k] * (b[12 + k] - a[12 + k]))
            .sum();
    }
    rigid(out)?;
    Ok(out)
}

/// Cheap admission before dispatch. The adapter's SVD enforces the singular
/// value, conditioning and reconstruction policy.
pub(crate) fn validate_affine(m: &[f64; 16]) -> Result<(), &'static str> {
    if !m.iter().all(|x| x.is_finite() && x.abs() <= 1e9)
        || m[3] != 0.
        || m[7] != 0.
        || m[11] != 0.
        || m[15] != 1.
    {
        return Err("expected a finite bounded affine matrix");
    }
    let det = m[0] * (m[5] * m[10] - m[9] * m[6]) - m[4] * (m[1] * m[10] - m[9] * m[2])
        + m[8] * (m[1] * m[6] - m[5] * m[2]);
    if det == 0. {
        return Err("singular affine matrix");
    }
    Ok(())
}

#[cfg(test)]
#[path = "retained_frames_tests.rs"]
mod tests;
