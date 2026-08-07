// SPDX-License-Identifier: MPL-2.0
//! The row and value types the attribute export yields.
//!
//! Split from `model.rs` under the house rule (AGENTS.md), and because these
//! are the crate's public data shape: every exporter (CSV, JSON, JSON-LD,
//! IFC5, Parquet, USD) and the Python binding read them, while none of them
//! cares how the streaming pass in `model.rs` fills them in.

use ifc_lite_processing::prepass::UnitScales;

use super::options::Placement;
use super::props::fmt_num;

/// A single property value (`IfcPropertySingleValue` and friends).
#[derive(Debug, Clone, PartialEq)]
pub struct PropValue {
    pub name: String,
    pub value: String,
    /// IFC value type tag when known (e.g. `IFCLABEL`, `IFCREAL`, `IFCBOOLEAN`).
    pub value_type: String,
}

/// A named property set (`IfcPropertySet`).
#[derive(Debug, Clone, PartialEq)]
pub struct PropertySet {
    pub name: String,
    pub properties: Vec<PropValue>,
}

/// A single physical quantity (`IfcQuantityLength`/`Area`/`Volume`/…).
#[derive(Debug, Clone, PartialEq)]
pub struct QuantityValue {
    pub name: String,
    pub value: f64,
    /// `Length` | `Area` | `Volume` | `Count` | `Weight` | `Time`.
    pub kind: &'static str,
}

/// A named quantity set (`IfcElementQuantity`).
#[derive(Debug, Clone, PartialEq)]
pub struct QuantitySet {
    pub name: String,
    pub quantities: Vec<QuantityValue>,
}

/// One exportable entity row.
///
/// Usually an `IfcProduct` occurrence, but not always: an `IfcTypeProduct`
/// whose `RepresentationMaps` no occurrence instantiates gets a row of its own
/// (#957 Route B / #1518), so the GLB node meshed under the type's expressId
/// is not left without attributes. Such a row has no `placement`, since a type
/// object has no `ObjectPlacement`, and no matching entry in the geometry
/// export, which emits occurrences only.
#[derive(Debug, Clone, PartialEq)]
pub struct EntityRow {
    pub express_id: u32,
    pub ifc_type: String,
    pub global_id: Option<String>,
    pub name: Option<String>,
    pub description: Option<String>,
    pub object_type: Option<String>,
    /// True when the product carries a geometric Representation (attr 6).
    pub has_geometry: bool,
    /// The product's placement, when [`ModelOptions::placements`] asked for it
    /// AND the product carries an `ObjectPlacement` (attr 5).
    ///
    /// `None` is therefore two different facts. The caller knows which it asked
    /// for; it cannot tell from the row alone, and 7.5% of product occurrences
    /// in a real corpus genuinely have no placement, so this is not a rare case
    /// to hand-wave.
    ///
    /// **A resolvable-but-broken chain is not `None`.** A dangling reference, a
    /// cycle, or a chain deeper than 32 composes to the identity, and identity
    /// is a legitimate placement — so a malformed file yields a product at the
    /// origin rather than an error. Distinguishing those would mean changing
    /// what the resolver returns, which is a wider change than this.
    pub placement: Option<Placement>,
    pub property_sets: Vec<PropertySet>,
    pub quantity_sets: Vec<QuantitySet>,
    /// The entity's SCHEMA-DECLARED attributes, when [`ModelOptions::attributes`]
    /// asked for them. Empty otherwise, and empty for a type that declares none
    /// beyond the rooted set.
    ///
    /// Not property sets, and not reachable through one: `NominalDiameter` on
    /// an `IfcReinforcingBar` or `OverallHeight` on an `IfcDoor` is declared on
    /// the entity itself, so a consumer reading only psets never sees it. The
    /// fields this row already carries (`GlobalId`, `Name`, `Description`,
    /// `ObjectType`) and the reference-valued ones are excluded.
    pub attributes: Vec<PropValue>,
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
#[derive(Debug, Clone, PartialEq)]
pub struct ExportModel {
    pub entities: Vec<EntityRow>,
    /// The model's unit scales, resolved from its `IFCPROJECT`.
    ///
    /// Attribute values in [`EntityRow`] are in the file's OWN units — a
    /// millimetre model yields a `Qto_WallBaseQuantities.Length` of 3000, not 3.
    /// The geometry exporters normalise to metres; this path deliberately does
    /// not, because a property value is not always a length and coercing one
    /// would be guessing. That leaves the caller needing the scale to interpret
    /// anything dimensional, and until now it had no way to obtain it: the
    /// resolver was internal and `ExportModel` carried only entities. A consumer
    /// writing quantities alongside exported geometry therefore had a silent
    /// 1000x mismatch with no value on hand to detect it with.
    pub units: UnitScales,
}
