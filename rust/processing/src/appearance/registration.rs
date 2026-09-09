// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//! Bounded proper-rigid Kabsch solve. Held-out observations never enter fitting.
use super::registration_types::*;
use nalgebra::{linalg::SVD, DMatrix, Matrix3, Vector3};
use sha2::{Digest, Sha256};
use std::collections::HashSet;

const ALGORITHM: &str = "ifclite-rigid-correspondence-v1";
const MAX_POINTS: usize = 256;
const MIN_NON_COLLINEARITY: f64 = 1e-10;

fn label(value: &str) -> bool {
    !value.trim().is_empty() && value.len() <= 256 && !value.chars().any(char::is_control)
}
fn validate(r: &ScanRegistrationRequest) -> Result<(), String> {
    for frame in [&r.source_frame, &r.target_frame] {
        if !label(&frame.frame_key)
            || frame.asset_sha256.len() != 64
            || !frame
                .asset_sha256
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        {
            return Err(
                "Registration requires exact frame keys and lowercase SHA-256 asset identities"
                    .into(),
            );
        }
    }
    if r.fit.len() < 3 || r.fit.len() > MAX_POINTS || r.held_out.len() > MAX_POINTS {
        return Err("Registration needs 3–256 fit points and at most 256 held-out points".into());
    }
    let mut ids = HashSet::new();
    let mut source_ids = HashSet::new();
    let mut target_ids = HashSet::new();
    let mut sources = HashSet::new();
    let mut targets = HashSet::new();
    // Canonicalize signed zero so renaming an identical coordinate cannot leak
    // a fitting observation into the check set. Neighborhood overlap is the
    // host's responsibility: this boundary only knows their stable identities.
    let key = |p: [f64; 3]| p.map(|v| if v == 0. { 0 } else { v.to_bits() });
    for p in r.fit.iter().chain(&r.held_out) {
        if !label(&p.id)
            || !label(&p.source_observation)
            || !label(&p.target_feature)
            || !p
                .source
                .iter()
                .chain(&p.target)
                .all(|v| v.is_finite() && v.abs() <= 1e12)
        {
            return Err("Registration needs bounded observation identities and finite coordinates within 1e12 metres".into());
        }
        if !ids.insert(&p.id)
            || !source_ids.insert(&p.source_observation)
            || !target_ids.insert(&p.target_feature)
            || !sources.insert(key(p.source))
            || !targets.insert(key(p.target))
        {
            return Err("Fit and held-out observations must be distinct: duplicate ID, feature or coordinate".into());
        }
    }
    Ok(())
}
fn centroid(points: &[ScanCorrespondence], source: bool) -> Vector3<f64> {
    let point = |p: &ScanCorrespondence| Vector3::from(if source { p.source } else { p.target });
    let anchor = point(&points[0]);
    anchor
        + points
            .iter()
            .map(|p| point(p) - anchor)
            .sum::<Vector3<f64>>()
            / points.len() as f64
}
fn spread(points: &[Vector3<f64>]) -> Result<RegistrationSpread, String> {
    // Avoid nalgebra's specialized Matrix3 SVD: it squares the matrix and loses
    // small singular directions in thin, but accepted, correspondence sets.
    // Dynamic dimensions select the direct bidiagonal algorithm instead.
    let scatter = points
        .iter()
        .fold(Matrix3::zeros(), |sum, p| sum + p * p.transpose());
    let values = SVD::try_new(
        DMatrix::from_column_slice(3, 3, scatter.as_slice()),
        false,
        false,
        f64::EPSILON,
        128,
    )
    .ok_or("Registration scatter decomposition did not converge within its budget")?
    .singular_values;
    if !values.iter().all(|v| v.is_finite())
        || values[0] <= 0.
        || values[1] / values[0] < MIN_NON_COLLINEARITY
    {
        return Err(
            "Degenerate registration: fitting points coincide or are effectively collinear".into(),
        );
    }
    Ok(RegistrationSpread {
        singular_values: std::array::from_fn(|i| values[i]),
        non_collinearity_ratio: values[1] / values[0],
        non_planarity_ratio: values[2] / values[0],
    })
}
fn residuals(
    points: &[ScanCorrespondence],
    rotation: &Matrix3<f64>,
    source: Vector3<f64>,
    target: Vector3<f64>,
) -> RegistrationResiduals {
    let points: Vec<_> = points
        .iter()
        .map(|p| {
            let error =
                target + rotation * (Vector3::from(p.source) - source) - Vector3::from(p.target);
            CorrespondenceResidual {
                id: p.id.clone(),
                vector_metres: error.into(),
                distance_metres: error.norm(),
            }
        })
        .collect();
    let rms_metres = (!points.is_empty()).then(|| {
        (points
            .iter()
            .map(|p| p.distance_metres.powi(2))
            .sum::<f64>()
            / points.len() as f64)
            .sqrt()
    });
    let max_metres = points.iter().map(|p| p.distance_metres).reduce(f64::max);
    RegistrationResiduals {
        points,
        rms_metres,
        max_metres,
    }
}

/// Pure fit in declared metre frames. The host must verify source bytes/frame
/// revisions before using this report and must not promote it to an accuracy
/// verdict without independently selected and spatially distributed checks.
pub fn register_scan_correspondences(
    r: &ScanRegistrationRequest,
) -> Result<ScanRegistrationReport, String> {
    validate(r)?;
    let source_anchor = centroid(&r.fit, true);
    let target_anchor = centroid(&r.fit, false);
    let sources: Vec<_> = r
        .fit
        .iter()
        .map(|p| Vector3::from(p.source) - source_anchor)
        .collect();
    let targets: Vec<_> = r
        .fit
        .iter()
        .map(|p| Vector3::from(p.target) - target_anchor)
        .collect();
    let source_spread = spread(&sources)?;
    let target_spread = spread(&targets)?;
    let covariance = sources
        .iter()
        .zip(&targets)
        .fold(Matrix3::zeros(), |sum, (s, t)| sum + s * t.transpose());
    let svd = SVD::try_new(
        DMatrix::from_column_slice(3, 3, covariance.as_slice()),
        true,
        true,
        f64::EPSILON,
        128,
    )
    .ok_or("Registration rotation decomposition did not converge within its budget")?;
    if svd.singular_values[0] <= 0.
        || svd.singular_values[1] / svd.singular_values[0] < MIN_NON_COLLINEARITY
    {
        return Err(
            "Degenerate registration: correspondence covariance cannot constrain a unique rotation"
                .into(),
        );
    }
    let dynamic_u = svd.u.ok_or("Registration SVD omitted source basis")?;
    let u = Matrix3::from_column_slice(dynamic_u.as_slice());
    let dynamic_vt = svd
        .v_t
        .ok_or("Registration SVD omitted destination basis")?;
    let v = Matrix3::from_column_slice(dynamic_vt.as_slice()).transpose();
    let mut correction = Matrix3::identity();
    correction[(2, 2)] = (v * u.transpose()).determinant().signum();
    let rotation = v * correction * u.transpose();
    if !rotation.iter().all(|v| v.is_finite()) || (rotation.determinant() - 1.).abs() > 1e-10 {
        return Err("Registration could not produce a finite proper rotation".into());
    }
    let mut digest = Sha256::new();
    digest.update(ALGORITHM.as_bytes());
    digest.update([0]);
    digest.update(
        serde_json::to_vec(r).map_err(|e| format!("Cannot bind registration request: {e}"))?,
    );
    let mut diagnostics =
        vec!["Mathematical rigid fit only; no automatic registration or accuracy approval".into()];
    if r.held_out.is_empty() {
        diagnostics.push("No held-out evidence supplied".into());
    }
    if r.fit.len() < 4 || r.held_out.len() < 4 {
        diagnostics.push("F4 acceptance requires at least four fitting and four independently selected, spatially distributed checks".into());
    }
    if source_spread.non_planarity_ratio < 1e-10 || target_spread.non_planarity_ratio < 1e-10 {
        diagnostics.push("Planar non-collinear fitting points are valid; check coverage at different heights separately".into());
    }
    if correction[(2, 2)] < 0. && svd.singular_values[2] / svd.singular_values[0] > 1e-10 {
        diagnostics.push("Unconstrained solution would reflect; proper rotation retained and mismatch remains in residuals".into());
    }
    Ok(ScanRegistrationReport {
        request_sha256: format!("{:x}", digest.finalize()),
        algorithm: ALGORITHM.into(),
        source_frame: r.source_frame.clone(),
        target_frame: r.target_frame.clone(),
        rotation: std::array::from_fn(|i| std::array::from_fn(|j| rotation[(i, j)])),
        source_anchor: source_anchor.into(),
        target_anchor: target_anchor.into(),
        fit: residuals(&r.fit, &rotation, source_anchor, target_anchor),
        held_out: residuals(&r.held_out, &rotation, source_anchor, target_anchor),
        source_spread,
        target_spread,
        diagnostics,
    })
}

#[cfg(test)]
#[path = "registration_tests.rs"]
mod tests;
