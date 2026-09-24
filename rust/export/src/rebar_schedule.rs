// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Opt-in reinforcing-bar schedule inputs, retaining IFC authoring provenance.

use std::collections::{BTreeMap, HashMap, HashSet};

use ifc_lite_core::{
    attribute_names_for_schema, keyword_eq, AttributeValue, DecodedEntity, EntityDecoder,
    EntityScanner,
};
use ifc_lite_processing::{
    check_swept_disk, extract_swept_disk_descriptions, DirectrixMetrics, SweptDiskCheckError,
    SweptDiskCheckOptions, SweptDiskCheckReport,
};
use serde::Serialize;

use crate::schema_detect::detect_schema;

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
}

/// One IFC `IfcReinforcingBar` entity, including bars without analytic geometry.
#[derive(Debug, Clone, Serialize)]
#[non_exhaustive]
pub struct RebarScheduleRow {
    pub global_id: Option<String>,
    pub name: Option<String>,
    pub type_id: Option<u32>,
    pub authored: BTreeMap<String, AuthoredRebarAttribute>,
    pub sweeps: Vec<RebarSweep>,
    pub geometry_unavailable_reason: Option<String>,
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

const FIELDS: &[&str] = &[
    "Tag",
    "SteelGrade",
    "NominalDiameter",
    "CrossSectionArea",
    "BarLength",
    "BarRole",
    "PredefinedType",
    "BarSurface",
    "BendingShapeCode",
];
const MAX_TYPE_RELATION_REFERENCES: usize = 100_000;

fn attribute(
    entity: &DecodedEntity,
    schema: &str,
    name: &str,
    scale: f64,
) -> Result<Option<AuthoredRebarValue>, &'static str> {
    let names = attribute_names_for_schema(schema, entity.ifc_type.name())
        .ok_or("unknown schema entity")?;
    let Some(index) = names.iter().position(|candidate| *candidate == name) else {
        return Ok(None);
    };
    let Some(value) = entity.get(index) else {
        return Ok(None);
    };
    if matches!(value, AttributeValue::Null | AttributeValue::Derived) {
        return Ok(None);
    }
    let unit = match name {
        "NominalDiameter" | "BarLength" => Some((scale, "m")),
        "CrossSectionArea" => Some((scale * scale, "m2")),
        _ => None,
    };
    if let Some((factor, si_unit)) = unit {
        let raw = value.as_float().ok_or("expected numeric measure")?;
        let si = raw * factor;
        if !raw.is_finite() || !si.is_finite() {
            return Err("non-finite measure or unit conversion");
        }
        if (name == "NominalDiameter" || name == "BarLength") && raw <= 0.0 {
            return Err("expected a positive measure");
        }
        if name == "CrossSectionArea" && raw < 0.0 {
            return Err("expected a nonnegative measure");
        }
        return Ok(Some(AuthoredRebarValue::Measure {
            value_file_units: raw,
            value_si: si,
            si_unit,
        }));
    }
    let text = value
        .as_string()
        .or_else(|| value.as_enum())
        .ok_or("expected text or enum")?;
    Ok(Some(AuthoredRebarValue::Text {
        value: text.to_string(),
    }))
}

/// Build an occurrence-aware schedule without tessellating. The optional ID set
/// filters `IfcReinforcingBar` occurrence IDs; an empty set returns no rows.
/// Geometric findings concern source paths, not bending-code compliance.
pub fn build_rebar_schedule(
    content: &[u8],
    ids: Option<&HashSet<u32>>,
    options: &SweptDiskCheckOptions,
) -> Result<RebarSchedule, SweptDiskCheckError> {
    options.validate()?;
    let schema_label = detect_schema(content);
    let known_schema = attribute_names_for_schema(&schema_label, "IFCREINFORCINGBAR").is_some();
    let mut decoder = EntityDecoder::new(content);
    let scale = decoder.length_unit_scale();
    let mut bars = BTreeMap::new();
    let mut types = HashMap::new();
    let mut type_of = HashMap::new();
    let mut type_conflicts: HashMap<u32, Vec<u32>> = HashMap::new();
    let mut type_ref_budget = MAX_TYPE_RELATION_REFERENCES;
    let mut type_ref_budget_reported = false;
    let mut diagnostics = Vec::new();
    let mut scanner = EntityScanner::new(content);
    while let Some((id, kind, start, end)) = scanner.next_entity() {
        if keyword_eq(kind, "IFCREINFORCINGBAR") {
            if ids.is_none_or(|wanted| wanted.contains(&id)) {
                match decoder.decode_at_with_id(id, start, end) {
                    Ok(entity) => {
                        bars.insert(id, entity);
                    }
                    Err(error) => diagnostics.push(format!("bar #{id}: decode: {error}")),
                }
            }
        } else if keyword_eq(kind, "IFCREINFORCINGBARTYPE") {
            if let Ok(entity) = decoder.decode_at_with_id(id, start, end) {
                types.insert(id, entity);
            }
        } else if keyword_eq(kind, "IFCRELDEFINESBYTYPE") {
            if let Ok(rel) = decoder.decode_at_with_id(id, start, end) {
                if let (Some(related), Some(type_id)) = (rel.get_list(4), rel.get_ref(5)) {
                    if related.len() > type_ref_budget && !type_ref_budget_reported {
                        diagnostics.push(format!(
                            "type relationship #{id}: RelatedObjects exceeds work budget; remaining assignments omitted"
                        ));
                        type_ref_budget_reported = true;
                    }
                    for item in related.iter().take(type_ref_budget) {
                        let Some(bar_id) = item.as_entity_ref() else {
                            continue;
                        };
                        if let Some(previous) = type_of.insert(bar_id, type_id) {
                            if previous != type_id {
                                type_conflicts.entry(bar_id).or_default().push(type_id);
                                type_of.insert(bar_id, previous);
                            }
                        }
                    }
                    type_ref_budget = type_ref_budget.saturating_sub(related.len());
                }
            }
        }
    }
    let descriptions = extract_swept_disk_descriptions(
        content,
        Some(&bars.keys().copied().collect::<HashSet<_>>()),
    );
    diagnostics.extend(descriptions.diagnostics.iter().cloned());
    if !known_schema {
        diagnostics.push(format!(
            "unsupported FILE_SCHEMA {schema_label}; authored attributes omitted"
        ));
    }
    let mut rows = BTreeMap::new();
    let mut sweep_count = 0;
    for (id, bar) in bars {
        let type_id = type_of.get(&id).copied();
        let bar_type = type_id.and_then(|type_id| types.get(&type_id));
        let mut row = RebarScheduleRow {
            global_id: bar.get_string(0).map(str::to_owned),
            name: bar.get_string(2).map(str::to_owned),
            type_id,
            authored: BTreeMap::new(),
            sweeps: Vec::new(),
            geometry_unavailable_reason: None,
            diagnostics: Vec::new(),
        };
        if type_id.is_some() && bar_type.is_none() {
            row.diagnostics.push(format!(
                "assigned type #{} is not IfcReinforcingBarType",
                type_id.unwrap_or_default()
            ));
        }
        if let Some(conflicts) = type_conflicts.get(&id) {
            for other in conflicts {
                row.diagnostics.push(format!(
                    "conflicting type assignments #{} and #{other}; first assignment wins",
                    type_id.unwrap_or_default()
                ));
            }
        }
        if known_schema {
            for &field in FIELDS {
                let own = attribute(&bar, &schema_label, field, scale);
                // IfcTypeProduct.Tag identifies the type itself; it is not
                // inherited as the occurrence's IfcElement.Tag.
                let inherited = if field == "Tag" {
                    None
                } else {
                    bar_type.map(|ty| attribute(ty, &schema_label, field, scale))
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
                row.sweeps.push(RebarSweep {
                    occurrence_index,
                    solid_id: disk.solid_id,
                    directrix_id: disk.directrix_id,
                    mapping_path: disk.mapping_path.clone(),
                    source_modified: disk.source_modified,
                    status: disk.status.clone(),
                    radius_m: disk.radius,
                    inner_radius_m: disk.inner_radius,
                    directrix_metrics: disk.directrix_metrics(),
                    checks: check_swept_disk(disk, options)?,
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
