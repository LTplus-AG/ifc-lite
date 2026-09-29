// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Opt-in reinforcing-bar schedule inputs, retaining IFC authoring provenance.

use std::collections::{BTreeMap, HashMap, HashSet};

use ifc_lite_core::{
    attribute_names_for_schema, keyword_eq, EntityDecoder, EntityScanner, ProjectUnits,
};
use ifc_lite_processing::{
    check_swept_disk, extract_swept_disk_views, DirectrixMetrics, SweptDiskCheckError,
    SweptDiskCheckOptions, SweptDiskCheckReport, SweptDiskInstance, SweptDiskSourceKey,
};
use serde::Serialize;

use crate::rebar_attributes::{attribute, FIELDS};
use crate::schema_detect::detect_schema;
use crate::rebar_preflight::{assess_sweep, RebarPreflightLimits, RebarPreflightReport, RebarSchedulePreflightError};
use crate::rebar_fabrication::{assess_fabrication, AuthoredDiameterContext, RebarFabricationPolicy, RebarFabricationReport,
    RebarScheduleFabricationError};

/// Where a schema-declared value was authored. An occurrence wins a conflict.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
#[non_exhaustive]
pub enum RebarSource {
    Occurrence,
    Type,
}

/// Authored IFC value. Measures retain the file value and an SI conversion.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[non_exhaustive]
pub enum AuthoredRebarValue {
    Text {
        value: String,
    },
    Measure {
        value_file_units: f64,
        value_si: f64,
        si_unit: &'static str,
    },
}

/// One explicitly authored EXPRESS attribute, keyed by its exact name.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[non_exhaustive]
pub struct AuthoredRebarAttribute {
    pub source: RebarSource,
    pub source_id: u32,
    pub value: AuthoredRebarValue,
}

/// One represented swept-disk source. This is not a physical bar count.
#[derive(Debug, Clone, Serialize)]
#[non_exhaustive]
pub struct RebarSweep {
    pub occurrence_index: usize,
    /// Reusable raw source identity; absent only if the definition output
    /// budget omitted this product while the world description remained.
    pub source: Option<SweptDiskSourceKey>,
    pub solid_id: u32,
    pub directrix_id: u32,
    pub mapping_path: Vec<u32>,
    pub source_modified: bool,
    pub status: ifc_lite_geometry::analytic::AnalyticStatus,
    /// Effective world radius for complete paths; source radius in metres otherwise.
    pub radius_m: f64,
    /// Effective world inner radius for complete paths; source value otherwise.
    pub inner_radius_m: Option<f64>,
    pub directrix_metrics: Option<DirectrixMetrics>,
    pub checks: SweptDiskCheckReport,
    /// Present only when caller requested fabrication preflight comparisons.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub preflight: Option<RebarPreflightReport>,
    /// Present only for the caller-supplied optional fabrication policy.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fabrication_precheck: Option<RebarFabricationReport>,
}

/// One IFC `IfcReinforcingBar` entity, including bars without analytic geometry.
#[derive(Debug, Clone, Serialize)]
#[non_exhaustive]
#[allow(non_snake_case)] // Public IFC attributes retain their EXPRESS names.
pub struct RebarScheduleRow {
    /// The occurrence's `IfcRoot.GlobalId`.
    pub GlobalId: Option<String>,
    /// The occurrence's `IfcRoot.Name`.
    pub Name: Option<String>,
    pub type_id: Option<u32>,
    pub authored: BTreeMap<String, AuthoredRebarAttribute>,
    pub sweeps: Vec<RebarSweep>,
    pub geometry_unavailable_reason: Option<String>,
    /// For an opted-in row with no represented sweep.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub preflight_skipped_reason: Option<String>,
    /// For an opted-in policy with no represented swept-disk source.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fabrication_precheck_skipped_reason: Option<String>,
    pub diagnostics: Vec<String>,
}

/// Occurrence-keyed schedule inputs. `physical_bar_count` is deliberately
/// absent: IFC permits one entity to represent multiple manufactured bars.
#[derive(Debug, Clone, Serialize)]
#[non_exhaustive]
pub struct RebarSchedule {
    pub units: &'static str,
    pub coordinate_space: &'static str,
    pub length_unit_scale: f64,
    pub bar_entity_count: usize,
    pub represented_sweep_count: usize,
    pub rows: BTreeMap<u32, RebarScheduleRow>,
    pub diagnostics: Vec<String>,
}

const MAX_TYPE_RELATION_REFERENCES: usize = 100_000;

#[path = "rebar_schedule_links.rs"]
mod links;

/// Build an occurrence-aware schedule without tessellating. The optional ID set
/// filters `IfcReinforcingBar` occurrence IDs; an empty set returns no rows.
/// Geometric findings concern source paths, not bending-code compliance.
pub fn build_rebar_schedule(
    content: &[u8],
    ids: Option<&HashSet<u32>>,
    options: &SweptDiskCheckOptions,
) -> Result<RebarSchedule, SweptDiskCheckError> {
    build_rebar_schedule_impl(content, ids, options, None, None)
}

/// Build a schedule with caller-supplied geometric fabrication comparisons.
/// Results do not certify a cutting length or code compliance.
pub fn build_rebar_schedule_with_preflight(
    content: &[u8],
    ids: Option<&HashSet<u32>>,
    options: &SweptDiskCheckOptions,
    limits: &RebarPreflightLimits,
) -> Result<RebarSchedule, RebarSchedulePreflightError> {
    limits.validate().map_err(RebarSchedulePreflightError::Limits)?;
    build_rebar_schedule_impl(content, ids, options, Some(limits), None)
        .map_err(RebarSchedulePreflightError::SweepChecks)
}

/// Compare only the caller's requested SI constraints against represented
/// source geometry. The outcome is always `precheck_only`.
pub fn build_rebar_schedule_with_fabrication_precheck(
    content: &[u8],
    ids: Option<&HashSet<u32>>,
    options: &SweptDiskCheckOptions,
    policy: &RebarFabricationPolicy,
) -> Result<RebarSchedule, RebarScheduleFabricationError> {
    policy.validate().map_err(RebarScheduleFabricationError::Policy)?;
    build_rebar_schedule_impl(content, ids, options, None, Some(policy))
        .map_err(RebarScheduleFabricationError::SweepChecks)
}

#[path = "rebar_schedule_build.rs"]
mod build;
use build::build_rebar_schedule_impl;

#[cfg(test)]
#[path = "rebar_schedule_tests.rs"]
mod tests;
