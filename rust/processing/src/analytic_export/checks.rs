// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Source-path geometry checks. These are not fabrication-code checks.

use super::SweptDiskOccurrence;
use ifc_lite_geometry::analytic::{AnalyticCurveSegment, AnalyticStatus};
use serde::Serialize;

/// Tolerances in world metres and radians. All must be finite and nonnegative.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[non_exhaustive]
pub struct SweptDiskCheckOptions {
    /// A segment at or below this centreline length is considered degenerate.
    pub zero_length_tolerance_m: f64,
    /// Consecutive endpoints farther apart than this are disconnected.
    pub gap_tolerance_m: f64,
    /// Consecutive traversal tangents differing by more than this are sharp.
    pub tangent_tolerance_rad: f64,
}

impl Default for SweptDiskCheckOptions {
    fn default() -> Self {
        Self {
            zero_length_tolerance_m: 1e-9,
            gap_tolerance_m: 1e-6,
            tangent_tolerance_rad: 1e-6,
        }
    }
}

impl SweptDiskCheckOptions {
    /// Reject invalid caller input before examining any occurrences.
    pub fn validate(&self) -> Result<(), SweptDiskCheckError> {
        for (name, value) in [
            ("zero_length_tolerance_m", self.zero_length_tolerance_m),
            ("gap_tolerance_m", self.gap_tolerance_m),
            ("tangent_tolerance_rad", self.tangent_tolerance_rad),
        ] {
            if !value.is_finite() || value < 0.0 {
                return Err(SweptDiskCheckError { option: name });
            }
        }
        Ok(())
    }
}

/// A caller-supplied tolerance is invalid.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub struct SweptDiskCheckError {
    pub option: &'static str,
}

impl std::fmt::Display for SweptDiskCheckError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{} must be finite and nonnegative", self.option)
    }
}

impl std::error::Error for SweptDiskCheckError {}

/// Stable machine-readable source-geometry finding codes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
#[non_exhaustive]
pub enum SweptDiskFindingCode {
    ZeroLengthSegment,
    ConsecutiveGap,
    TangentDiscontinuity,
    ArcRadiusNotGreaterThanDiskRadius,
}

/// One measured source-geometry finding. `next_segment_index` identifies the
/// second side of a join and is absent for a finding on one segment.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[non_exhaustive]
pub struct SweptDiskCheckFinding {
    pub code: SweptDiskFindingCode,
    pub segment_index: usize,
    pub next_segment_index: Option<usize>,
    pub measured: f64,
    pub threshold: f64,
    pub units: &'static str,
}

/// Diagnostic report for the authored source before any enclosing CSG change.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[non_exhaustive]
pub struct SweptDiskCheckReport {
    pub source_modified: bool,
    /// Why no checks ran; absent only for a complete, measurable directrix.
    pub skipped_reason: Option<String>,
    pub findings: Vec<SweptDiskCheckFinding>,
}

fn finding(
    code: SweptDiskFindingCode,
    segment_index: usize,
    next_segment_index: Option<usize>,
    measured: f64,
    threshold: f64,
    units: &'static str,
) -> SweptDiskCheckFinding {
    SweptDiskCheckFinding { code, segment_index, next_segment_index, measured, threshold, units }
}

/// Check an extracted world-space swept disk without decoding or tessellation.
/// Findings concern source geometry only; they do not certify a bar for cutting,
/// bending, material, or building-code compliance.
pub fn check_swept_disk(
    occurrence: &SweptDiskOccurrence,
    options: &SweptDiskCheckOptions,
) -> Result<SweptDiskCheckReport, SweptDiskCheckError> {
    options.validate()?;
    let mut report = SweptDiskCheckReport {
        source_modified: occurrence.source_modified,
        skipped_reason: None,
        findings: Vec::new(),
    };
    if let AnalyticStatus::Unsupported(reason) = &occurrence.status {
        report.skipped_reason = Some(reason.clone());
        return Ok(report);
    }
    if occurrence.directrix.is_empty() {
        report.skipped_reason = Some("directrix has no segments".into());
        return Ok(report);
    }
    let Some(metrics) = occurrence.directrix_metrics() else {
        report.skipped_reason = Some("directrix measurements are unavailable".into());
        return Ok(report);
    };
    if !occurrence.radius.is_finite() || occurrence.radius <= 0.0 {
        report.skipped_reason = Some("world disk radius is invalid".into());
        return Ok(report);
    }
    let mut frames = Vec::with_capacity(occurrence.directrix.len());
    for (index, segment) in occurrence.directrix.iter().enumerate() {
        let Some(frame) = segment.endpoint_frame() else {
            report.skipped_reason = Some(format!("directrix segment {index} has an invalid frame"));
            return Ok(report);
        };
        frames.push(frame);
    }
    for (index, (segment, metric)) in occurrence.directrix.iter().zip(&metrics.segments).enumerate() {
        if metric.length <= options.zero_length_tolerance_m {
            report.findings.push(finding(SweptDiskFindingCode::ZeroLengthSegment,
                index, None, metric.length, options.zero_length_tolerance_m, "m"));
        }
        if let AnalyticCurveSegment::Arc { radius, .. } = segment {
            if *radius <= occurrence.radius {
                report.findings.push(finding(SweptDiskFindingCode::ArcRadiusNotGreaterThanDiskRadius,
                    index, None, *radius, occurrence.radius, "m"));
            }
        }
    }
    for index in 0..frames.len().saturating_sub(1) {
        let left = frames[index];
        let right = frames[index + 1];
        let Some(gap) = left.end.distance_to(right.start) else {
            report.findings.clear();
            report.skipped_reason = Some(format!("join {index} has a non-finite gap"));
            return Ok(report);
        };
        if gap > options.gap_tolerance_m {
            report.findings.push(finding(SweptDiskFindingCode::ConsecutiveGap,
                index, Some(index + 1), gap, options.gap_tolerance_m, "m"));
            continue;
        }
        if let (Some(a), Some(b)) = (left.end_tangent, right.start_tangent) {
            let dot = a.iter().zip(b).map(|(x, y)| x * y).sum::<f64>().clamp(-1.0, 1.0);
            let angle = dot.acos();
            if angle > options.tangent_tolerance_rad {
                report.findings.push(finding(SweptDiskFindingCode::TangentDiscontinuity,
                    index, Some(index + 1), angle, options.tangent_tolerance_rad, "rad"));
            }
        }
    }
    Ok(report)
}
