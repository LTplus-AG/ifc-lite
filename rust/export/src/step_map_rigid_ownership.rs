// SPDX-License-Identifier: MPL-2.0
//! Root-frame edits must not silently move a placement in an unknown coordinate
//! consumer. Connection geometry is retained only in known endpoint-local slots.
use super::Record;
use ifc_lite_core::{AttributeValue, EntityDecoder, IfcType};
use std::collections::{HashMap, HashSet};

pub(super) fn validate(
    records: &[Record<'_>],
    products: &HashSet<u32>,
    placements: &HashMap<u32, (u32, usize)>,
    decoder: &mut EntityDecoder,
) -> Result<(), String> {
    let connections: HashSet<_> = records
        .iter()
        .filter(|record| record.kind.is_subtype_of(IfcType::IfcConnectionGeometry))
        .map(|record| record.id)
        .collect();
    for record in records {
        let node = decoder
            .decode_by_id(record.id)
            .map_err(|error| error.to_string())?;
        let connection_slots = if record.kind.is_subtype_of(IfcType::IfcRelSpaceBoundary) {
            Some((4, 5, 6))
        } else if record.kind.is_subtype_of(IfcType::IfcRelConnectsElements) {
            Some((5, 6, 4))
        } else {
            None
        };
        for (slot, attr) in node.attributes.iter().enumerate() {
            // An explicit iterative list walk, bounded by the entity's already
            // parsed attributes, also detects hidden/list references to placements.
            let mut pending = vec![(attr, true)];
            while let Some((value, direct)) = pending.pop() {
                match value {
                    AttributeValue::List(values) => {
                        pending.extend(values.iter().map(|value| (value, false)))
                    }
                    AttributeValue::EntityRef(id) if placements.contains_key(id) => {
                        let allowed = direct
                            && ((record.kind.is_subtype_of(IfcType::IfcProduct) && slot == 5)
                                || (matches!(
                                    record.kind,
                                    IfcType::IfcLocalPlacement | IfcType::IfcLinearPlacement
                                ) && slot == 0));
                        if !allowed {
                            return Err(format!(
                                "placement #{id} is referenced by unsupported {} #{} slot {slot}",
                                record.kind.name(),
                                record.id
                            ));
                        }
                    }
                    AttributeValue::EntityRef(id) if connections.contains(id) => {
                        let Some((relating, related, geometry)) = connection_slots else {
                            return Err(format!(
                                "connection geometry #{id} is referenced by unsupported {} #{}",
                                record.kind.name(),
                                record.id
                            ));
                        };
                        if slot != geometry || !direct {
                            return Err(format!(
                                "connection geometry #{id} is outside its endpoint-local slot"
                            ));
                        }
                        let relating_id = node
                            .get_ref(relating)
                            .ok_or("connection has no Relating endpoint")?;
                        if !products.contains(&relating_id) {
                            return Err(format!(
                                "connection #{} has an endpoint outside transformed product frames",
                                record.id
                            ));
                        }
                        if let Some(endpoint) = node.get(related).filter(|attr| !attr.is_null()) {
                            if !endpoint
                                .as_entity_ref()
                                .is_some_and(|id| products.contains(&id))
                            {
                                return Err(format!("connection #{} has an endpoint outside transformed product frames", record.id));
                            }
                        }
                    }
                    _ => {}
                }
            }
        }
    }
    Ok(())
}
