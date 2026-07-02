// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use super::{normalize_optional_string, EntityJob};
use ifc_lite_core::{AttributeValue, DecodedEntity, IfcType};
use rustc_hash::FxHashMap;
use std::collections::BTreeMap;

#[derive(Debug, Clone)]
pub(super) struct PropertySetDefinition {
    name: Option<String>,
    property_ids: Vec<u32>,
}

#[derive(Debug, Clone)]
pub(super) struct RelDefinesByPropertiesLink {
    property_set_id: u32,
    related_object_ids: Vec<u32>,
}

fn normalize_ifc_property_name(raw: Option<&str>) -> Option<String> {
    let name = normalize_optional_string(raw)?;
    let cleaned = name.trim();
    if cleaned.is_empty() {
        return None;
    }

    Some(cleaned.to_string())
}

fn is_space_or_zone_type(ifc_type: &IfcType) -> bool {
    matches!(
        ifc_type,
        IfcType::IfcSpace
            | IfcType::IfcSpaceType
            | IfcType::IfcZone
            | IfcType::IfcSpatialZone
            | IfcType::IfcSpatialZoneType
    )
}

pub(super) fn collect_property_set_definition(property_set: &DecodedEntity) -> Option<PropertySetDefinition> {
    let property_ids = property_set
        .get_list(4)
        .or_else(|| property_set.get_list(2))
        .map(|items| {
            items
                .iter()
                .filter_map(AttributeValue::as_entity_ref)
                .collect::<Vec<u32>>()
        })
        .unwrap_or_default();

    if property_ids.is_empty() {
        return None;
    }

    let name = normalize_optional_string(property_set.get_string(2))
        .or_else(|| normalize_optional_string(property_set.get_string(0)));

    Some(PropertySetDefinition { name, property_ids })
}

pub(super) fn collect_rel_defines_by_properties_link(
    rel_defines: &DecodedEntity,
) -> Option<RelDefinesByPropertiesLink> {
    let property_set_id = rel_defines.get_ref(5).or_else(|| rel_defines.get_ref(3))?;
    let related_object_ids = rel_defines
        .get_list(4)
        .or_else(|| rel_defines.get_list(2))
        .map(|items| {
            items
                .iter()
                .filter_map(AttributeValue::as_entity_ref)
                .collect::<Vec<u32>>()
        })
        .unwrap_or_default();

    if related_object_ids.is_empty() {
        return None;
    }

    Some(RelDefinesByPropertiesLink {
        property_set_id,
        related_object_ids,
    })
}

fn attribute_list_to_string(values: &[AttributeValue]) -> Option<String> {
    let tokens = values
        .iter()
        .filter_map(attribute_value_to_string)
        .collect::<Vec<String>>();

    if tokens.is_empty() {
        return None;
    }

    Some(tokens.join("; "))
}

fn attribute_value_to_string(value: &AttributeValue) -> Option<String> {
    match value {
        AttributeValue::Null | AttributeValue::Derived => None,
        AttributeValue::String(text) => normalize_optional_string(Some(text)),
        AttributeValue::Enum(text) => normalize_optional_string(Some(text.trim_matches('.'))),
        AttributeValue::Integer(number) => Some(number.to_string()),
        AttributeValue::Float(number) => Some(number.to_string()),
        AttributeValue::EntityRef(id) => Some(format!("#{id}")),
        AttributeValue::List(values) => {
            if values.len() >= 2 && matches!(values.first(), Some(AttributeValue::String(_))) {
                return values.get(1).and_then(attribute_value_to_string);
            }

            attribute_list_to_string(values)
        }
    }
}

pub(super) fn extract_property_name_and_value(property_entity: &DecodedEntity) -> Option<(String, String)> {
    let property_name = normalize_ifc_property_name(property_entity.get_string(0))
        .or_else(|| normalize_ifc_property_name(property_entity.get_string(2)))?;

    let property_type = property_entity.ifc_type.name();
    let value = match property_type {
        "IfcPropertySingleValue" => property_entity.get(2).and_then(attribute_value_to_string),
        "IfcPropertyEnumeratedValue" => property_entity.get(2).and_then(attribute_value_to_string),
        "IfcPropertyListValue" => property_entity.get(2).and_then(attribute_value_to_string),
        "IfcPropertyBoundedValue" => {
            let lower = property_entity.get(2).and_then(attribute_value_to_string);
            let upper = property_entity.get(3).and_then(attribute_value_to_string);
            match (lower, upper) {
                (Some(lo), Some(hi)) => Some(format!("{lo}..{hi}")),
                (Some(lo), None) => Some(lo),
                (None, Some(hi)) => Some(hi),
                (None, None) => None,
            }
        }
        "IfcPropertyReferenceValue" => property_entity.get(2).and_then(attribute_value_to_string),
        _ => None,
    }?;

    let normalized_value = value.trim();
    if normalized_value.is_empty() || normalized_value == "$" {
        return None;
    }

    Some((property_name, normalized_value.to_string()))
}

fn add_space_zone_property(
    attributes: &mut BTreeMap<String, String>,
    property_set_name: Option<&str>,
    property_name: &str,
    property_value: &str,
) {
    if property_name.trim().is_empty() || property_value.trim().is_empty() {
        return;
    }

    attributes
        .entry(property_name.to_string())
        .or_insert_with(|| property_value.to_string());

    if let Some(pset_name) = normalize_optional_string(property_set_name) {
        let scoped_name = format!("{}.{}", pset_name, property_name);
        attributes
            .entry(scoped_name)
            .or_insert_with(|| property_value.to_string());
    }
}

fn build_space_zone_properties_by_entity(
    entity_jobs: &[EntityJob],
    property_values_by_id: &FxHashMap<u32, (String, String)>,
    property_sets_by_id: &FxHashMap<u32, PropertySetDefinition>,
    rel_defines_by_properties: &[RelDefinesByPropertiesLink],
) -> FxHashMap<u32, BTreeMap<String, String>> {
    let mut target_space_zone_ids = FxHashMap::default();
    for job in entity_jobs
        .iter()
        .filter(|job| is_space_or_zone_type(&job.ifc_type))
    {
        target_space_zone_ids.insert(job.id, ());
    }

    if target_space_zone_ids.is_empty() {
        return FxHashMap::default();
    }

    let mut properties_by_entity: FxHashMap<u32, BTreeMap<String, String>> = FxHashMap::default();

    for link in rel_defines_by_properties {
        let Some(property_set) = property_sets_by_id.get(&link.property_set_id) else {
            continue;
        };

        for related_id in &link.related_object_ids {
            if !target_space_zone_ids.contains_key(related_id) {
                continue;
            }

            let attributes = properties_by_entity.entry(*related_id).or_default();
            for property_id in &property_set.property_ids {
                let Some((property_name, property_value)) = property_values_by_id.get(property_id)
                else {
                    continue;
                };

                add_space_zone_property(
                    attributes,
                    property_set.name.as_deref(),
                    property_name,
                    property_value,
                );
            }
        }
    }

    properties_by_entity
}

pub(super) fn assign_space_zone_properties(
    entity_jobs: &mut [EntityJob],
    property_values_by_id: &FxHashMap<u32, (String, String)>,
    property_sets_by_id: &FxHashMap<u32, PropertySetDefinition>,
    rel_defines_by_properties: &[RelDefinesByPropertiesLink],
) {
    let properties_by_entity = build_space_zone_properties_by_entity(
        entity_jobs,
        property_values_by_id,
        property_sets_by_id,
        rel_defines_by_properties,
    );

    if properties_by_entity.is_empty() {
        return;
    }

    for job in entity_jobs.iter_mut() {
        if let Some(properties) = properties_by_entity.get(&job.id) {
            job.space_zone_properties = Some(properties.clone());
        }
    }
}
