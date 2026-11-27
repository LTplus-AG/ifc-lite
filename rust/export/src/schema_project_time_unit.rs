// SPDX-License-Identifier: MPL-2.0
use ifc_lite_core::{slot, AttributeValue, EntityDecoder, EntityScanner, IfcType};
use std::collections::HashSet;

fn seconds_per_unit(decoder: &mut EntityDecoder, mut id: u32) -> Option<f64> {
    let mut visited = HashSet::new();
    let mut factor = 1.0;
    while visited.insert(id) {
        let unit = decoder.decode_by_id(id).ok()?;
        if !unit
            .enum_at(slot::IfcNamedUnit::UNIT_TYPE)?
            .eq_ignore_ascii_case("TIMEUNIT")
        {
            return None;
        }
        match unit.ifc_type {
            IfcType::IfcSIUnit
                if unit
                    .enum_at(slot::IfcSIUnit::NAME)?
                    .eq_ignore_ascii_case("SECOND") =>
            {
                let prefix = unit.attr(slot::IfcSIUnit::PREFIX)?;
                if !matches!(prefix, AttributeValue::Null) {
                    factor *= ifc_lite_core::units::try_si_prefix_multiplier(prefix.as_enum()?)?;
                }
                return (factor > 0.0 && factor.is_finite()).then_some(factor);
            }
            IfcType::IfcConversionBasedUnit => {
                let measure = decoder
                    .decode_by_id(unit.ref_at(slot::IfcConversionBasedUnit::CONVERSION_FACTOR)?)
                    .ok()?;
                if measure.ifc_type != IfcType::IfcMeasureWithUnit {
                    return None;
                }
                let (ty, number) = measure
                    .attr(slot::IfcMeasureWithUnit::VALUE_COMPONENT)?
                    .as_typed()?;
                let value = match number {
                    AttributeValue::Float(v) => *v,
                    AttributeValue::Integer(v) => *v as f64,
                    _ => return None,
                };
                if !value.is_finite() || value <= 0.0 {
                    return None;
                }
                let kind = crate::step_log::check_real_measure(
                    Some(ifc_lite_core::SchemaFamily::Ifc2x3), ty, value, true,
                ).ok()?;
                if matches!(kind, crate::step_log::MeasureNumber::Integer(_))
                    && !matches!(number, AttributeValue::Integer(_))
                {
                    return None;
                }
                factor *= value;
                id = measure.ref_at(slot::IfcMeasureWithUnit::UNIT_COMPONENT)?;
            }
            _ => return None,
        }
    }
    None
}

pub(crate) fn project_time_scale(content: &[u8]) -> Option<f64> {
    let mut scanner = EntityScanner::new(content);
    let mut decoder = EntityDecoder::new(content);
    let mut scale = None;
    while let Some((id, ty, _, _)) = scanner.next_entity() {
        if !ty.eq_ignore_ascii_case("IFCPROJECT") {
            continue;
        }
        let project = decoder.decode_by_id(id).ok()?;
        let assignment = decoder
            .decode_by_id(project.ref_at(slot::IfcProject::UNITS_IN_CONTEXT)?)
            .ok()?;
        if assignment.ifc_type != IfcType::IfcUnitAssignment {
            return None;
        }
        let mut found = false;
        for unit_id in assignment.ref_list_at(slot::IfcUnitAssignment::UNITS)? {
            let unit = decoder.decode_by_id(unit_id).ok()?;
            if !unit.ifc_type.is_subtype_of(IfcType::IfcNamedUnit)
                || !unit
                    .enum_at(slot::IfcNamedUnit::UNIT_TYPE)
                    .is_some_and(|v| v.eq_ignore_ascii_case("TIMEUNIT"))
            {
                continue;
            }
            let factor = seconds_per_unit(&mut decoder, unit_id)?;
            if scale.is_some_and(|previous| previous != factor) {
                return None;
            }
            scale = Some(factor);
            found = true;
        }
        if !found {
            return None;
        }
    }
    scale
}

/// A subset can omit the source project. Rebuild just its unit graph with the same
/// accepted edits and copy-on-write repointing used to serialize the records.
pub(crate) fn subset_source_scale(
    content: &[u8],
    index: &crate::step_index::RecordIndex,
    edits: &std::collections::HashMap<u32, std::collections::BTreeMap<usize, String>>,
    repointed: &std::collections::HashMap<u32, std::collections::BTreeMap<usize, String>>,
    copies: &[crate::step_cow::Copy],
) -> Option<f64> {
    use crate::step_text::{apply_attr_mutations_counted, merge_edits, renumber};
    if edits.is_empty() && copies.is_empty() {
        return project_time_scale(content);
    }
    let mut graph = String::new();
    let mut scanner = EntityScanner::new(content);
    while let Some((id, ty, start, end)) = scanner.next_entity() {
        let ty = ty.to_ascii_uppercase();
        if !(ty == "IFCPROJECT"
            || ty.ends_with("UNIT")
            || ty == "IFCCONVERSIONBASEDUNITWITHOFFSET"
            || ty == "IFCUNITASSIGNMENT")
            || !index.is_kept(id, start)
        {
            continue;
        }
        let line = String::from_utf8_lossy(&content[start..end]);
        if let Some(mutations) = merge_edits(edits.get(&id), repointed.get(&id)) {
            graph.push_str(&apply_attr_mutations_counted(&line, &mutations, &mut 0));
        } else {
            graph.push_str(&line);
        }
        graph.push('\n');
    }
    for (id, source, changes) in copies {
        let &(start, end) = index.spans.get(source)?;
        let line = String::from_utf8_lossy(&content[start..end]);
        let edited = crate::step_cow::apply_copy_edits(&line, edits.get(source), changes, &mut 0);
        graph.push_str(&renumber(&edited, *id));
        graph.push('\n');
    }
    project_time_scale(graph.as_bytes())
}
