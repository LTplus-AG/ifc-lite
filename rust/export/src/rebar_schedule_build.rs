// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use super::*;

/// The length scale from the same `ProjectUnits` as the area scale
/// (EXPORT-DATA-9): one resolution, one scan for the project. A length unit
/// whose declared factor is unusable keeps main's value (data path) but is no
/// longer silent: the bar lengths are then not in metres.
fn length_scale(project_units: &ProjectUnits, diagnostics: &mut Vec<String>) -> f64 {
    if let Some(factor) = project_units.length_unit().unusable_factor {
        diagnostics.push(format!(
            "project length unit unresolved: ConversionFactor #{factor} is not a positive finite number; bar lengths are not in metres"
        ));
    }
    project_units.length_unit_scale()
}

pub(super) fn build_rebar_schedule_impl(
    content: &[u8],
    ids: Option<&HashSet<u32>>,
    options: &SweptDiskCheckOptions,
    limits: Option<&RebarPreflightLimits>,
    policy: Option<&RebarFabricationPolicy>,
) -> Result<RebarSchedule, SweptDiskCheckError> {
    options.validate()?;
    // Fail closed like the attribute export: no IFC4 layout for an
    // undeclared or unrecognised schema (#7681).
    let schema = attribute_schema(content);
    let mut decoder = EntityDecoder::new(content);
    let mut bars = BTreeMap::new();
    let mut types = HashMap::new();
    let mut unreadable_types = HashSet::new();
    let mut type_candidates = ifc_lite_processing::data_model::type_assignments::TypeAssignments::new();
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
                            type_candidates.record(bar_id, type_id);
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
    let scale = length_scale(&project_units, &mut diagnostics); // EXPORT-DATA-9
    let area_scale = project_units.unit_for_measure("IfcAreaMeasure").map(|unit| unit.si_scale);
    let (descriptions, definitions) = extract_swept_disk_views(
        content,
        Some(&bars.keys().copied().collect::<HashSet<_>>()),
    );
    diagnostics.extend(descriptions.diagnostics.iter().cloned());
    let known_diagnostics: HashSet<&str> = descriptions.diagnostics.iter().map(String::as_str).collect();
    diagnostics.extend(definitions.diagnostics.iter()
        .filter(|message| !known_diagnostics.contains(message.as_str())).cloned());
    if schema.is_none() {
        let declared = crate::source_header::declared_schemas(content).join(", ");
        diagnostics.push(format!(
            "unsupported FILE_SCHEMA ({declared}); authored attributes omitted"
        ));
    }
    let mut rows = BTreeMap::new();
    let mut sweep_count = 0;
    for (id, bar) in bars {
        let mut type_id = None;
        let mut type_diagnostics = Vec::new();
        let mut conflicting_type_assignments = false;
        let mut nominal_diameter_conflict = false;
        for candidate in type_candidates.candidates(id) {
            if unreadable_types.contains(&candidate) {
                type_diagnostics.push(format!("assigned type #{candidate} could not decode"));
            } else if !types.contains_key(&candidate) {
                type_diagnostics.push(format!(
                    "assigned type #{candidate} is not IfcReinforcingBarType"
                ));
            } else if let Some(first) = type_id {
                conflicting_type_assignments = true;
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
            fabrication_precheck_skipped_reason: None,
            diagnostics: type_diagnostics,
        };
        if let Some(schema_label) = &schema {
            for &field in FIELDS {
                let own = attribute(&bar, schema_label, field, scale, area_scale);
                // IfcTypeProduct.Tag identifies the type itself; it is not
                // inherited as the occurrence's IfcElement.Tag.
                let inherited = if field == "Tag" {
                    None
                } else {
                    bar_type.map(|ty| attribute(ty, schema_label, field, scale, area_scale))
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
                        if field == "NominalDiameter" {
                            nominal_diameter_conflict = true;
                        }
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
                let directrix_metrics = disk.directrix_metrics();
                let preflight = limits.map(|limits| assess_sweep(
                    disk, &checks, directrix_metrics.as_ref(), limits,
                ));
                let fabrication_precheck = policy.map(|policy| assess_fabrication(
                    id, disk, &checks, directrix_metrics.as_ref(), AuthoredDiameterContext {
                        authored: &row.authored,
                        conflicting_type_assignments,
                        nominal_diameter_conflict,
                    }, policy,
                ));
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
                    directrix_metrics,
                    checks,
                    preflight,
                    fabrication_precheck,
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
            if policy.is_some() {
                row.fabrication_precheck_skipped_reason = row.geometry_unavailable_reason.clone();
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
