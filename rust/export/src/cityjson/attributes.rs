// SPDX-License-Identifier: MPL-2.0
//! City Object attributes from IFC data.
//!
//! IFC attributes keep their EXPRESS names (`GlobalId`, `Name`,
//! `Description`, `ObjectType`, `LongName`, `PredefinedType`, `Elevation`).
//! Derived values are named for what they hold: `ifcClass` (the entity),
//! `ifcBuildingStorey` (the City Object id of the storey a product sits in)
//! and `ifcPropertySets` (property sets as `{ set: { property: value } }`).
//! CityGML's own building attributes are used where the IFC value means the
//! same thing: `measuredHeight` (computed from the exported geometry) and
//! `yearOfConstruction` (`Pset_BuildingCommon.YearOfConstruction`). Swiss
//! federal register identifiers, the building's `EGID` and the parcel's
//! `EGRID`, are surfaced under those names from any property set of the
//! building or, for the parcel, its site.

use serde_json::{Map, Number, Value};

use crate::model::{EntityRow, PropValue, PropertySet, ValueKind};

use super::structure::Kind;

/// A property value as JSON: numbers and booleans typed, the rest text.
fn json_value(p: &PropValue) -> Value {
    match p.kind {
        ValueKind::Number => p.value.parse::<f64>().ok().and_then(Number::from_f64).map_or_else(|| Value::String(p.value.clone()), Value::Number),
        ValueKind::Bool => match p.value.as_str() {
            "true" => Value::Bool(true),
            "false" => Value::Bool(false),
            _ => Value::String(p.value.clone()),
        },
        _ => Value::String(p.value.clone()),
    }
}

/// The carried property sets as `{ set: { property: value } }`. Two sets of
/// one name on one object (two `IfcRelDefinesByProperties` naming the same
/// set) are merged into one: properties keep their first occurrence in the
/// model's set order (relationship file order, occurrence sets before
/// inherited type sets), and a later set that gives the same property a
/// different value is reported in `conflicts` as `set.property` rather than
/// silently overwriting it.
fn merged_sets<'a>(sets: impl IntoIterator<Item = &'a PropertySet>, conflicts: &mut Vec<String>) -> Map<String, Value> {
    let mut out: Map<String, Value> = Map::new();
    for ps in sets {
        let Value::Object(target) = out.entry(ps.name.clone()).or_insert_with(|| Value::Object(Map::new())) else { continue };
        for p in &ps.properties {
            let value = json_value(p);
            match target.get(&p.name) {
                None => {
                    target.insert(p.name.clone(), value);
                }
                Some(kept) if *kept != value => {
                    let key = format!("{}.{}", ps.name, p.name);
                    if !conflicts.contains(&key) {
                        conflicts.push(key);
                    }
                }
                Some(_) => {}
            }
        }
    }
    out
}

/// The property sets carried for a kind: every set of a building (few, and
/// the ones a city model is after), the space's and each element's common
/// set (`Pset_SpaceCommon`, `Pset_WallCommon`, …) otherwise. The full
/// property graph of every element would multiply the file for data a BIM
/// tool already holds.
fn carried(kind: Kind, ps: &PropertySet) -> bool {
    match kind {
        Kind::Building | Kind::BuildingPart => true,
        _ => ps.name.starts_with("Pset_") && ps.name.ends_with("Common"),
    }
}

/// A property named `name` (case-insensitive) in any of `sets`, as text.
fn find_identifier<'a>(sets: impl IntoIterator<Item = &'a PropertySet>, name: &str) -> Option<String> {
    sets.into_iter()
        .flat_map(|ps| &ps.properties)
        .find(|p| p.name.eq_ignore_ascii_case(name) && !p.value.trim().is_empty())
        .map(|p| p.value.trim().to_string())
}

fn attribute<'a>(row: &'a EntityRow, name: &str) -> Option<&'a PropValue> {
    row.attributes.iter().find(|a| a.name == name && !a.value.is_empty())
}

/// Attributes of one City Object.
pub(super) struct AttributeInput<'a> {
    pub kind: Kind,
    pub row: Option<&'a EntityRow>,
    pub ifc_class: &'a str,
    /// City Object id of the storey the product sits in.
    pub storey: Option<&'a str>,
    /// The building's site, searched for `EGRID`.
    pub site: Option<&'a EntityRow>,
    /// Height of the exported LoD1 block, output units.
    pub measured_height: Option<f64>,
    /// Metres per project length unit, for `Elevation`.
    pub length_metres: f64,
    /// A vertical length in IFC metres as a length in output units (the
    /// output CRS's unit), the conversion `measuredHeight` is written in.
    pub vertical: &'a dyn Fn(f64) -> f64,
}

/// The attributes of one City Object, and the `set.property` names whose
/// values conflicted between same-named property sets (see [`merged_sets`]).
pub(super) fn attributes(input: &AttributeInput<'_>) -> (Map<String, Value>, Vec<String>) {
    let mut conflicts = Vec::new();
    let a = attributes_into(input, &mut conflicts);
    (a, conflicts)
}

fn attributes_into(input: &AttributeInput<'_>, conflicts: &mut Vec<String>) -> Map<String, Value> {
    let mut a = Map::new();
    a.insert("ifcClass".into(), Value::String(input.ifc_class.to_string()));
    let Some(row) = input.row else { return a };
    for (key, value) in [("GlobalId", &row.global_id), ("Name", &row.name), ("Description", &row.description), ("ObjectType", &row.object_type)] {
        if let Some(v) = value.as_deref().filter(|v| !v.is_empty()) {
            a.insert(key.into(), Value::String(v.to_string()));
        }
    }
    for key in ["LongName", "PredefinedType"] {
        if let Some(v) = attribute(row, key) {
            a.insert(key.into(), Value::String(v.value.clone()));
        }
    }
    if input.kind == Kind::Storey {
        if let Some(e) = attribute(row, "Elevation").and_then(|v| v.value.parse::<f64>().ok()) {
            // IFC: in the project length unit; written in the output unit,
            // like `measuredHeight` and the coordinates.
            if let Some(n) = Number::from_f64((input.vertical)(e * input.length_metres)) {
                a.insert("Elevation".into(), Value::Number(n));
            }
        }
    }
    if let Some(storey) = input.storey {
        a.insert("ifcBuildingStorey".into(), Value::String(storey.to_string()));
    }
    if matches!(input.kind, Kind::Building | Kind::BuildingPart) {
        if let Some(h) = input.measured_height.and_then(Number::from_f64) {
            a.insert("measuredHeight".into(), Value::Number(h));
        }
        let year = row.property_sets.iter()
            .filter(|ps| ps.name == "Pset_BuildingCommon")
            .flat_map(|ps| &ps.properties)
            .find(|p| p.name == "YearOfConstruction")
            .and_then(|p| p.value.trim().parse::<f64>().ok())
            .filter(|y| y.fract() == 0.0 && (0.0..=9999.0).contains(y));
        if let Some(y) = year {
            a.insert("yearOfConstruction".into(), Value::Number(Number::from(y as i64)));
        }
        if let Some(egid) = find_identifier(&row.property_sets, "EGID") {
            a.insert("EGID".into(), Value::String(egid));
        }
        let site_sets = input.site.map(|s| s.property_sets.as_slice()).unwrap_or_default();
        if let Some(egrid) = find_identifier(row.property_sets.iter().chain(site_sets), "EGRID") {
            a.insert("EGRID".into(), Value::String(egrid));
        }
    }
    let sets = merged_sets(row.property_sets.iter().filter(|ps| carried(input.kind, ps) && !ps.properties.is_empty()), conflicts);
    if !sets.is_empty() {
        a.insert("ifcPropertySets".into(), Value::Object(sets));
    }
    a
}
