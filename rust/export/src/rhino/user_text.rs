// SPDX-License-Identifier: MPL-2.0
//! Object user text: `<group>::<name>` keys, as Rhino's Attribute User Text
//! panel shows them. A reader splits at the first `::`, so a `::` inside a
//! pset or property name becomes `:` (the layer-name rule).
//!
//! An element's text is built once; every object of the element gets a copy,
//! differing only in `IFC::Material` (each part's own material).

use std::collections::HashMap;

use ifc_lite_core::fmt_num::fmt_num;

use super::elements::Facts;
use super::names::{clean_name, fold_case, NameSet};
use super::options::RhinoProperties;
use super::source::{attribute, ModelInfo};
use crate::model::{EntityRow, Inherited, PropValue, ValueKind};

/// A key and its [`fold_case`] form, so each key is folded once per export.
type Key<'k> = (&'k str, &'k str);

/// The fixed keys, folded by hand (a test checks them against [`fold_case`]).
const GLOBAL_ID: Key = ("IFC::GlobalId", "ifc::globalid");
const CLASS: Key = ("IFC::Class", "ifc::class");
const EXPRESS_ID: Key = ("IFC::ExpressId", "ifc::expressid");
const NAME: Key = ("IFC::Name", "ifc::name");
const DESCRIPTION: Key = ("IFC::Description", "ifc::description");
const OBJECT_TYPE: Key = ("IFC::ObjectType", "ifc::objecttype");
const TAG: Key = ("IFC::Tag", "ifc::tag");
const PREDEFINED_TYPE: Key = ("IFC::PredefinedType", "ifc::predefinedtype");
const CONTAINER: Key = ("IFC::Container", "ifc::container");
const CONTAINER_GLOBAL_ID: Key = ("IFC::ContainerGlobalId", "ifc::containerglobalid");
const TYPE: Key = ("IFC::Type", "ifc::type");
const TYPE_GLOBAL_ID: Key = ("IFC::TypeGlobalId", "ifc::typeglobalid");
const MATERIAL: Key = ("IFC::Material", "ifc::material");
const PRESENTATION_LAYER: Key = ("IFC::PresentationLayer", "ifc::presentationlayer");

/// One element's user text, built once and copied onto each of its objects.
/// A repeated key is renamed ` #2`, ` #3`, remembering that it had to. Keys
/// repeat ignoring case: openNURBS stores `IFC::Name` and `ifc::name` as one
/// key, the later value winning.
pub(super) struct UserText {
    pairs: Vec<(String, String)>,
    keys: NameSet,
    /// Where each object's `IFC::Material` goes, when the level writes it.
    material_at: Option<usize>,
    /// The first key that had to be renamed, if any.
    pub(super) first_collision: Option<String>,
}

impl UserText {
    fn new() -> Self {
        Self { pairs: Vec::new(), keys: NameSet::default(), material_at: None, first_collision: None }
    }

    /// Add `key = value`; an empty value is omitted, never written as `""`.
    fn push(&mut self, (key, folded): Key<'_>, value: &str) {
        if value.is_empty() {
            return;
        }
        let key = if self.keys.claim_folded(folded) {
            key.to_string()
        } else {
            self.first_collision.get_or_insert_with(|| key.to_string());
            self.keys.claim((2..).map(|n| format!("{key} #{n}")))
        };
        self.pairs.push((key, value.to_string()));
    }

    /// Hold `IFC::Material`'s place for the per-object value. The key stays
    /// taken even for a part without a material, so every part's other keys
    /// are the same.
    fn reserve_material(&mut self) {
        self.keys.claim_folded(MATERIAL.1);
        self.material_at = Some(self.pairs.len());
    }

    /// The strings of one object, with that part's `material`.
    pub(super) fn for_part(&self, material: Option<&str>) -> Vec<(String, String)> {
        match (self.material_at, material.filter(|m| !m.is_empty())) {
            (Some(at), Some(m)) => {
                let mut pairs = Vec::with_capacity(self.pairs.len() + 1);
                pairs.extend_from_slice(&self.pairs[..at]);
                pairs.push((MATERIAL.0.to_string(), m.to_string()));
                pairs.extend_from_slice(&self.pairs[at..]);
                pairs
            }
            _ => self.pairs.clone(),
        }
    }

    /// [`UserText::for_part`] for the element's last object, taking the
    /// strings instead of copying them.
    pub(super) fn into_part(self, material: Option<&str>) -> Vec<(String, String)> {
        let mut pairs = self.pairs;
        if let (Some(at), Some(m)) = (self.material_at, material.filter(|m| !m.is_empty())) {
            pairs.insert(at, (MATERIAL.0.to_string(), m.to_string()));
        }
        pairs
    }
}

/// Export-wide memo of what many elements share: sanitised set/entry keys
/// and container labels.
#[derive(Default)]
pub(super) struct TextCache<'r> {
    /// `(set name, entry name, is quantity)` → `<set>::<entry>` and its fold.
    keys: HashMap<(&'r str, &'r str, bool), (String, String)>,
    /// Container id → (display name, GlobalId).
    containers: HashMap<u32, (String, Option<&'r str>)>,
}

impl<'r> TextCache<'r> {
    fn key(&mut self, set: &'r str, entry: &'r str, quantity: bool) -> Key<'_> {
        let (key, folded) = self.keys.entry((set, entry, quantity)).or_insert_with(|| {
            let (set_fallback, entry_fallback) = if quantity { ("Qto", "Quantity") } else { ("Pset", "Property") };
            let key = format!("{}::{}", key_part(set, set_fallback), key_part(entry, entry_fallback));
            let folded = fold_case(&key);
            (key, folded)
        });
        (key, folded)
    }

    fn container(&mut self, info: &'r ModelInfo, id: u32) -> &(String, Option<&'r str>) {
        self.containers
            .entry(id)
            .or_insert_with(|| (info.node_name(id), info.rows.get(&id).and_then(|r| r.global_id.as_deref())))
    }
}

/// A key part: the layer-name rule (no `::`, no control characters, trimmed)
/// plus no leading `.` (Rhino hides such keys); `fallback` when nothing is left.
/// A leading bracket stays: openNURBS stores such keys as written.
fn key_part(raw: &str, fallback: &str) -> String {
    clean_name(raw)
        // No `:` at either edge, so a part never touches the `::` separator (`A:` + `::` + `B`
        // would read back as `A` / `:B`). The leading `.` would hide the key in Rhino.
        .map(|s| {
            s.trim_start_matches(|c: char| c == '.' || c == ':' || c.is_whitespace())
                .trim_end_matches(|c: char| c == ':' || c.is_whitespace())
                .to_string()
        })
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| fallback.to_string())
}

/// A property value as written: booleans `TRUE` / `FALSE`, the unknown
/// logical `UNKNOWN`, everything else as the export data model renders it
/// (numbers through the shared formatter, lists joined with `, `).
fn property_value(p: &PropValue) -> String {
    match p.kind {
        ValueKind::Bool => p.value.to_ascii_uppercase(),
        _ if p.value_type.eq_ignore_ascii_case("IFCLOGICAL") && p.value.eq_ignore_ascii_case("unknown") => "UNKNOWN".to_string(),
        _ => p.value.clone(),
    }
}

/// Every user string of element `id`, in table order: identity, attributes,
/// then the element's own property and quantity entries, then inherited ones
/// (so an own entry claims a key first). `facts` carry the row-resolved
/// GlobalId and Name; rows carry sets only when properties are `all`.
pub(super) fn element_text<'r>(
    info: &'r ModelInfo,
    cache: &mut TextCache<'r>,
    id: u32,
    facts: &Facts<'_>,
    properties: RhinoProperties,
) -> UserText {
    let mut t = UserText::new();
    t.push(GLOBAL_ID, facts.global_id.unwrap_or_default());
    t.push(CLASS, facts.ifc_type);
    t.push(EXPRESS_ID, &id.to_string());
    if properties != RhinoProperties::None {
        let row = info.rows.get(&id);
        t.push(NAME, facts.name.unwrap_or_default());
        if let Some(r) = row {
            t.push(DESCRIPTION, r.description.as_deref().unwrap_or_default());
            t.push(OBJECT_TYPE, r.object_type.as_deref().unwrap_or_default());
            t.push(TAG, attribute(r, "Tag").unwrap_or_default());
            t.push(PREDEFINED_TYPE, attribute(r, "PredefinedType").unwrap_or_default());
        }
        if let Some(c) = info.container(id) {
            let (name, global_id) = cache.container(info, c);
            let global_id = global_id.unwrap_or_default();
            t.push(CONTAINER, name);
            t.push(CONTAINER_GLOBAL_ID, global_id);
        }
        if let Some(ty) = info.type_of.get(&id).and_then(|t| info.types.get(t)) {
            t.push(TYPE, ty.name.as_deref().unwrap_or_default());
            t.push(TYPE_GLOBAL_ID, ty.global_id.as_deref().unwrap_or_default());
        }
        t.reserve_material();
        t.push(PRESENTATION_LAYER, facts.presentation_layer.unwrap_or_default());
        if let Some(r) = row {
            let inherited = info.inherited.get(&id);
            for want_inherited in [false, true] {
                push_sets(&mut t, cache, r, inherited, want_inherited);
            }
        }
    }
    t
}

fn push_sets<'r>(t: &mut UserText, cache: &mut TextCache<'r>, r: &'r EntityRow, inherited: Option<&Inherited>, want_inherited: bool) {
    for (si, ps) in r.property_sets.iter().enumerate() {
        for (ei, p) in ps.properties.iter().enumerate() {
            if inherited.is_some_and(|i| i.property(si, ei)) == want_inherited {
                t.push(cache.key(&ps.name, &p.name, false), &property_value(p));
            }
        }
    }
    for (si, qs) in r.quantity_sets.iter().enumerate() {
        for (ei, q) in qs.quantities.iter().enumerate() {
            if inherited.is_some_and(|i| i.quantity(si, ei)) == want_inherited && q.value.is_finite() {
                t.push(cache.key(&qs.name, &q.name, true), &fmt_num(q.value));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn push(t: &mut UserText, key: &str, value: &str) {
        t.push((key, &fold_case(key)), value);
    }

    #[test]
    fn fixed_keys_are_folded() {
        let fixed = [
            GLOBAL_ID, CLASS, EXPRESS_ID, NAME, DESCRIPTION, OBJECT_TYPE, TAG, PREDEFINED_TYPE, CONTAINER, CONTAINER_GLOBAL_ID, TYPE,
            TYPE_GLOBAL_ID, MATERIAL, PRESENTATION_LAYER,
        ];
        for (key, folded) in fixed {
            assert_eq!(fold_case(key), folded);
        }
    }

    #[test]
    fn the_last_part_takes_what_the_others_copy() {
        let mut t = UserText::new();
        push(&mut t, "IFC::Class", "IfcWall");
        t.reserve_material();
        push(&mut t, "A::x", "1");
        for material in [Some("Steel"), Some(""), None] {
            let copied = t.for_part(material);
            let moved = UserText { pairs: t.pairs.clone(), keys: NameSet::default(), material_at: t.material_at, first_collision: None }.into_part(material);
            assert_eq!(copied, moved, "{material:?}");
        }
        let keys: Vec<String> = t.for_part(Some("Steel")).into_iter().map(|(k, _)| k).collect();
        assert_eq!(keys, ["IFC::Class", "IFC::Material", "A::x"]);
    }

    #[test]
    fn key_parts_never_split_ambiguously_or_hide() {
        assert_eq!(key_part("Pset::Odd", "Pset"), "Pset:Odd");
        assert_eq!(key_part(".hidden", "Pset"), "hidden");
        assert_eq!(key_part("  ", "Pset"), "Pset");
        // A colon at a part's edge would merge with the separator (CodeRabbit on #9415).
        assert_eq!(key_part("A:", "Pset"), "A");
        assert_eq!(key_part(":B", "Property"), "B");
        assert_eq!(key_part(":::", "Pset"), "Pset");
        // Order-independent: neither a hidden `.` nor an edge `:` survives any mix.
        assert_eq!(key_part(":.A", "Pset"), "A");
        assert_eq!(key_part(".:A", "Pset"), "A");
        assert_eq!(key_part(" : . A : ", "Pset"), "A");
        assert_eq!(key_part("A.B:C", "Pset"), "A.B:C");
    }

    #[test]
    fn collisions_keep_the_first_and_number_the_rest() {
        let mut t = UserText::new();
        push(&mut t, "A::x", "1");
        push(&mut t, "A::x", "2");
        push(&mut t, "A::x", "3");
        push(&mut t, "A::y", "");
        assert_eq!(t.first_collision.as_deref(), Some("A::x"));
        assert_eq!(t.pairs, [("A::x".into(), "1".into()), ("A::x #2".into(), "2".into()), ("A::x #3".into(), "3".into())]);
    }

    #[test]
    fn keys_differing_only_in_case_collide() {
        let mut t = UserText::new();
        t.reserve_material();
        push(&mut t, "Pset_Ü::Wert", "1");
        push(&mut t, "PSET_ü::wert", "2");
        push(&mut t, "ifc::material", "3");
        push(&mut t, "pset_ü::WERT #2", "4");
        assert_eq!(t.first_collision.as_deref(), Some("PSET_ü::wert"));
        let keys: Vec<&str> = t.pairs.iter().map(|(k, _)| k.as_str()).collect();
        assert_eq!(keys, ["Pset_Ü::Wert", "PSET_ü::wert #2", "ifc::material #2", "pset_ü::WERT #2 #2"]);
    }

    #[test]
    fn key_parts_keep_a_leading_bracket() {
        assert_eq!(key_part("(Custom)", "Pset"), "(Custom)");
    }

    #[test]
    fn logical_values_are_upper_case() {
        let p = |value: &str, value_type: &str, kind| PropValue { name: "P".into(), value: value.into(), value_type: value_type.into(), kind };
        assert_eq!(property_value(&p("true", "IFCBOOLEAN", ValueKind::Bool)), "TRUE");
        assert_eq!(property_value(&p("unknown", "IFCLOGICAL", ValueKind::Text)), "UNKNOWN");
        assert_eq!(property_value(&p("0.24", "IFCREAL", ValueKind::Number)), "0.24");
    }
}
