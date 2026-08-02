// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Quantity set extraction.

use super::types::{EntityJob, Quantity, QuantitySet};
use ifc_lite_core::{DecodedEntity, EntityDecoder};
use rayon::prelude::*;
use std::sync::Arc;

/// Extract all quantity sets (IfcElementQuantity) and their quantities.
pub(super) fn extract_quantities(
    jobs: &[EntityJob],
    content: &Arc<Vec<u8>>,
    entity_index: &Arc<ifc_lite_core::EntityIndex>,
) -> Vec<QuantitySet> {
    // First, collect all IfcElementQuantity entities
    // PERF: Use eq_ignore_ascii_case to avoid string allocation per comparison
    let qset_jobs: Vec<_> = jobs
        .iter()
        .filter(|job| job.type_name.eq_ignore_ascii_case("IFCELEMENTQUANTITY"))
        .collect();

    tracing::debug!(count = qset_jobs.len(), "Extracting quantity sets");

    qset_jobs
        .par_iter()
        .filter_map(|job| {
            let mut local_decoder =
                EntityDecoder::with_arc_index(content.as_slice(), entity_index.clone());
            let entity = local_decoder.decode_at(job.start, job.end).ok()?;

            // IfcElementQuantity: [0]=GlobalId, [1]=OwnerHistory, [2]=Name, [3]=Description, [4]=MethodOfMeasurement, [5]=Quantities
            let qset_name = entity.get_string(2)?.to_string();
            let method_of_measurement = entity.get_string(4).map(|s| s.to_string());
            let has_quantities = entity.get_list(5)?;

            let mut quantities = Vec::new();

            // Extract quantities from Quantities list
            for quant_ref in has_quantities.iter() {
                if let Some(quant_id) = quant_ref.as_entity_ref() {
                    if let Ok(quant_entity) = local_decoder.decode_by_id(quant_id) {
                        if let Some(quant) = extract_quantity_value(&quant_entity) {
                            quantities.push(quant);
                        }
                    }
                }
            }

            if quantities.is_empty() {
                return None;
            }

            Some(QuantitySet {
                qset_id: job.id,
                qset_name,
                method_of_measurement,
                quantities,
            })
        })
        .collect()
}

/// Extract a single quantity value from IfcPhysicalQuantity entity.
/// Supports: IfcQuantityLength, IfcQuantityArea, IfcQuantityVolume,
///           IfcQuantityCount, IfcQuantityWeight, IfcQuantityTime
fn extract_quantity_value(entity: &DecodedEntity) -> Option<Quantity> {
    // PERF: Use eq_ignore_ascii_case to avoid string allocation per comparison
    let ifc_type = entity.ifc_type.as_str();

    // Map IFC type to quantity type string
    let quantity_type = if ifc_type.eq_ignore_ascii_case("IFCQUANTITYLENGTH") {
        "length"
    } else if ifc_type.eq_ignore_ascii_case("IFCQUANTITYAREA") {
        "area"
    } else if ifc_type.eq_ignore_ascii_case("IFCQUANTITYVOLUME") {
        "volume"
    } else if ifc_type.eq_ignore_ascii_case("IFCQUANTITYCOUNT") {
        "count"
    } else if ifc_type.eq_ignore_ascii_case("IFCQUANTITYWEIGHT") {
        "weight"
    } else if ifc_type.eq_ignore_ascii_case("IFCQUANTITYTIME") {
        "time"
    } else {
        return None; // Not a recognized quantity type
    };

    // All IFC quantity types have:
    // [0]=Name, [1]=Description, [2]=Unit, [3]=*Value, [4]=Formula (optional, IFC4)
    let quantity_name = entity.get_string(0)?.to_string();

    // Value is at index 3 for all quantity types
    let quantity_value = entity.get_float(3)?;

    Some(Quantity {
        quantity_name,
        quantity_value,
        quantity_type: quantity_type.to_string(),
    })
}
