// SPDX-License-Identifier: MPL-2.0
//! The mutation log, as `MutablePropertyView.exportMutations()` writes it.
//!
//! ONE definition of the wire shape, serde-compatible with the TypeScript
//! `{ modelId, mutations, exportedAt }` object (`@ifc-lite/mutations`'
//! `Mutation` interface, field for field). Two optional members extend it,
//! because the history alone cannot carry them:
//!
//! - `newEntities`: the `NewEntity` payloads (`getNewEntities()`). A
//!   `CREATE_ENTITY` record carries only the express id, which is why
//!   `importMutations` cannot rebuild the entity either; a host that wants its
//!   created entities written sends their payloads here, the same thing
//!   `restoreNewEntity()` receives on the TypeScript side.
//! - `georefMutations`: `StepExportOptions.georefMutations`, which never was a
//!   mutation record at all.
//!
//! Unknown members are ignored rather than refused, so a newer producer does
//! not break an older writer; an unknown mutation `type` is skipped and
//! reported, exactly as `applyMutationsBatch` skips and warns.

use serde::{Deserialize, Deserializer, Serialize};
use serde_json::Value;

/// `Some(Value::Null)` for an explicit JSON `null`, `None` only when the key
/// is absent. The TypeScript replay distinguishes the two (`newValue !==
/// undefined` admits `null`), and plain `Option<Value>` would collapse them.
fn present<'de, D: Deserializer<'de>>(d: D) -> Result<Option<Value>, D::Error> {
    Value::deserialize(d).map(Some)
}

/// What `exportMutations()` returns, plus the two members above.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct MutationLog {
    /// The model the history was recorded against. Informational only.
    #[serde(default)]
    pub model_id: String,
    /// The history, in the order it was recorded.
    #[serde(default)]
    pub mutations: Vec<LogMutation>,
    /// `Date.now()` at export. Informational only.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exported_at: Option<f64>,
    /// Payloads for the entities the session created (see the module doc).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub new_entities: Vec<LogNewEntity>,
    /// Georeferencing edits (`StepExportOptions.georefMutations`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub georef_mutations: Option<GeorefMutations>,
}

impl MutationLog {
    /// Parse the JSON `exportMutations()` produced, with or without the two
    /// extension members. Non-finite numbers arrive as
    /// `{ "__nonFiniteNumber": "NaN" }` markers and are read as such where a
    /// number is expected.
    pub fn from_json(json: &str) -> Result<Self, serde_json::Error> {
        serde_json::from_str(json)
    }

    /// A log holding exactly `mutations`, for callers building one in Rust.
    pub fn new(mutations: Vec<LogMutation>) -> Self {
        MutationLog { mutations, ..MutationLog::default() }
    }

    /// Attach the created-entity payloads.
    pub fn with_new_entities(mut self, entities: Vec<LogNewEntity>) -> Self {
        self.new_entities = entities;
        self
    }

    /// Attach georeferencing edits.
    pub fn with_georef_mutations(mut self, georef: GeorefMutations) -> Self {
        self.georef_mutations = Some(georef);
        self
    }

    /// Whether the log asks for nothing at all.
    pub fn is_empty(&self) -> bool {
        self.mutations.is_empty() && self.new_entities.is_empty() && self.georef_mutations.is_none()
    }
}

/// `Mutation['type']`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
#[non_exhaustive]
pub enum MutationKind {
    CreateProperty,
    UpdateProperty,
    DeleteProperty,
    CreatePropertySet,
    DeletePropertySet,
    CreateQuantity,
    UpdateQuantity,
    DeleteQuantity,
    DeleteQuantitySet,
    UpdateAttribute,
    UpdatePositionalAttribute,
    UpdateEntityType,
    CreateEntity,
    DeleteEntity,
    /// A type this writer does not know. Skipped and reported.
    #[serde(other)]
    Unknown,
}

/// One `Mutation` record. Values are kept as JSON because that is what they
/// are on the wire: `PropertyValue` is `string | number | boolean | null |
/// PropertyValue[]`, and a positional value may carry the `{ real }` /
/// `{ typed }` write markers.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct LogMutation {
    #[serde(default)]
    pub id: String,
    #[serde(rename = "type")]
    pub kind: MutationKind,
    #[serde(default)]
    pub timestamp: f64,
    #[serde(default)]
    pub model_id: String,
    pub entity_id: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pset_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prop_name: Option<String>,
    #[serde(default, deserialize_with = "present", skip_serializing_if = "Option::is_none")]
    pub old_value: Option<Value>,
    #[serde(default, deserialize_with = "present", skip_serializing_if = "Option::is_none")]
    pub new_value: Option<Value>,
    /// `PropertyValueType` (0 = String … 10 = List).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub value_type: Option<f64>,
    /// `QuantityType` (0 = Length … 6 = Number).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub quantity_type: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unit: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attribute_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub entity_type: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub predefined_type: Option<String>,
}

impl LogMutation {
    /// A record of `kind` against `entity_id`, every optional member unset.
    pub fn new(kind: MutationKind, entity_id: u32) -> Self {
        LogMutation {
            id: String::new(),
            kind,
            timestamp: 0.0,
            model_id: String::new(),
            entity_id,
            pset_name: None,
            prop_name: None,
            old_value: None,
            new_value: None,
            value_type: None,
            quantity_type: None,
            unit: None,
            attribute_name: None,
            entity_type: None,
            predefined_type: None,
        }
    }
}

/// `NewEntity`: an entity the session created, as `getNewEntities()` returns
/// it. `attributes` is the positional STEP argument list in the
/// `IfcAttributeValue` shape (`"#42"` for a reference, `".AREA."` for an
/// enum, `"$"` for unset, `{ "real": 5 }` for a forced REAL).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct LogNewEntity {
    pub express_id: u32,
    #[serde(rename = "type")]
    pub entity_type: String,
    #[serde(default)]
    pub attributes: Vec<Value>,
}

impl LogNewEntity {
    pub fn new(express_id: u32, entity_type: impl Into<String>, attributes: Vec<Value>) -> Self {
        LogNewEntity { express_id, entity_type: entity_type.into(), attributes }
    }
}

/// `StepExportOptions.georefMutations`: partial `ProjectedCRS` /
/// `MapConversion` edits. Each member is kept as its JSON value so an explicit
/// `null` stays distinguishable from an absent key, which the TypeScript
/// exporter tests with `!== undefined`.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct GeorefMutations {
    #[serde(default, rename = "projectedCRS", skip_serializing_if = "Option::is_none")]
    pub projected_crs: Option<serde_json::Map<String, Value>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub map_conversion: Option<serde_json::Map<String, Value>>,
}

impl GeorefMutations {
    pub fn new(
        projected_crs: Option<serde_json::Map<String, Value>>,
        map_conversion: Option<serde_json::Map<String, Value>>,
    ) -> Self {
        GeorefMutations { projected_crs, map_conversion }
    }
}
