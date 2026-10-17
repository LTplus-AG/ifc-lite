// SPDX-License-Identifier: MPL-2.0
//! Property and quantity decoding for the attribute export.
//!
//! Split from `model.rs` under the house rule (AGENTS.md): these turn one
//! `IfcPropertySet` / `IfcElementQuantity` definition into the flattened rows
//! `EntityRow` carries, and have nothing to do with the streaming pass that
//! calls them.

use ifc_lite_core::{slot, AttributeValue, DecodedEntity, EntityDecoder, IfcType};
use ifc_lite_processing::data_model::property::{
    PropertyDecoder, PropertyKind, PropertyRow, PropertyScope,
};

use super::{PropValue, PropertySet, QuantitySet, QuantityValue, ValueKind};

pub use ifc_lite_core::fmt_num::fmt_num;

/// Map an IFC boolean/logical enum token to a friendly string.
pub(super) fn map_enum(e: &str) -> String {
    match e {
        "T" => "true".to_string(),
        "F" => "false".to_string(),
        "U" => "unknown".to_string(),
        other => other.to_string(),
    }
}

/// A property value rendered for the flat exports.
pub(super) struct Rendered {
    pub value: String,
    pub value_type: String,
    pub kind: ValueKind,
}

/// Render an `AttributeValue` (single property value) to its display string,
/// type tag and primitive kind. Typed values like `IFCLABEL('x')` decode to
/// [`AttributeValue::Typed`]; the kind comes from its value. A list is not a
/// single value and renders nothing (it used to render its second item under
/// its first item's name when the first was a string, F3c).
pub(super) fn render_value(v: &AttributeValue) -> Option<Rendered> {
    let rendered = |value: String, tag: &str, kind| Rendered { value, value_type: tag.to_string(), kind };
    match v {
        AttributeValue::String(s) | AttributeValue::Binary(s) => Some(rendered(s.clone(), "IFCTEXT", ValueKind::Text)),
        AttributeValue::Integer(i) => Some(rendered(i.to_string(), "IFCINTEGER", ValueKind::Number)),
        AttributeValue::Float(f) => Some(rendered(fmt_num(*f), "IFCREAL", ValueKind::Number)),
        AttributeValue::Enum(e) => {
            let kind = if matches!(e.as_str(), "T" | "F") { ValueKind::Bool } else { ValueKind::Text };
            Some(rendered(map_enum(e), "IFCBOOLEAN", kind))
        }
        AttributeValue::Typed { name, value } => {
            let inner = render_value(value)?;
            Some(Rendered { value_type: name.to_string(), ..inner })
        }
        // Entity-ref-valued properties (rare for NominalValue) aren't rendered inline.
        AttributeValue::List(_)
        | AttributeValue::EntityRef(_)
        | AttributeValue::Null
        | AttributeValue::Derived => None,
    }
}

/// Attribute names every rooted entity carries, which the row already surfaces
/// as dedicated fields or which are references the flattened export cannot
/// render. Skipped so `attributes` holds only what the entity class adds.
const COMMON_ATTRIBUTES: [&str; 7] = [
    "GlobalId",
    "OwnerHistory",
    "Name",
    "Description",
    "ObjectType",
    "ObjectPlacement",
    "Representation",
];

/// Render the attributes an entity's own IFC class declares, by schema name.
///
/// These are not property sets and no `IfcRelDefinesByProperties` points at
/// them: `IfcReinforcingBar.NominalDiameter`, `IfcDoor.OverallHeight` and their
/// like are declared directly on the entity, so a consumer reading only psets
/// cannot see them however inheritance is configured.
///
/// `raw_type_name` is the STEP keyword as written in the file (e.g.
/// `"IFCDOORSTYLE"`). Its source-schema registry, rather than the merged
/// canonical universe, determines its positional attribute names. Unknown
/// source schemas and entities emit no names rather than borrowing another
/// version's layout.
///
/// Values reuse [`render_value`], so a rendered attribute reads the same as a
/// property with the same underlying type, and anything it declines (entity
/// references, `$`, derived `*`) is omitted rather than emitted as a dangling
/// `#123`. Order follows the schema's attribute order, which is stable.
pub(super) fn render_attributes(
    entity: &DecodedEntity, raw_type_name: &str, source_schema: Option<&str>,
) -> Vec<PropValue> {
    let names: &[&str] = source_schema
        .and_then(|schema| ifc_lite_core::attribute_names_for_schema(schema, raw_type_name))
        .unwrap_or(&[]);
    let mut out = Vec::new();
    for (i, name) in names.iter().enumerate() {
        if COMMON_ATTRIBUTES.contains(name) {
            continue;
        }
        let Some(v) = entity.get(i) else { continue };
        if let Some(Rendered { value, mut value_type, kind }) = render_value(v) {
            // `render_value` tags every bare enum `IFCBOOLEAN`, which is right
            // for a property's NominalValue (there the tokens are the T/F/U
            // logicals) and wrong here, where `.NOTDEFINED.` and `.PLAIN.` are
            // ordinary enumerations. Tagging those boolean invites a consumer
            // to parse them as one.
            if matches!(v, AttributeValue::Enum(e) if !matches!(e.as_str(), "T" | "F" | "U")) {
                value_type = "IFCENUM".to_string();
            }
            out.push(PropValue {
                name: (*name).to_string(),
                value,
                value_type,
                kind,
            });
        }
    }
    out
}

/// Quantity kind + value-attribute index for an `IfcPhysicalSimpleQuantity`.
/// Layout is uniform: `[Name, Description, Unit, <Value>]` ⇒ value at index 3.
/// Where every simple quantity (`IfcQuantityLength`, `Area`, `Volume`, `Count`,
/// `Number`, `Weight`, `Time`) keeps its value. The seven classes share no
/// supertype that declares it, so the position is named once here and the
/// assertions below fail the build if any class disagrees.
const QUANTITY_VALUE: usize = slot::IfcQuantityLength::LENGTH_VALUE.index();
const _: () = {
    assert!(slot::IfcQuantityArea::AREA_VALUE.index() == QUANTITY_VALUE);
    assert!(slot::IfcQuantityVolume::VOLUME_VALUE.index() == QUANTITY_VALUE);
    assert!(slot::IfcQuantityCount::COUNT_VALUE.index() == QUANTITY_VALUE);
    assert!(slot::IfcQuantityNumber::NUMBER_VALUE.index() == QUANTITY_VALUE);
    assert!(slot::IfcQuantityWeight::WEIGHT_VALUE.index() == QUANTITY_VALUE);
    assert!(slot::IfcQuantityTime::TIME_VALUE.index() == QUANTITY_VALUE);
};

fn quantity_kind(ty: IfcType, mode: QuantityDecodeMode) -> Option<&'static str> {
    match ty {
        IfcType::IfcQuantityLength => Some("Length"),
        IfcType::IfcQuantityArea => Some("Area"),
        IfcType::IfcQuantityVolume => Some("Volume"),
        IfcType::IfcQuantityCount => Some("Count"),
        IfcType::IfcQuantityNumber if matches!(mode, QuantityDecodeMode::AuthoredAnalysis) => {
            Some("Number")
        }
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

/// The property kinds the flat exports write.
///
/// **Single values only, on purpose (EXPORT-DATA-2, D47 pending).** The
/// shared decoder reads all seven kinds, but CSV, JSON, JSON-LD, IFCX, USD,
/// BOS and the Python `entity_data` have only ever carried
/// `IfcPropertySingleValue`; an enumerated, list, bounded, table, reference or
/// complex property is absent from them, and the set still appears with those
/// entries missing. Writing them is user-visible (new rows in every format and
/// in the goldens), so it waits for a maintainer decision. It is one change
/// here: `PropertyScope::AllKinds`. [`flat_property`] already renders them
/// (D47: the columnar display string, `kind = Text`).
pub(super) const EXPORT_PROPERTY_SCOPE: PropertyScope = PropertyScope::SingleValueOnly;

/// The model's property decoder: one per export, so one complex-property
/// budget per model (#7675).
pub(super) fn new_property_decoder(input_len: usize) -> PropertyDecoder {
    PropertyDecoder::for_input(input_len, EXPORT_PROPERTY_SCOPE)
}

/// One decoded property in the flat exports' shape; `None` for a nameless
/// property or one with no value to show.
pub(super) fn flat_property(row: &PropertyRow) -> Option<PropValue> {
    if row.name.is_empty() {
        return None;
    }
    if let Some(nominal) = &row.nominal {
        let Rendered { value, value_type, kind } = render_value(nominal)?;
        return Some(PropValue { name: row.name.clone(), value, value_type, kind });
    }
    if row.kind == PropertyKind::Single {
        return None;
    }
    // D47: the columnar display string as text, typed by the members' shared
    // tag when they have one, else by the property class.
    let display = row.display.as_ref().filter(|d| d.property_type != "null")?;
    Some(PropValue {
        name: row.name.clone(),
        value: display.property_value.clone(),
        value_type: display.data_type.clone().unwrap_or_else(|| row.kind.class_keyword().to_string()),
        kind: ValueKind::Text,
    })
}

#[cfg(test)]
#[path = "model_props_tests.rs"]
mod props_tests;

/// Decode one `IfcPropertySet` definition into our model.
pub(super) fn decode_property_set(
    props: &mut PropertyDecoder, decoder: &mut EntityDecoder, def: &DecodedEntity,
) -> Option<PropertySet> {
    let row = props.decode_set(decoder, def)?;
    let properties = row.properties.iter().filter_map(flat_property).collect();
    Some(PropertySet { name: row.name.unwrap_or_default(), properties })
}

/// Decode one `IfcElementQuantity` definition into our model.
pub(super) fn decode_quantity_set(decoder: &mut EntityDecoder, def: &DecodedEntity) -> Option<QuantitySet> {
    let decoded = decode_quantity_records(decoder, def, None, QuantityDecodeMode::FlatExport)?;
    let quantities = decoded.records.into_iter().map(|record| record.value).collect();
    Some(QuantitySet { name: decoded.name, quantities })
}

/// The quantity kinds each consumer has historically read.
#[derive(Clone, Copy)]
pub(crate) enum QuantityDecodeMode {
    /// Preserve the existing flat-export set of kinds.
    FlatExport,
    /// Include IFC4X3 Number in the opt-in view.
    AuthoredAnalysis,
}

pub(crate) struct QuantityRecord {
    pub id: u32,
    pub unit_id: Option<u32>,
    pub invalid_unit_ref: bool,
    pub value: QuantityValue,
}

pub(crate) struct QuantityRecordDecode {
    pub name: String,
    pub records: Vec<QuantityRecord>,
    pub rejected_members: usize,
    pub first_rejected_id: Option<u32>,
}

/// Parse physical quantities once while preserving the provenance needed by the
/// opt-in view. Flat exports discard that metadata and retain their old scope.
pub(crate) fn decode_quantity_records(
    decoder: &mut EntityDecoder, def: &DecodedEntity, max_members: Option<usize>,
    mode: QuantityDecodeMode,
) -> Option<QuantityRecordDecode> {
    let name = def.string_at(slot::IfcElementQuantity::NAME).unwrap_or("").to_string();
    let quantities_attr = def.attr(slot::IfcElementQuantity::QUANTITIES)?;
    if max_members.is_some_and(|max| quantities_attr.as_list().is_none_or(|items| items.len() > max)) {
        return None;
    }
    let quants = decoder.resolve_ref_list(quantities_attr).ok()?;
    let mut records = Vec::new();
    let mut rejected_members = 0;
    let mut first_rejected_id = None;
    for q in &quants {
        // The slots are read only for a class that has them: a leaf that is not
        // a quantity (an `IfcPropertySingleValue`) is a rejected member.
        let parsed = quantity_kind(q.ifc_type.clone(), mode).and_then(|kind| {
            let qname = q.string_at(slot::IfcPhysicalQuantity::NAME).filter(|name| !name.is_empty())?;
            // as_float already accepts STEP integers, including authored Count.
            Some((kind, qname, q.real_at(QUANTITY_VALUE)?))
        });
        let Some((kind, qname, value)) = parsed else {
            rejected_members += 1;
            first_rejected_id.get_or_insert(q.id);
            continue;
        };
        records.push(QuantityRecord {
            id: q.id,
            unit_id: q.ref_at(slot::IfcPhysicalSimpleQuantity::UNIT),
            invalid_unit_ref: q.attr(slot::IfcPhysicalSimpleQuantity::UNIT).is_some_and(|unit| !unit.is_null() && unit.as_entity_ref().is_none()),
            value: QuantityValue { name: qname.to_string(), value, kind },
        });
    }
    Some(QuantityRecordDecode { name, records, rejected_members, first_rejected_id })
}

/// Resolve a list of property/quantity set definition ids into non-empty
/// `(property_sets, quantity_sets)`, dropping undecodable refs. Shared by the
/// product path (ids from `IfcRelDefinesByProperties`) and the type-product path
/// (ids from `IfcTypeObject.HasPropertySets`), so both classify a definition the
/// same way.
pub(super) fn resolve_pset_defs(
    props: &mut PropertyDecoder,
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
                if let Some(ps) = decode_property_set(props, decoder, &def) {
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

#[cfg(test)]
mod tests {
    use super::*;

    fn s(text: &str) -> AttributeValue {
        AttributeValue::String(text.to_owned())
    }

    /// CORE-4 (#7776): `IfcPerson.MiddleNames ('Anne','Marie')` is a list of
    /// two strings. It rendered as the value `Marie` tagged `Anne`.
    #[test]
    fn a_two_string_list_is_not_a_typed_value_core_4_7776() {
        assert!(render_value(&AttributeValue::List(vec![s("Anne"), s("Marie")])).is_none());
        let typed = AttributeValue::Typed { name: "IFCLABEL".into(), value: Box::new(s("Marie")) };
        let rendered = render_value(&typed).expect("a typed value renders");
        assert_eq!((rendered.value.as_str(), rendered.value_type.as_str()), ("Marie", "IFCLABEL"));
    }
}
