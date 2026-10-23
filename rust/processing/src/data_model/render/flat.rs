// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! The flat encoder: `AttributeValue` and decoded property rows into the
//! `PropValue` / `PropertySet` shape CSV, JSON, JSON-LD, IFCX, USD, BOS and
//! the Python binding read (D41). The other encoder is `render::columnar`.
//!
//! Moved from `rust/export/src/model_props.rs` (C6-8, #7783).

use super::super::property::{PropertyDecoder, PropertyKind, PropertyRow, PropertyScope};
use super::super::quantity::decode_quantity_set;
use super::super::rows::{PropValue, PropertySet, QuantitySet, ValueKind};
use std::collections::HashSet;

use ifc_lite_core::{slot, AttributeValue, DecodedEntity, EntityDecoder, IfcType};

pub use ifc_lite_core::fmt_num::fmt_num;

/// Map an IFC boolean/logical enum token to a friendly string.
pub fn map_enum(e: &str) -> String {
    match e {
        "T" => "true".to_string(),
        "F" => "false".to_string(),
        "U" => "unknown".to_string(),
        other => other.to_string(),
    }
}

/// A property value rendered for the flat exports.
pub struct Rendered {
    pub value: String,
    pub value_type: String,
    pub kind: ValueKind,
}

/// Render an `AttributeValue` (single property value) to its display string,
/// type tag and primitive kind. Typed values like `IFCLABEL('x')` decode to
/// [`AttributeValue::Typed`]; the kind comes from its value. A list is not a
/// single value and renders nothing (it used to render its second item under
/// its first item's name when the first was a string, F3c).
pub fn render_value(v: &AttributeValue) -> Option<Rendered> {
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
pub fn render_attributes(
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

pub fn opt_string(av: Option<&AttributeValue>) -> Option<String> {
    av.and_then(|a| a.as_string()).map(|s| s.to_string()).filter(|s| !s.is_empty())
}

/// Collect the entity references in a STEP list attribute (e.g. `(#44,#45)`),
/// dropping nulls/non-refs. An absent or `$` attribute yields an empty `Vec`.
pub fn ref_list(av: Option<&AttributeValue>) -> Vec<u32> {
    av.and_then(|a| a.as_list())
        .map(|items| items.iter().filter_map(|v| v.as_entity_ref()).collect())
        .unwrap_or_default()
}

/// The property kinds the flat exports write: all seven (EXPORT-DATA-2, D47).
///
/// CSV, JSON, JSON-LD, IFCX, USD, BOS and the Python `entity_data` carry an
/// `IfcPropertySingleValue` as its raw nominal value, and every other kind
/// (enumerated, list, bounded, table, reference, complex) as the columnar
/// display string the server and the viewer show, typed `kind = Text` with
/// `value_type` = the members' shared type tag, else the property class
/// keyword ([`flat_property`]). Complex properties are walked under the
/// model's one complex-property budget (#7675), charged in the order the
/// stream decodes the sets.
pub const EXPORT_PROPERTY_SCOPE: PropertyScope = PropertyScope::Flat;

/// The model's property decoder: one per export, so one complex-property
/// budget per model (#7675).
pub fn new_property_decoder(input_len: usize) -> PropertyDecoder {
    PropertyDecoder::for_input(input_len, EXPORT_PROPERTY_SCOPE)
}

/// One decoded property in the flat exports' shape; `None` for a nameless
/// property or one with no value to show.
pub fn flat_property(row: &PropertyRow) -> Option<PropValue> {
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
#[path = "flat_tests.rs"]
mod props_tests;

/// Decode one `IfcPropertySet` definition into our model.
pub fn decode_property_set(
    props: &mut PropertyDecoder, decoder: &mut EntityDecoder, def: &DecodedEntity,
) -> Option<PropertySet> {
    decode_property_set_with_kinds(props, decoder, def, None)
}

fn decode_property_set_with_kinds(
    props: &mut PropertyDecoder, decoder: &mut EntityDecoder, def: &DecodedEntity,
    mut kinds: Option<&mut Vec<PropertyKind>>,
) -> Option<PropertySet> {
    let row = props.decode_set(decoder, def)?;
    let properties = row.properties.iter().filter_map(|row| {
        let value = flat_property(row)?;
        if let Some(kinds) = kinds.as_deref_mut() { kinds.push(row.kind); }
        Some(value)
    }).collect();
    Some(PropertySet { name: row.name.unwrap_or_default(), properties })
}

/// Resolve a list of property/quantity set definition ids into non-empty
/// `(property_sets, quantity_sets)`, dropping undecodable refs. `kinds`, when
/// given, receives each kept property set's per-property kinds. Types read
/// their sets through [`resolve_type_sets`], which classifies each definition
/// with the same [`resolve_def`].
pub(crate) fn resolve_pset_defs_with_kinds(
    props: &mut PropertyDecoder,
    decoder: &mut EntityDecoder,
    def_ids: &[u32],
    mut kinds: Option<&mut Vec<Vec<PropertyKind>>>,
) -> (Vec<PropertySet>, Vec<QuantitySet>) {
    let mut property_sets = Vec::new();
    let mut quantity_sets = Vec::new();
    for &def_id in def_ids {
        let mut set_kinds = Vec::new();
        let capture = kinds.is_some().then_some(&mut set_kinds);
        match resolve_def(props, decoder, def_id, capture) {
            Some((_, Resolved::Properties(ps))) => {
                if let Some(kinds) = kinds.as_deref_mut() { kinds.push(set_kinds); }
                property_sets.push(ps);
            }
            Some((_, Resolved::Quantities(qs))) => quantity_sets.push(qs),
            None => {}
        }
    }
    (property_sets, quantity_sets)
}

/// A resolved, non-empty set definition, and whether it is a quantity set.
enum Resolved {
    Properties(PropertySet),
    Quantities(QuantitySet),
}

/// One definition, resolved, with the entity it was read from. `None` for an
/// undecodable ref, anything that is not a property or quantity set, and a set
/// with no entry this export decodes. `kinds` captures each kept property's
/// kind, as in [`decode_property_set_with_kinds`].
fn resolve_def(
    props: &mut PropertyDecoder,
    decoder: &mut EntityDecoder,
    def_id: u32,
    kinds: Option<&mut Vec<PropertyKind>>,
) -> Option<(DecodedEntity, Resolved)> {
    let def = decoder.decode_by_id(def_id).ok()?;
    let set = match def.ifc_type {
        IfcType::IfcPropertySet => decode_property_set_with_kinds(props, decoder, &def, kinds)
            .filter(|ps| !ps.properties.is_empty())
            .map(Resolved::Properties),
        IfcType::IfcElementQuantity => {
            decode_quantity_set(decoder, &def).filter(|qs| !qs.quantities.is_empty()).map(Resolved::Quantities)
        }
        _ => None,
    }?;
    Some((def, set))
}

/// The sets a type carries, read the way the TS type extractor reads them:
/// its own `HasPropertySets` first, then the definitions
/// `IfcRelDefinesByProperties` attaches to it. Each definition id is read once
/// across both. A relationship-attached set is also skipped when a set already
/// taken has the same Name and GlobalId, so one set written twice under two
/// ids is not inherited twice. Only non-empty sets take part, so an empty set
/// never hides a populated one.
pub(crate) fn resolve_type_sets(
    props: &mut PropertyDecoder,
    decoder: &mut EntityDecoder,
    has_property_sets: Vec<u32>,
    related: &[u32],
) -> (Vec<PropertySet>, Vec<QuantitySet>) {
    let mut seen_ids = HashSet::new();
    let (mut psets, mut qsets) = (Vec::new(), Vec::new());
    let mut seen_keys = HashSet::new();
    // HasPropertySets entries are always taken and only record their key;
    // relationship-attached ones are skipped when the key is already taken.
    let first = has_property_sets.into_iter().map(|id| (id, false));
    let fresh = related.iter().map(|&id| (id, true));
    for (id, skippable) in first.chain(fresh) {
        if !seen_ids.insert(id) { continue; }
        let Some((def, set)) = resolve_def(props, decoder, id, None) else { continue };
        let gid = def.string_at(slot::IfcRoot::GLOBAL_ID).unwrap_or("");
        let (is_qset, name) = match &set {
            Resolved::Properties(ps) => (false, &ps.name),
            Resolved::Quantities(qs) => (true, &qs.name),
        };
        // Property and quantity sets are keyed apart, as the TS extractor
        // resolves them as separate lists. A set with neither a Name nor a
        // GlobalId has no identity beyond its id.
        let has_identity = !name.is_empty() || !gid.is_empty();
        if has_identity && !seen_keys.insert((is_qset, name.clone(), gid.to_owned())) && skippable {
            continue;
        }
        match set {
            Resolved::Properties(ps) => psets.push(ps),
            Resolved::Quantities(qs) => qsets.push(qs),
        }
    }
    (psets, qsets)
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
