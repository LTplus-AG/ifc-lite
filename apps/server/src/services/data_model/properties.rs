// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Property set extraction.

use super::types::{EntityJob, Property, PropertySet};
use ifc_lite_core::{DecodedEntity, EntityDecoder};
use rayon::prelude::*;
use std::sync::Arc;

/// Extract all property sets and their properties.
pub(super) fn extract_properties(
    jobs: &[EntityJob],
    content: &Arc<Vec<u8>>,
    entity_index: &Arc<ifc_lite_core::EntityIndex>,
) -> Vec<PropertySet> {
    // First, collect all PropertySet entities
    // PERF: Use eq_ignore_ascii_case to avoid string allocation per comparison
    let pset_jobs: Vec<_> = jobs
        .iter()
        .filter(|job| job.type_name.eq_ignore_ascii_case("IFCPROPERTYSET"))
        .collect();

    tracing::debug!(count = pset_jobs.len(), "Extracting property sets");

    pset_jobs
        .par_iter()
        .filter_map(|job| {
            let mut local_decoder =
                EntityDecoder::with_arc_index(content.as_slice(), entity_index.clone());
            let entity = local_decoder.decode_at(job.start, job.end).ok()?;

            // IfcPropertySet: [0]=GlobalId, [1]=OwnerHistory, [2]=Name, [3]=Description, [4]=HasProperties
            let pset_name = entity.get_string(2)?.to_string();
            let has_properties = entity.get_list(4)?;

            let mut properties = Vec::new();

            // Extract properties from HasProperties list
            for prop_ref in has_properties.iter() {
                if let Some(prop_id) = prop_ref.as_entity_ref() {
                    if let Ok(prop_entity) = local_decoder.decode_by_id(prop_id) {
                        if let Some(prop) = extract_property(&prop_entity, &mut local_decoder) {
                            properties.push(prop);
                        }
                    }
                }
            }

            if properties.is_empty() {
                return None;
            }

            Some(PropertySet {
                pset_id: job.id,
                pset_name,
                properties,
            })
        })
        .collect()
}

/// Extract a single property from IfcProperty entity.
fn extract_property(entity: &DecodedEntity, _decoder: &mut EntityDecoder) -> Option<Property> {
    // PERF: Use eq_ignore_ascii_case to avoid string allocation per comparison
    let ifc_type = entity.ifc_type.as_str();

    // IfcPropertySingleValue: [0]=Name, [1]=Description, [2]=NominalValue, [3]=Unit
    if ifc_type.eq_ignore_ascii_case("IFCPROPERTYSINGLEVALUE") {
        let property_name = entity.get_string(0)?.to_string();
        let nominal_value = entity.get(2)?;

        // Extract value based on type
        let (property_value, property_type) = if let Some(s) = nominal_value.as_string() {
            (format!("\"{}\"", s), "string".to_string())
        } else if let Some(f) = nominal_value.as_float() {
            (f.to_string(), "number".to_string())
        } else if let Some(i) = nominal_value.as_int() {
            (i.to_string(), "integer".to_string())
        } else {
            // Fallback: serialize as string representation
            (format!("{:?}", nominal_value), "unknown".to_string())
        };

        Some(Property {
            property_name,
            property_value,
            property_type,
        })
    } else {
        None
    }
}
