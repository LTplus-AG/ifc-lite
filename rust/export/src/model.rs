// SPDX-License-Identifier: MPL-2.0
//! Shared **export data model** — one parse pass that yields the entities,
//! property sets and quantity sets the tabular / semantic exporters (CSV, JSON,
//! JSON-LD, Parquet) all consume.
//!
//! Built directly on `ifc_lite_core`'s `EntityDecoder` / `AttributeValue` model
//! (the Rust source of truth), so property + quantity extraction lives in Rust
//! rather than the TS `columnar-parser`. Covers `IfcProduct` occurrences and their
//! directly-attached `IfcRelDefinesByProperties` property/quantity sets.

use std::collections::HashMap;

use ifc_lite_core::{
    build_entity_index, AttributeValue, DecodedEntity, EntityDecoder, EntityScanner, IfcType,
};

/// A single property value (`IfcPropertySingleValue` and friends).
#[derive(Debug, Clone)]
pub struct PropValue {
    pub name: String,
    pub value: String,
    /// IFC value type tag when known (e.g. `IFCLABEL`, `IFCREAL`, `IFCBOOLEAN`).
    pub value_type: String,
}

/// A named property set (`IfcPropertySet`).
#[derive(Debug, Clone)]
pub struct PropertySet {
    pub name: String,
    pub properties: Vec<PropValue>,
}

/// A single physical quantity (`IfcQuantityLength`/`Area`/`Volume`/…).
#[derive(Debug, Clone)]
pub struct QuantityValue {
    pub name: String,
    pub value: f64,
    /// `Length` | `Area` | `Volume` | `Count` | `Weight` | `Time`.
    pub kind: &'static str,
}

/// A named quantity set (`IfcElementQuantity`).
#[derive(Debug, Clone)]
pub struct QuantitySet {
    pub name: String,
    pub quantities: Vec<QuantityValue>,
}

/// One exportable entity row (an `IfcProduct` occurrence).
#[derive(Debug, Clone)]
pub struct EntityRow {
    pub express_id: u32,
    pub ifc_type: String,
    pub global_id: Option<String>,
    pub name: Option<String>,
    pub description: Option<String>,
    pub object_type: Option<String>,
    /// True when the product carries a geometric Representation (attr 6).
    pub has_geometry: bool,
    pub property_sets: Vec<PropertySet>,
    pub quantity_sets: Vec<QuantitySet>,
}

impl EntityRow {
    /// Look up a flattened `PsetName.PropName` value (case-sensitive), then quantities.
    pub fn lookup(&self, pset: &str, prop: &str) -> Option<String> {
        for ps in &self.property_sets {
            if ps.name == pset {
                for p in &ps.properties {
                    if p.name == prop {
                        return Some(p.value.clone());
                    }
                }
            }
        }
        for qs in &self.quantity_sets {
            if qs.name == pset {
                for q in &qs.quantities {
                    if q.name == prop {
                        return Some(fmt_num(q.value));
                    }
                }
            }
        }
        None
    }
}

/// The full extracted model.
#[derive(Debug, Clone)]
pub struct ExportModel {
    pub entities: Vec<EntityRow>,
}

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
fn map_enum(e: &str) -> String {
    match e {
        "T" => "true".to_string(),
        "F" => "false".to_string(),
        "U" => "unknown".to_string(),
        other => other.to_string(),
    }
}

/// Render an `AttributeValue` (single property value) to `(display, type_tag)`.
/// Typed values like `IFCLABEL('x')` decode to `List([String("IFCLABEL"), inner])`.
fn render_value(v: &AttributeValue) -> Option<(String, String)> {
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
fn quantity_kind(ty: IfcType) -> Option<&'static str> {
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

fn opt_string(av: Option<&AttributeValue>) -> Option<String> {
    av.and_then(|a| a.as_string()).map(|s| s.to_string()).filter(|s| !s.is_empty())
}

/// Decode one `IfcPropertySet` definition into our model.
fn decode_property_set(decoder: &mut EntityDecoder, def: &DecodedEntity) -> Option<PropertySet> {
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
fn decode_quantity_set(decoder: &mut EntityDecoder, def: &DecodedEntity) -> Option<QuantitySet> {
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

/// Build the export model from raw IFC/STEP bytes.
pub fn build_export_model(content: &[u8]) -> ExportModel {
    let entity_index = build_entity_index(content);
    let mut decoder = EntityDecoder::with_index(content, entity_index);

    // Pass 1 — object → attached property/quantity definitions (IfcRelDefinesByProperties).
    // IfcRelDefinesByProperties: [GlobalId, OwnerHistory, Name, Description,
    //                             RelatedObjects(4, list), RelatingPropertyDefinition(5, ref)]
    let mut defs_by_object: HashMap<u32, Vec<u32>> = HashMap::new();
    {
        let mut scanner = EntityScanner::new(content);
        while let Some((id, type_name, start, end)) = scanner.next_entity() {
            if type_name != "IFCRELDEFINESBYPROPERTIES" {
                continue;
            }
            let rel = match decoder.decode_at_with_id(id, start, end) {
                Ok(e) => e,
                Err(_) => continue,
            };
            let def_id = match rel.get(5).and_then(|a| a.as_entity_ref()) {
                Some(d) => d,
                None => continue,
            };
            if let Some(objs) = rel.get(4).and_then(|a| a.as_list()) {
                for o in objs {
                    if let Some(oid) = o.as_entity_ref() {
                        defs_by_object.entry(oid).or_default().push(def_id);
                    }
                }
            }
        }
    }

    // Pass 2 — emit a row per IfcProduct occurrence, resolving its property/quantity sets.
    let mut entities = Vec::new();
    let mut scanner = EntityScanner::new(content);
    while let Some((id, _type_name, start, end)) = scanner.next_entity() {
        let entity = match decoder.decode_at_with_id(id, start, end) {
            Ok(e) => e,
            Err(_) => continue,
        };
        if !entity.ifc_type.is_subtype_of(IfcType::IfcProduct) {
            continue;
        }
        // PascalCase canonical name (IfcWall), not the STEP keyword (IFCWALL).
        let ifc_type = entity.ifc_type.name().to_string();
        let global_id = opt_string(entity.get(0));
        let name = opt_string(entity.get(2));
        let description = opt_string(entity.get(3));
        let object_type = opt_string(entity.get(4));
        let has_geometry = entity.get(6).is_some_and(|a| !a.is_null());

        let mut property_sets = Vec::new();
        let mut quantity_sets = Vec::new();
        if let Some(def_ids) = defs_by_object.get(&id).cloned() {
            for def_id in def_ids {
                let def = match decoder.decode_by_id(def_id) {
                    Ok(d) => d,
                    Err(_) => continue,
                };
                match def.ifc_type {
                    IfcType::IfcPropertySet => {
                        if let Some(ps) = decode_property_set(&mut decoder, &def) {
                            if !ps.properties.is_empty() {
                                property_sets.push(ps);
                            }
                        }
                    }
                    IfcType::IfcElementQuantity => {
                        if let Some(qs) = decode_quantity_set(&mut decoder, &def) {
                            if !qs.quantities.is_empty() {
                                quantity_sets.push(qs);
                            }
                        }
                    }
                    _ => {}
                }
            }
        }

        entities.push(EntityRow {
            express_id: id,
            ifc_type,
            global_id,
            name,
            description,
            object_type,
            has_geometry,
            property_sets,
            quantity_sets,
        });
    }

    ExportModel { entities }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(rel: &str) -> Vec<u8> {
        let path = format!("{}/../../tests/models/{}", env!("CARGO_MANIFEST_DIR"), rel);
        std::fs::read(&path).unwrap_or_else(|e| panic!("read {path}: {e}"))
    }

    #[test]
    fn duplex_model_has_products_and_psets() {
        let model = build_export_model(&fixture("ara3d/duplex.ifc"));
        assert!(model.entities.len() > 50, "expected many products, got {}", model.entities.len());

        // Every row carries a GlobalId + type.
        for e in &model.entities {
            assert!(!e.ifc_type.is_empty());
        }
        assert!(model.entities.iter().any(|e| e.global_id.is_some()), "some GlobalIds");

        // At least one element carries property sets with named single values.
        let with_psets = model.entities.iter().filter(|e| !e.property_sets.is_empty()).count();
        assert!(with_psets > 0, "expected elements with property sets");
        let any_prop = model
            .entities
            .iter()
            .flat_map(|e| &e.property_sets)
            .flat_map(|ps| &ps.properties)
            .next();
        let p = any_prop.expect("at least one property");
        assert!(!p.name.is_empty() && !p.value_type.is_empty());
    }

    #[test]
    fn fmt_num_is_clean() {
        assert_eq!(fmt_num(1.0), "1");
        assert_eq!(fmt_num(1.5), "1.5");
        assert_eq!(fmt_num(2.500000), "2.5");
        assert_eq!(fmt_num(0.0), "0");
    }
}
