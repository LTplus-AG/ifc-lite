// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Optional source-geometry prechecks, without fabrication certification.

use std::collections::BTreeMap;

use ifc_lite_processing::{DirectrixMetrics, SweptDiskCheckError, SweptDiskCheckReport, SweptDiskOccurrence};
use serde::Serialize;

use crate::rebar_preflight::{assess_sweep, RebarPreflightLimits};
use crate::rebar_schedule::{AuthoredRebarAttribute, AuthoredRebarValue, RebarSource};

/// Caller-selected SI comparisons. `None` means the check was not requested.
#[derive(Debug, Default, Clone, Copy, PartialEq, Serialize)]
#[non_exhaustive]
pub struct RebarFabricationPolicy {
    pub min_inside_bend_radius_m: Option<f64>,
    pub min_straight_segment_length_m: Option<f64>,
    /// Inclusive minimum and maximum arc sweep magnitude, in radians.
    pub allowed_bend_angle_rad: Option<[f64; 2]>,
    /// Maximum absolute difference between authored `NominalDiameter` and
    /// twice the effective world swept-disk outer `Radius`.
    pub max_nominal_geometric_diameter_delta_m: Option<f64>,
    pub max_developed_centreline_length_m: Option<f64>,
}

impl RebarFabricationPolicy {
    pub fn validate(&self) -> Result<(), RebarFabricationPolicyError> {
        for (name, value) in [
            ("min_inside_bend_radius_m", self.min_inside_bend_radius_m),
            ("min_straight_segment_length_m", self.min_straight_segment_length_m),
            ("max_nominal_geometric_diameter_delta_m", self.max_nominal_geometric_diameter_delta_m),
            ("max_developed_centreline_length_m", self.max_developed_centreline_length_m),
        ] {
            if value.is_some_and(|number| !number.is_finite() || number < 0.0) {
                return Err(RebarFabricationPolicyError { option: name, reason: "must be finite and nonnegative" });
            }
        }
        if let Some([minimum, maximum]) = self.allowed_bend_angle_rad {
            if !minimum.is_finite() || !maximum.is_finite() || minimum < 0.0
                || minimum > maximum
            {
                return Err(RebarFabricationPolicyError {
                    option: "allowed_bend_angle_rad",
                    reason: "must be a finite nonnegative ordered range in radians",
                });
            }
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RebarFabricationPolicyError {
    pub option: &'static str,
    pub reason: &'static str,
}

impl std::fmt::Display for RebarFabricationPolicyError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{} {}", self.option, self.reason)
    }
}

impl std::error::Error for RebarFabricationPolicyError {}

#[derive(Debug)]
pub enum RebarScheduleFabricationError {
    Policy(RebarFabricationPolicyError),
    SweepChecks(SweptDiskCheckError),
}

impl std::fmt::Display for RebarScheduleFabricationError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Policy(error) => error.fmt(f),
            Self::SweepChecks(error) => error.fmt(f),
        }
    }
}

impl std::error::Error for RebarScheduleFabricationError {}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RebarFabricationCheckStatus { Pass, Fail, Uncheckable }

/// One requested comparison, including the source identity and absent-value reason.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[non_exhaustive]
pub struct RebarFabricationCheck {
    pub kind: &'static str,
    pub status: RebarFabricationCheckStatus,
    pub bar_id: u32,
    pub solid_id: u32,
    pub directrix_id: u32,
    pub segment_index: Option<usize>,
    pub measured: Option<f64>,
    pub minimum: Option<f64>,
    pub maximum: Option<f64>,
    pub units: &'static str,
    /// `None` for a passing comparison; otherwise why it failed or could not run.
    pub reason: Option<String>,
    /// Set only for an authored diameter comparison.
    pub authored_source: Option<RebarSource>,
    pub authored_source_id: Option<u32>,
    pub nominal_diameter_m: Option<f64>,
    pub geometric_diameter_m: Option<f64>,
}

/// A geometric precheck only. Even all passing checks do not establish a
/// physical bar count, material, process, cutting length, or code compliance.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[non_exhaustive]
pub struct RebarFabricationReport {
    pub outcome: &'static str,
    pub mapping_path: Vec<u32>,
    pub source_modified: bool,
    pub checks: Vec<RebarFabricationCheck>,
    pub limitations: Vec<String>,
    pub unchecked_factors: Vec<&'static str>,
}

const UNCHECKED: [&str; 5] = [
    "material_properties", "bending_process", "fabrication_allowances",
    "physical_bar_count", "jurisdictional_rules",
];

pub(super) struct AuthoredDiameterContext<'a> {
    pub authored: &'a BTreeMap<String, AuthoredRebarAttribute>,
    pub conflicting_type_assignments: bool,
    pub nominal_diameter_conflict: bool,
}

fn check(kind: &'static str, units: &'static str, bar_id: u32,
    disk: &SweptDiskOccurrence, segment_index: Option<usize>, minimum: Option<f64>,
    maximum: Option<f64>) -> RebarFabricationCheck {
    RebarFabricationCheck {
        kind, status: RebarFabricationCheckStatus::Uncheckable,
        bar_id, solid_id: disk.solid_id, directrix_id: disk.directrix_id,
        segment_index, measured: None, minimum, maximum, units, reason: None,
        authored_source: None, authored_source_id: None,
        nominal_diameter_m: None, geometric_diameter_m: None,
    }
}

fn measured(mut item: RebarFabricationCheck, value: f64) -> RebarFabricationCheck {
    if !value.is_finite() {
        item.reason = Some("source measurement is non-finite".into());
        return item;
    }
    item.measured = Some(value);
    item.status = if item.minimum.is_none_or(|minimum| value >= minimum)
        && item.maximum.is_none_or(|maximum| value <= maximum) {
        RebarFabricationCheckStatus::Pass
    } else {
        RebarFabricationCheckStatus::Fail
    };
    if item.status == RebarFabricationCheckStatus::Fail {
        item.reason = Some(if item.minimum.is_some_and(|minimum| value < minimum) {
            "measured value is below the caller's minimum"
        } else {
            "measured value exceeds the caller's maximum"
        }.into());
    }
    item
}

/// Project the existing exact swept-disk measurements into optional checks.
/// Authored diameter provenance arrives after schedule attribute resolution.
pub(super) fn assess_fabrication(
    bar_id: u32,
    disk: &SweptDiskOccurrence,
    checks: &SweptDiskCheckReport,
    metrics: Option<&DirectrixMetrics>,
    context: AuthoredDiameterContext<'_>,
    policy: &RebarFabricationPolicy,
) -> RebarFabricationReport {
    let legacy_limits = RebarPreflightLimits {
        min_inside_bend_radius_m: policy.min_inside_bend_radius_m.unwrap_or(0.0),
        min_straight_segment_length_m: policy.min_straight_segment_length_m.unwrap_or(0.0),
        max_developed_centreline_length_m: policy.max_developed_centreline_length_m,
    };
    // This is the sole radius/straight/length evaluator; no IFC re-decode.
    let geometry = assess_sweep(disk, checks, metrics, &legacy_limits);
    let unavailable = geometry.skipped_reason.as_deref();
    let mut report = RebarFabricationReport {
        outcome: "precheck_only", mapping_path: disk.mapping_path.clone(),
        source_modified: disk.source_modified, checks: Vec::new(),
        limitations: Vec::new(), unchecked_factors: UNCHECKED.to_vec(),
    };
    if let Some(reason) = unavailable { report.limitations.push(reason.to_owned()); }
    if disk.source_modified { report.limitations.push("enclosing CSG modifies source geometry".into()); }
    if !disk.mapping_path.is_empty() { report.limitations.push("mapped occurrence; source identity is distinct from physical count".into()); }
    if context.conflicting_type_assignments {
        report.limitations.push("conflicting type assignments".into());
    }
    if context.nominal_diameter_conflict {
        report.limitations.push("occurrence and type NominalDiameter differ".into());
    }

    for (kind, requested) in [
        ("inside_bend_radius", policy.min_inside_bend_radius_m),
        ("straight_segment_length", policy.min_straight_segment_length_m),
        ("developed_centreline_length", policy.max_developed_centreline_length_m),
    ] {
        let Some(limit) = requested else { continue };
        let (minimum, maximum) = if kind == "developed_centreline_length" {
            (None, Some(limit))
        } else { (Some(limit), None) };
        let matching = geometry.comparisons.as_ref().into_iter().flatten().filter(|part| part.kind == kind);
        let mut found = false;
        for part in matching {
            found = true;
            let mut item = check(kind, "m", bar_id, disk, part.segment_index, minimum, maximum);
            item = measured(item, part.measured_m);
            if kind == "inside_bend_radius" && part.measured_m <= 0.0 {
                item.status = RebarFabricationCheckStatus::Fail;
                item.reason = Some("effective inside radius is nonpositive".into());
            }
            report.checks.push(item);
        }
        if !found {
            let mut item = check(kind, "m", bar_id, disk, None, minimum, maximum);
            item.reason = Some(unavailable.unwrap_or(if kind == "inside_bend_radius" {
                "no arc segments"
            } else if kind == "straight_segment_length" {
                "no line segments"
            } else { "directrix measurement unavailable" }).into());
            report.checks.push(item);
        }
    }

    if let Some([minimum, maximum]) = policy.allowed_bend_angle_rad {
        let mut found = false;
        if unavailable.is_none() {
            for metric in metrics.into_iter().flat_map(|value| &value.segments) {
                if let Some(angle) = metric.bend_angle {
                    found = true;
                    let item = check("bend_angle", "rad", bar_id, disk,
                        Some(metric.segment_index), Some(minimum), Some(maximum));
                    report.checks.push(measured(item, angle));
                }
            }
        }
        if !found {
            let mut item = check("bend_angle", "rad", bar_id, disk, None,
                Some(minimum), Some(maximum));
            item.reason = Some(unavailable.unwrap_or("no arc segments").into());
            report.checks.push(item);
        }
    }

    if let Some(tolerance) = policy.max_nominal_geometric_diameter_delta_m {
        let mut item = check("nominal_geometric_diameter_delta", "m", bar_id, disk,
            None, None, Some(tolerance));
        if let Some(attribute) = context.authored.get("NominalDiameter") {
            item.authored_source = Some(attribute.source);
            item.authored_source_id = Some(attribute.source_id);
            if let AuthoredRebarValue::Measure { value_si, .. } = &attribute.value {
                if value_si.is_finite() && *value_si > 0.0 { item.nominal_diameter_m = Some(*value_si); }
            }
        }
        let conflict = context.conflicting_type_assignments || context.nominal_diameter_conflict;
        if unavailable.is_some() {
            item.reason = unavailable.map(str::to_owned);
        } else if conflict {
            item.reason = Some("ambiguous authored NominalDiameter or type assignment".into());
        } else if let Some(nominal) = item.nominal_diameter_m {
            let geometric = 2.0 * disk.radius;
            if geometric.is_finite() && geometric > 0.0 {
                item.geometric_diameter_m = Some(geometric);
                item = measured(item, (nominal - geometric).abs());
            } else {
                item.reason = Some("effective world geometric diameter is unavailable".into());
            }
        } else {
            item.reason = Some("positive authored NominalDiameter is unavailable".into());
        }
        report.checks.push(item);
    }
    report
}

#[cfg(test)]
#[path = "rebar_fabrication_tests.rs"]
mod tests;
