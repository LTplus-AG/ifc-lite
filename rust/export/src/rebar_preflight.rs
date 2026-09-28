// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Caller-supplied geometric comparisons for represented bar source sweeps.

use ifc_lite_geometry::analytic::{AnalyticCurveSegment, AnalyticStatus};
use ifc_lite_processing::{
    SweptDiskCheckError, SweptDiskCheckReport, SweptDiskFindingCode, SweptDiskOccurrence,
};
use serde::Serialize;

/// Project-specific limits in SI metres. No default fabrication code is implied.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[non_exhaustive]
pub struct RebarPreflightLimits {
    pub min_inside_bend_radius_m: f64,
    pub min_straight_segment_length_m: f64,
    pub max_developed_centreline_length_m: Option<f64>,
}

impl RebarPreflightLimits {
    pub fn new(min_inside_bend_radius_m: f64, min_straight_segment_length_m: f64,
        max_developed_centreline_length_m: Option<f64>) -> Result<Self, RebarPreflightError> {
        let limits = Self { min_inside_bend_radius_m, min_straight_segment_length_m,
            max_developed_centreline_length_m };
        limits.validate()?;
        Ok(limits)
    }

    pub fn validate(&self) -> Result<(), RebarPreflightError> {
        for (name, value) in [
            ("min_inside_bend_radius_m", self.min_inside_bend_radius_m),
            ("min_straight_segment_length_m", self.min_straight_segment_length_m),
        ] {
            if !value.is_finite() || value < 0.0 {
                return Err(RebarPreflightError { option: name });
            }
        }
        if self.max_developed_centreline_length_m.is_some_and(|value| !value.is_finite() || value < 0.0) {
            return Err(RebarPreflightError { option: "max_developed_centreline_length_m" });
        }
        Ok(())
    }
}

/// Invalid caller-supplied fabrication threshold.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RebarPreflightError { pub option: &'static str }

impl std::fmt::Display for RebarPreflightError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{} must be finite and nonnegative", self.option)
    }
}

impl std::error::Error for RebarPreflightError {}

/// Failure to validate caller thresholds or existing sweep-check tolerances.
#[derive(Debug)]
pub enum RebarSchedulePreflightError {
    Limits(RebarPreflightError),
    SweepChecks(SweptDiskCheckError),
}

impl std::fmt::Display for RebarSchedulePreflightError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Limits(error) => error.fmt(f),
            Self::SweepChecks(error) => error.fmt(f),
        }
    }
}

impl std::error::Error for RebarSchedulePreflightError {}

/// One measured comparison. Segment index is absent for the whole directrix.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[non_exhaustive]
pub struct RebarPreflightComparison {
    pub kind: &'static str,
    pub segment_index: Option<usize>,
    pub measured_m: f64,
    pub limit_m: f64,
    pub passed: bool,
}

/// Source geometry assessment. A skipped sweep has no comparisons.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[non_exhaustive]
pub struct RebarPreflightReport {
    pub skipped_reason: Option<String>,
    pub comparisons: Vec<RebarPreflightComparison>,
    /// Requested segment checks for which no matching geometry exists.
    pub unassessed_reasons: Vec<String>,
}

pub(super) fn assess_sweep(
    disk: &SweptDiskOccurrence,
    checks: &SweptDiskCheckReport,
    limits: &RebarPreflightLimits,
) -> RebarPreflightReport {
    let mut report = RebarPreflightReport { skipped_reason: None, comparisons: Vec::new(), unassessed_reasons: Vec::new() };
    if disk.source_modified {
        report.skipped_reason = Some("source is modified by enclosing CSG; finished bar geometry is unavailable".into());
        return report;
    }
    if let AnalyticStatus::Unsupported(reason) = &disk.status {
        report.skipped_reason = Some(format!("unsupported directrix: {reason}"));
        return report;
    }
    if let Some(reason) = &checks.skipped_reason {
        report.skipped_reason = Some(format!("source geometry checks could not run: {reason}"));
        return report;
    }
    if let Some(finding) = checks.findings.iter().find(|finding| matches!(
        finding.code,
        SweptDiskFindingCode::ConsecutiveGap | SweptDiskFindingCode::ZeroLengthSegment
    )) {
        let defect = match finding.code {
            SweptDiskFindingCode::ConsecutiveGap => "a consecutive gap",
            SweptDiskFindingCode::ZeroLengthSegment => "a zero-length segment",
            _ => unreachable!(),
        };
        report.skipped_reason = Some(format!(
            "source directrix has {defect} at segment {}; whole-sweep comparisons are unavailable",
            finding.segment_index,
        ));
        return report;
    }
    let Some(metrics) = disk.directrix_metrics() else {
        report.skipped_reason = Some("directrix measurements are unavailable".into());
        return report;
    };
    if disk.directrix.is_empty() || !disk.radius.is_finite() || disk.radius <= 0.0 {
        report.skipped_reason = Some("directrix or swept outer radius is unavailable".into());
        return report;
    }
    if disk.directrix.len() != metrics.segments.len() {
        report.skipped_reason = Some("directrix segment measurements are incomplete".into());
        return report;
    }
    let mut has_arc = false;
    let mut has_line = false;
    for (segment, metric) in disk.directrix.iter().zip(metrics.segments.iter()) {
        let (kind, measured_m, limit_m, passed) = match segment {
            AnalyticCurveSegment::Line { .. } => { has_line = true; (
                "straight_segment_length",
                metric.length,
                limits.min_straight_segment_length_m,
                metric.length >= limits.min_straight_segment_length_m,
            ) },
            AnalyticCurveSegment::Arc { radius, .. } => {
                has_arc = true;
                let inside_radius = radius - disk.radius;
                (
                    "inside_bend_radius",
                    inside_radius,
                    limits.min_inside_bend_radius_m,
                    inside_radius >= limits.min_inside_bend_radius_m,
                )
            }
        };
        report.comparisons.push(RebarPreflightComparison {
            kind, segment_index: Some(metric.segment_index), measured_m, limit_m, passed,
        });
    }
    if !has_arc {
        report.unassessed_reasons.push("inside bend radius: no arc segments".into());
    }
    if !has_line {
        report.unassessed_reasons.push("straight segment length: no line segments".into());
    }
    if let Some(limit_m) = limits.max_developed_centreline_length_m {
        report.comparisons.push(RebarPreflightComparison {
            kind: "developed_centreline_length", segment_index: None,
            measured_m: metrics.total_length, limit_m,
            passed: metrics.total_length <= limit_m,
        });
    }
    report
}
