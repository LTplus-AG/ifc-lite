// SPDX-License-Identifier: MPL-2.0
//! Property and quantity decoding for the attribute export.
//!
//! Split from `model.rs` under the house rule (AGENTS.md): these turn one
//! `IfcPropertySet` / `IfcElementQuantity` definition into the flattened rows
//! `EntityRow` carries, and have nothing to do with the streaming pass that
//! calls them.

use ifc_lite_core::{AttributeValue, DecodedEntity, EntityDecoder, IfcType};

use super::{PropValue, PropertySet, QuantitySet, QuantityValue};

/// Format an f64 without noisy trailing zeros (`1.0` → `1`, `1.50` → `1.5`).
pub fn fmt_num(v: f64) -> String {
    if v.fract() == 0.0 && v.abs() < 1e15 {
        format!("{}", v as i64)
    } else {
        let s = format!("{v:.6}");
        let trimmed = s.trim_end_matches('0').trim_end_matches('.');
        trimmed.to_string()
    }
}

/// Map an IFC boolean/logical enum token to a friendly string.
pub(super) fn map_enum(e: &str) -> String {
    match e {
        "T" => "true".to_string(),
        "F" => "false".to_string(),
        "U" => "unknown".to_string(),
        other => other.to_string(),
    }
}

/// Render an `AttributeValue` (single property value) to `(display, type_tag)`.
/// Typed values like `IFCLABEL('x')` decode to `List([String("IFCLABEL"), inner])`.
pub(super) fn render_value(v: &AttributeValue) -> Option<(String, String)> {
    match v {
        AttributeValue::String(s) => Some((s.clone(), "IFCTEXT".to_string())),
        AttributeValue::Integer(i) => Some((i.to_string(), "IFCINTEGER".to_string())),
        AttributeValue::Float(f) => Some((fmt_num(*f), "IFCREAL".to_string())),
        AttributeValue::Enum(e) => Some((map_enum(e), "IFCBOOLEAN".to_string())),
        AttributeValue::List(items) => {
            // Typed value wrapper: first element is the type name string.
            if let Some(AttributeValue::String(tn)) = items.first() {
                let inner = items.get(1)?;
                let (val, _) = render_value(inner)?;
                Some((val, tn.clone()))
            } else {
                None
            }
        }
        // Entity-ref-valued properties (rare for NominalValue) aren't rendered inline.
        AttributeValue::EntityRef(_) | AttributeValue::Null | AttributeValue::Derived => None,
    }
}

/// Quantity kind + value-attribute index for an `IfcPhysicalSimpleQuantity`.
/// Layout is uniform: `[Name, Description, Unit, <Value>]` ⇒ value at index 3.
pub(super) fn quantity_kind(ty: IfcType) -> Option<&'static str> {
    match ty {
        IfcType::IfcQuantityLength => Some("Length"),
        IfcType::IfcQuantityArea => Some("Area"),
        IfcType::IfcQuantityVolume => Some("Volume"),
        IfcType::IfcQuantityCount => Some("Count"),
        IfcType::IfcQuantityWeight => Some("Weight"),
        IfcType::IfcQuantityTime => Some("Time"),
        _ => None,
    }
}

pub(super) fn opt_string(av: Option<&AttributeValue>) -> Option<String> {
    av.and_then(|a| a.as_string()).map(|s| s.to_string()).filter(|s| !s.is_empty())
}

/// Collect the entity references in a STEP list attribute (e.g. `(#44,#45)`),
/// dropping nulls/non-refs. An absent or `$` attribute yields an empty `Vec`.
pub(super) fn ref_list(av: Option<&AttributeValue>) -> Vec<u32> {
    av.and_then(|a| a.as_list())
        .map(|items| items.iter().filter_map(|v| v.as_entity_ref()).collect())
        .unwrap_or_default()
}

/// Decode one `IfcPropertySet` definition into our model.
pub(super) fn decode_property_set(decoder: &mut EntityDecoder, def: &DecodedEntity) -> Option<PropertySet> {
    let name = def.get(2).and_then(|a| a.as_string()).unwrap_or("").to_string();
    let has_props = def.get(4)?;
    let props = decoder.resolve_ref_list(has_props).ok()?;
    let mut properties = Vec::new();
    for p in &props {
        if p.ifc_type == IfcType::IfcPropertySingleValue {
            let pname = match p.get(0).and_then(|a| a.as_string()) {
                Some(n) if !n.is_empty() => n.to_string(),
                _ => continue,
            };
            if let Some((value, value_type)) = p.get(2).and_then(render_value) {
                properties.push(PropValue { name: pname, value, value_type });
            }
        }
        // Other property kinds (enumerated/list/bounded/complex) are P-next.
    }
    Some(PropertySet { name, properties })
}

/// Decode one `IfcElementQuantity` definition into our model.
pub(super) fn decode_quantity_set(decoder: &mut EntityDecoder, def: &DecodedEntity) -> Option<QuantitySet> {
    let name = def.get(2).and_then(|a| a.as_string()).unwrap_or("").to_string();
    let quantities_attr = def.get(5)?;
    let quants = decoder.resolve_ref_list(quantities_attr).ok()?;
    let mut quantities = Vec::new();
    for q in &quants {
        if let Some(kind) = quantity_kind(q.ifc_type) {
            let qname = match q.get(0).and_then(|a| a.as_string()) {
                Some(n) if !n.is_empty() => n.to_string(),
                _ => continue,
            };
            if let Some(value) = q.get(3).and_then(|a| a.as_float()) {
                quantities.push(QuantityValue { name: qname, value, kind });
            }
        }
    }
    Some(QuantitySet { name, quantities })
}

/// Resolve a list of property/quantity set definition ids into non-empty
/// `(property_sets, quantity_sets)`, dropping undecodable refs. Shared by the
/// product path (ids from `IfcRelDefinesByProperties`) and the type-product path
/// (ids from `IfcTypeObject.HasPropertySets`), so both classify a definition the
/// same way.
pub(super) fn resolve_pset_defs(
    decoder: &mut EntityDecoder,
    def_ids: &[u32],
) -> (Vec<PropertySet>, Vec<QuantitySet>) {
    let mut property_sets = Vec::new();
    let mut quantity_sets = Vec::new();
    for &def_id in def_ids {
        let def = match decoder.decode_by_id(def_id) {
            Ok(d) => d,
            Err(_) => continue,
        };
        match def.ifc_type {
            IfcType::IfcPropertySet => {
                if let Some(ps) = decode_property_set(decoder, &def) {
                    if !ps.properties.is_empty() {
                        property_sets.push(ps);
                    }
                }
            }
            IfcType::IfcElementQuantity => {
                if let Some(qs) = decode_quantity_set(decoder, &def) {
                    if !qs.quantities.is_empty() {
                        quantity_sets.push(qs);
                    }
                }
            }
            _ => {}
        }
    }
    (property_sets, quantity_sets)
}
