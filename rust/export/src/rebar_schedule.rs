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
    build_rebar_schedule_impl(content, ids, options, None)
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
    build_rebar_schedule_impl(content, ids, options, Some(limits))
        .map_err(RebarSchedulePreflightError::SweepChecks)
}

fn build_rebar_schedule_impl(
    content: &[u8],
    ids: Option<&HashSet<u32>>,
    options: &SweptDiskCheckOptions,
    limits: Option<&RebarPreflightLimits>,
) -> Result<RebarSchedule, SweptDiskCheckError> {
    options.validate()?;
    let schema_label = detect_schema(content);
    let known_schema = attribute_names_for_schema(&schema_label, "IFCREINFORCINGBAR").is_some();
    let mut decoder = EntityDecoder::new(content);
    let scale = decoder.length_unit_scale();
    let mut bars = BTreeMap::new();
    let mut types = HashMap::new();
    let mut unreadable_types = HashSet::new();
    let mut type_candidates: HashMap<u32, Vec<u32>> = HashMap::new();
    let mut type_ref_budget = MAX_TYPE_RELATION_REFERENCES;
    let mut type_ref_budget_reported = false;
    let mut type_link_diagnostics = 0;
    let mut project_id = None;
    let mut diagnostics = Vec::new();
    let mut scanner = EntityScanner::new(content);
    while let Some((id, kind, start, end)) = scanner.next_entity() {
        if keyword_eq(kind, "IFCPROJECT") {
            project_id.get_or_insert(id);
        } else if keyword_eq(kind, "IFCREINFORCINGBAR") {
            if ids.is_none_or(|wanted| wanted.contains(&id)) {
                match decoder.decode_at_with_id(id, start, end) {
                    Ok(entity) => {
                        bars.insert(id, entity);
                    }
                    Err(error) => diagnostics.push(format!("bar #{id}: decode: {error}")),
                }
            }
        } else if keyword_eq(kind, "IFCREINFORCINGBARTYPE") {
            match decoder.decode_at_with_id(id, start, end) {
                Ok(entity) => { types.insert(id, entity); }
                Err(_) => {
                    unreadable_types.insert(id);
                    links::report(&mut diagnostics, &mut type_link_diagnostics, "type", id, "cannot decode");
                }
            }
        } else if keyword_eq(kind, "IFCRELDEFINESBYTYPE") {
            if let Ok(rel) = decoder.decode_at_with_id(id, start, end) {
                if let (Some(related), Some(type_id)) = (rel.get_list(4), rel.get_ref(5)) {
                    if related.is_empty() {
                        links::report(&mut diagnostics, &mut type_link_diagnostics, "type relationship", id, "RelatedObjects is empty");
                    }
                    if related.len() > type_ref_budget {
                        if !type_ref_budget_reported {
                            diagnostics.push(format!(
                                "type relationship #{id}: RelatedObjects exceeds work budget; remaining assignments omitted"
                            ));
                            type_ref_budget_reported = true;
                        }
                    } else if related.iter().any(|item| item.as_entity_ref().is_none()) {
                        links::report(&mut diagnostics, &mut type_link_diagnostics, "type relationship", id, "RelatedObjects contains a non-reference");
                    } else {
                        // A malformed relationship cannot provide provenance for
                        // even its otherwise valid members.
                        for item in related {
                            let bar_id = item.as_entity_ref().expect("validated RelatedObjects member");
                            type_candidates.entry(bar_id).or_default().push(type_id);
                        }
                    }
                    type_ref_budget = type_ref_budget.saturating_sub(related.len());
                } else {
                    let reason = if rel.get_list(4).is_none() { "RelatedObjects is not a reference list" }
                        else { "RelatingType is not a reference" };
                    links::report(&mut diagnostics, &mut type_link_diagnostics, "type relationship", id, reason);
                }
            } else {
                links::report(&mut diagnostics, &mut type_link_diagnostics, "type relationship", id, "cannot decode");
            }
        }
    }
    // IFC assigns area units independently of length units. In particular,
    // a millimetre model may declare square metres for IfcAreaMeasure.
    let project_units = project_id.map(|id| ProjectUnits::resolve(&mut decoder, id))
        .unwrap_or_default();
    let area_scale = project_units.unit_for_measure("IfcAreaMeasure").map(|unit| unit.si_scale);
    let (descriptions, definitions) = extract_swept_disk_views(
        content,
        Some(&bars.keys().copied().collect::<HashSet<_>>()),
    );
    diagnostics.extend(descriptions.diagnostics.iter().cloned());
    let known_diagnostics: HashSet<&str> = descriptions.diagnostics.iter().map(String::as_str).collect();
    diagnostics.extend(definitions.diagnostics.iter()
        .filter(|message| !known_diagnostics.contains(message.as_str())).cloned());
    if !known_schema {
        diagnostics.push(format!(
            "unsupported FILE_SCHEMA {schema_label}; authored attributes omitted"
        ));
    }
    let mut rows = BTreeMap::new();
    let mut sweep_count = 0;
    for (id, bar) in bars {
        let mut type_id = None;
        let mut type_diagnostics = Vec::new();
        let mut seen_types = HashSet::new();
        for candidate in type_candidates.remove(&id).unwrap_or_default() {
            if !seen_types.insert(candidate) {
                continue;
            }
            if unreadable_types.contains(&candidate) {
                type_diagnostics.push(format!("assigned type #{candidate} could not decode"));
            } else if !types.contains_key(&candidate) {
                type_diagnostics.push(format!(
                    "assigned type #{candidate} is not IfcReinforcingBarType"
                ));
            } else if let Some(first) = type_id {
                type_diagnostics.push(format!(
                    "conflicting type assignments #{first} and #{candidate}; first valid assignment wins"
                ));
            } else {
                type_id = Some(candidate);
            }
        }
        let bar_type = type_id.and_then(|type_id| types.get(&type_id));
        let mut row = RebarScheduleRow {
            GlobalId: bar.get_string(0).map(str::to_owned),
            Name: bar.get_string(2).map(str::to_owned),
            type_id,
            authored: BTreeMap::new(),
            sweeps: Vec::new(),
            geometry_unavailable_reason: None,
            preflight_skipped_reason: None,
            diagnostics: type_diagnostics,
        };
        if known_schema {
            for &field in FIELDS {
                let own = attribute(&bar, &schema_label, field, scale, area_scale);
                // IfcTypeProduct.Tag identifies the type itself; it is not
                // inherited as the occurrence's IfcElement.Tag.
                let inherited = if field == "Tag" {
                    None
                } else {
                    bar_type.map(|ty| attribute(ty, &schema_label, field, scale, area_scale))
                };
                if let Err(reason) = &own {
                    row.diagnostics
                        .push(format!("{field} on occurrence: {reason}"));
                }
                if let Some(Err(reason)) = &inherited {
                    row.diagnostics.push(format!("{field} on type: {reason}"));
                }
                let own = own.ok().flatten();
                let inherited = inherited.and_then(Result::ok).flatten();
                if let (Some(left), Some(right)) = (&own, &inherited) {
                    if left != right {
                        row.diagnostics.push(format!("{field} differs between occurrence #{id} and type #{}; occurrence wins", type_id.unwrap_or_default()));
                    }
                }
                if let Some((source, source_id, value)) = own
                    .map(|value| (RebarSource::Occurrence, id, value))
                    .or_else(|| {
                        inherited
                            .map(|value| (RebarSource::Type, type_id.unwrap_or_default(), value))
                    })
                {
                    if field == "CrossSectionArea"
                        && matches!(&value, AuthoredRebarValue::Measure { value_file_units, .. } if *value_file_units == 0.0)
                    {
                        let origin = match source {
                            RebarSource::Occurrence => "occurrence",
                            RebarSource::Type => "type",
                        };
                        row.diagnostics.push(format!(
                            "CrossSectionArea on {origin}: authored zero retained; physical section area is not established"
                        ));
                    }
                    row.authored.insert(
                        field.to_string(),
                        AuthoredRebarAttribute {
                            source,
                            source_id,
                            value,
                        },
                    );
                }
            }
        }
        if let Some(disks) = descriptions.elements.get(&id) {
            for (occurrence_index, disk) in disks.iter().enumerate() {
                let source = definitions.instances.get(&id).and_then(|instances| {
                    let matches = |instance: &SweptDiskInstance| {
                        instance.ordinal == occurrence_index && instance.solid_id == disk.solid_id
                    };
                    instances.get(occurrence_index).filter(|instance| matches(instance))
                        .or_else(|| instances.iter().find(|instance| matches(instance)))
                        .map(|instance| instance.source.clone())
                });
                if source.is_none() {
                    row.diagnostics.push(format!(
                        "sweep {occurrence_index}: reusable source key unavailable; definition output budget may be exhausted"
                    ));
                }
                let checks = check_swept_disk(disk, options)?;
                let preflight = limits.map(|limits| assess_sweep(disk, &checks, limits));
                row.sweeps.push(RebarSweep {
                    occurrence_index,
                    source,
                    solid_id: disk.solid_id,
                    directrix_id: disk.directrix_id,
                    mapping_path: disk.mapping_path.clone(),
                    source_modified: disk.source_modified,
                    status: disk.status.clone(),
                    radius_m: disk.radius,
                    inner_radius_m: disk.inner_radius,
                    directrix_metrics: disk.directrix_metrics(),
                    checks,
                    preflight,
                });
            }
        }
        sweep_count += row.sweeps.len();
        if row.sweeps.is_empty() {
            row.geometry_unavailable_reason = Some(
                descriptions
                    .diagnostics
                    .iter()
                    .find(|message| {
                        message.starts_with(&format!("product #{id}:"))
                            || message.starts_with(&format!("product #{id},"))
                    })
                    .cloned()
                    .unwrap_or_else(|| {
                        "no swept-disk source in selected body representation".to_string()
                    }),
            );
            if limits.is_some() {
                row.preflight_skipped_reason = row.geometry_unavailable_reason.clone();
            }
        }
        rows.insert(id, row);
    }
    Ok(RebarSchedule {
        units: "m",
        coordinate_space: "absolute_ifc_world",
        length_unit_scale: scale,
        bar_entity_count: rows.len(),
        represented_sweep_count: sweep_count,
        rows,
        diagnostics,
    })
}

#[cfg(test)]
#[path = "rebar_schedule_tests.rs"]
mod tests;
