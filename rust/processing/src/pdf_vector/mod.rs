// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//! Bounded graphics-state preparation for the pinned PDF.js adapter, producing
//! the convertible path subset and a page-level fidelity report. This does not
//! authorize geometry. The explicit annotation planner separately composes
//! qualified fills and bounded solid straight stroke outlines.
pub(crate) mod fills;
mod fill_paths;
mod curve_hulls;
mod extent;
mod flatten;
mod interpret;
mod report;
mod strokes;
mod stroke_topology;
mod types;
use sha2::{Digest, Sha256};
pub use report::{FidelityReport, Omission, OmissionSummary, FIDELITY_ALGORITHM, MAX_LISTED_OMISSIONS};
pub use types::*;

const ALGORITHM: &str = "ifclite-pdf-vector-state-v1";
const MAX_OPERATIONS: usize = 100_000;

/// Input identity is host-verified: native code receives decoded operations, not
/// raw PDF bytes. Invalid structure/budget refuses atomically. Content the planner
/// cannot convert is never dropped silently: it is reported with page extent and
/// visibility, and `fidelity.exact` is false whenever any of it is visible.
pub fn prepare_pdf_vector_page(page: &PdfVectorPage) -> Result<PreparedPdfVectorPage, String> {
    validate_page(page)?;
    let interpreted = interpret::run(page)?;
    let mut hash = Sha256::new();
    hash.update(ALGORITHM.as_bytes());
    hash.update(serde_json::to_vec(page).map_err(|e| format!("Cannot bind PDF request: {e}"))?);
    let request_sha256 = format!("{:x}", hash.finalize());
    let fidelity = interpreted.report.finish(&request_sha256, interpreted.paths.len());
    Ok(PreparedPdfVectorPage {
        request_sha256,
        algorithm: ALGORITHM.into(),
        pdf_sha256: page.pdf_sha256.clone(),
        page_number: page.page_number,
        calibration_key: page.calibration_key.clone(),
        tolerance_metres: page.tolerance_metres,
        page_clip_pdf: page.view_box,
        paths: interpreted.paths,
        fidelity,
    })
}

fn validate_page(page: &PdfVectorPage) -> Result<(), String> {
    if page.pdf_sha256.len() != 64
        || !page
            .pdf_sha256
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err("PDF source identity must be a lowercase SHA-256".into());
    }
    if page.decoder_version != "6.3.289" {
        return Err("Unqualified PDF decoder version".into());
    }
    if page.page_number == 0 || page.page_number > 2000 {
        return Err("Invalid PDF page number".into());
    }
    if page.operations.len() > MAX_OPERATIONS {
        return Err("PDF page exceeds 100000 operations".into());
    }
    if page.calibration_key.is_empty() || page.calibration_key.len() > 256 {
        return Err("PDF calibration identity is missing or too long".into());
    }
    for x in page.view_box {
        scalar(x, -1e9, 1e9)?;
    }
    if page.view_box[0] >= page.view_box[2] || page.view_box[1] >= page.view_box[3] {
        return Err("Invalid PDF CropBox".into());
    }
    scalar(page.user_unit, f64::MIN_POSITIVE, 75000.)?;
    if ![0, 90, 180, 270].contains(&page.intrinsic_rotation) {
        return Err("Invalid PDF rotation".into());
    }
    scalar(page.tolerance_metres, 1e-9, 1.)?;
    validate_matrix(&page.model_metres_from_pdf)
}

pub(super) fn scalar(x: f64, min: f64, max: f64) -> Result<(), String> {
    if !x.is_finite() || x < min || x > max {
        Err("PDF numeric value is invalid or exceeds bounds".into())
    } else {
        Ok(())
    }
}
fn validate_rgb(rgb: &[f64; 3]) -> Result<(), String> {
    for x in rgb {
        scalar(*x, 0., 1.)?;
    }
    Ok(())
}
fn validate_matrix(m: &[f64; 6]) -> Result<(), String> {
    for x in m {
        scalar(*x, -1e12, 1e12)?;
    }
    let determinant = m[0] * m[3] - m[1] * m[2];
    if !determinant.is_finite() || determinant == 0. {
        return Err("PDF transform is singular".into());
    }
    Ok(())
}
fn multiply(a: &[f64; 6], b: &[f64; 6]) -> [f64; 6] {
    [
        a[0] * b[0] + a[2] * b[1],
        a[1] * b[0] + a[3] * b[1],
        a[0] * b[2] + a[2] * b[3],
        a[1] * b[2] + a[3] * b[3],
        a[0] * b[4] + a[2] * b[5] + a[4],
        a[1] * b[4] + a[3] * b[5] + a[5],
    ]
}
fn validate_path(commands: &[f64]) -> Result<(), String> {
    let mut cursor = 0;
    let mut has_current = false;
    while cursor < commands.len() {
        let command = commands[cursor];
        let arity = match command {
            0. | 1. => 2,
            2. => 6,
            3. => 4,
            4. => 0,
            _ => return Err("Unknown PDF DrawOPS command".into()),
        };
        if command != 0. && !has_current {
            return Err("PDF path command has no current point".into());
        }
        if command == 0. {
            has_current = true;
        }
        cursor += 1;
        let values = commands
            .get(cursor..cursor + arity)
            .ok_or("Truncated PDF path command")?;
        for x in values {
            scalar(*x, -1e9, 1e9)?;
        }
        cursor += arity;
    }
    Ok(())
}

#[cfg(test)]
#[path = "tests.rs"]
mod tests;
#[cfg(test)]
#[path = "report_tests.rs"]
mod report_tests;
