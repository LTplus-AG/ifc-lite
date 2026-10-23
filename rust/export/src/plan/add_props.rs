// SPDX-License-Identifier: MPL-2.0
//! Property and quantity sets for [`super::Disposition::Add`]: typed values
//! lowered to the same `IfcPropertySingleValue`/`IfcQuantity*` records the
//! patch path writes, through the same builders in [`super::props_synth`].
//!
//! A new object has no existing sets to share, override or copy, so this
//! only ever builds fresh ones. Attaching them differs by owner and is the
//! caller's choice: an occurrence gets an `IfcRelDefinesByProperties` per
//! set, a type lists them in its own `HasPropertySets`.

use std::collections::HashSet;

use crate::step_text::escape;

use super::tessellation::Emit;
use super::add_types::{GlobalId, NewPropertySet, PropertyValue};
use super::props_synth::{build_value_record, quantity_entity_for_measure, set_record};
use super::types::PsetKind;

/// Refuse what would write an invalid or ambiguous set: two sets of one
/// name on the same owner, an empty set (`HasProperties` is `SET [1:?]`),
/// a quantity with no `IfcQuantity*` entity for its measure, a
/// non-finite number, a measure name that is not an IFC measure type.
pub(crate) fn validate_psets(psets: &[NewPropertySet]) -> Result<(), String> {
    let mut names = HashSet::new();
    for set in psets {
        if !names.insert(set.name.as_str()) {
            return Err(format!("two property sets named '{}' on one object", set.name));
        }
        if set.properties.is_empty() {
            return Err(format!("property set '{}' has no properties", set.name));
        }
        let mut props = HashSet::new();
        for p in &set.properties {
            if !props.insert(p.name.as_str()) {
                return Err(format!("'{}' appears twice in '{}'", p.name, set.name));
            }
            let (measure, _) = lower(&p.value)?;
            if set.kind == PsetKind::Quantity {
                if quantity_entity_for_measure(&measure).is_none() {
                    return Err(format!("{}.{}: no IfcQuantity* entity for {measure}", set.name, p.name));
                }
                // Every IfcQuantity* value has a rule that it is not negative.
                let negative = match &p.value {
                    PropertyValue::Measure { value, .. } | PropertyValue::Real(value) => *value < 0.0,
                    PropertyValue::Integer(i) => *i < 0,
                    _ => false,
                };
                if negative {
                    return Err(format!("{}.{}: a quantity cannot be negative", set.name, p.name));
                }
            }
        }
    }
    Ok(())
}

/// `(UPPERCASE measure type, STEP literal)` for a value.
fn lower(value: &PropertyValue) -> Result<(String, String), String> {
    let finite = |v: f64| if v.is_finite() { Ok(super::placement::fmt(v)) } else { Err(format!("{v} is not finite")) };
    Ok(match value {
        PropertyValue::Label(s) => ("IFCLABEL".into(), format!("'{}'", escape(s))),
        PropertyValue::Text(s) => ("IFCTEXT".into(), format!("'{}'", escape(s))),
        PropertyValue::Identifier(s) => ("IFCIDENTIFIER".into(), format!("'{}'", escape(s))),
        PropertyValue::Boolean(b) => ("IFCBOOLEAN".into(), if *b { ".T." } else { ".F." }.into()),
        PropertyValue::Integer(i) => ("IFCINTEGER".into(), i.to_string()),
        PropertyValue::Real(v) => ("IFCREAL".into(), finite(*v)?),
        PropertyValue::Measure { measure_type, value } => {
            let upper = measure_type.to_ascii_uppercase();
            let shaped = upper.starts_with("IFC") && upper.ends_with("MEASURE") && upper.bytes().all(|b| b.is_ascii_alphanumeric());
            if !shaped {
                return Err(format!("{measure_type} is not an IFC measure type name"));
            }
            (upper, finite(*value)?)
        }
    })
}

/// Build every set in order and return their ids. Each set's GlobalId is
/// derived from `owner` and `role/<set name>`; set names are unique per
/// owner ([`validate_psets`]), so the ids are too.
pub(crate) fn build_sets(
    emit: &mut Emit,
    owner_history: Option<u32>,
    owner: GlobalId,
    role: &str,
    psets: &[NewPropertySet],
) -> Result<Vec<u32>, String> {
    let mut set_ids = Vec::with_capacity(psets.len());
    for set in psets {
        let (container, member_attr) = match set.kind {
            PsetKind::Property => ("IFCPROPERTYSET", "HasProperties"),
            PsetKind::Quantity => ("IFCELEMENTQUANTITY", "Quantities"),
        };
        let mut members = Vec::with_capacity(set.properties.len());
        for p in &set.properties {
            let (measure, literal) = lower(&p.value)?;
            let entity = match set.kind {
                PsetKind::Property => "IFCPROPERTYSINGLEVALUE",
                PsetKind::Quantity => quantity_entity_for_measure(&measure).ok_or("no quantity entity")?,
            };
            let id = emit.ids.allocate().ok_or("id space exhausted")?;
            emit.out.push((id, build_value_record(emit.schema, id, entity, &p.name, &measure, &literal, None)));
            members.push(id);
        }
        let id = emit.ids.allocate().ok_or("id space exhausted")?;
        let guid = owner.derive(&format!("{role}/{}", set.name)).encode();
        emit.out.push((id, set_record(emit.schema, container, member_attr, id, &guid, owner_history, &set.name, &members)));
        set_ids.push(id);
    }
    Ok(set_ids)
}
