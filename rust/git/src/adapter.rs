// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! From one entity's content projection to its nodes and tree entry.
//!
//! This is the seam between the diff engine and the object layer. It takes the
//! projection the diff engine already defines — `DataFingerprintInput` — and
//! produces the nodes plus the [`crate::tree::TreeEntry`] that names them.
//!
//! Reusing that input rather than restating it is deliberate: "what counts as
//! an entity's content" is a long argued question with its reasoning recorded
//! in `rust/diff`'s own docs (a type assignment is identified by name and
//! class, never by the type's `GlobalId`; `Tag` participates for type objects
//! only; absent and empty name bags are identical). Restating it here would
//! fork that decision into two places, and the fork would be silent.
//!
//! # The key does not reach a node
//!
//! Every node this produces is addressed by content alone. The key arrives as a
//! separate argument and lands only in the returned tree entry, which is the
//! whole of the GUID-agnostic design (`crate::tree`). The tests assert it: the
//! same projection under two different keys yields byte-identical node
//! addresses.
//!
//! # What this does not do yet
//!
//! Geometry and relationships. `DataFingerprintInput` carries neither — a
//! geometry hash reaches the diff engine through `EntityFingerprint`, from the
//! mesh pass, and relationships reach it only as derived components. Both want
//! their own adapter and are deferred rather than approximated here. The
//! relationship adapter also has a decision to wait for: endpoints by node
//! address drop which of two coincident duplicates the source named, and the
//! spec set holds that equivalence policy open (`02-graph-object-model.md`
//! §2.8).

use ifc_lite_diff::input::{DataFingerprintInput, PropertyEntryInput, PropertyValue};
use ifc_lite_diff::sparse_collection::SparseCollection;
use ifc_lite_diff::JsString;

use crate::node::{Component, Field, FieldValue, Node, SetKind};
use crate::tree::TreeEntry;

/// Why an entity could not be converted.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AdapterError {
    /// A string in the projection is not well-formed Unicode — it holds an
    /// unpaired surrogate, so it has no Rust `&str` form and no NFC form
    /// either.
    ///
    /// Refused rather than coerced. The lossy conversion would map every
    /// unpaired surrogate to the replacement character, collapsing strings
    /// that are genuinely distinct into one node — which is the defect class
    /// the diff engine's own UTF-16 work exists to prevent. A caller that
    /// meets this has malformed input and should hear about it.
    NotWellFormed {
        /// Where in the projection, e.g. `pset name` or `property value`.
        field: &'static str,
    },
    /// A structured composite value arrived where the diff engine normally
    /// hands over an already-collapsed string. Refused rather than given a
    /// second canonical form invented here.
    Composite { field: &'static str },
    /// The projection carries an array hole — an absent index — and the node
    /// encoding has no form for one.
    ///
    /// Refused rather than skipped, because a hole is *content*: the diff
    /// engine counts holes in `SparseCollection` precisely so that a 2-member
    /// set with a gap is not equal to a 2-member set without one (#8042,
    /// #8114). Iterating only the present records would give both the same
    /// node address, which is a silent collision in the one layer whose whole
    /// job is that addresses separate what differs.
    ///
    /// Representing them is a canonical-encoding change, and index §6.1 holds
    /// that question open, so this refuses and says why instead of inventing
    /// an encoding here.
    Hole {
        /// Where in the projection, e.g. `property sets` or `property members`.
        field: &'static str,
        /// How many absent indices the collection carries.
        count: usize,
    },
}

impl std::fmt::Display for AdapterError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            AdapterError::NotWellFormed { field } => write!(
                f,
                "{field} holds an unpaired surrogate, so it has no well-formed \
                 Unicode form; refusing rather than collapsing it"
            ),
            AdapterError::Composite { field } => write!(
                f,
                "{field} holds a structured composite; the diff engine collapses \
                 these to a canonical string, and inventing a second form here \
                 would fork the contract"
            ),
            AdapterError::Hole { field, count } => write!(
                f,
                "{field} carries {count} array hole(s), which are content to the \
                 diff engine; the node encoding has no form for one, and dropping \
                 them would collide two different projections on one address"
            ),
        }
    }
}

impl std::error::Error for AdapterError {}

/// One entity's conversion: the nodes it is made of, and the entry naming it.
#[derive(Debug, Clone, PartialEq)]
pub struct EntityNodes {
    /// Every node produced, component nodes first and the element last, so a
    /// caller can store them in order and never reference an absent child.
    pub nodes: Vec<Node>,
    /// The entry a tree carries for this entity.
    pub entry: TreeEntry,
}

fn text(value: &JsString, field: &'static str) -> Result<String, AdapterError> {
    value
        .as_str()
        .map(str::to_owned)
        .ok_or(AdapterError::NotWellFormed { field })
}

fn optional_text(
    value: &Option<JsString>,
    field: &'static str,
) -> Result<Option<String>, AdapterError> {
    match value {
        None => Ok(None),
        Some(inner) => Ok(Some(text(inner, field)?)),
    }
}

/// Lift a property value into a field value.
///
/// A number is **carried, not rendered** — the encoder writes its raw bits, so
/// no text form has to be chosen here. Non-finite values are mapped to their
/// token text instead, matching the fingerprint layer: `NaN` and the
/// infinities have no JSON literal, and leaving them as bits would let a
/// signalling and a quiet `NaN` differ while comparing equal.
fn value_of(value: &PropertyValue, field: &'static str) -> Result<FieldValue, AdapterError> {
    Ok(match value {
        PropertyValue::Null => FieldValue::Absent,
        PropertyValue::Bool(flag) => FieldValue::Bool(*flag),
        PropertyValue::Number(number) if number.is_finite() => FieldValue::Number(*number),
        PropertyValue::Number(number) => FieldValue::Text(non_finite_token(*number).to_owned()),
        PropertyValue::String(text_value) => FieldValue::Text(text(text_value, field)?),
        // A composite reaches the diff engine already collapsed to a canonical
        // string. If one arrives structured, refuse rather than invent a
        // second serialization: a wrong canonical form is worse than a stop.
        _ => return Err(AdapterError::Composite { field }),
    })
}

/// ECMAScript `String(n)` for the three non-finite values.
fn non_finite_token(value: f64) -> &'static str {
    if value.is_nan() {
        "NaN"
    } else if value.is_sign_positive() {
        "Infinity"
    } else {
        "-Infinity"
    }
}

/// A hole is content (see [`AdapterError::Hole`]); refuse rather than skip.
fn refuse_holes(count: usize, field: &'static str) -> Result<(), AdapterError> {
    if count > 0 {
        return Err(AdapterError::Hole { field, count });
    }
    Ok(())
}

fn members(
    entries: &SparseCollection<PropertyEntryInput>,
    name_field: &'static str,
    value_field: &'static str,
) -> Result<Vec<Field>, AdapterError> {
    refuse_holes(entries.holes(), "property members")?;
    entries
        .present()
        .map(|entry| {
            Ok(Field {
                name: text(&entry.name, name_field)?,
                value: value_of(&entry.value, value_field)?,
            })
        })
        .collect()
}

/// The direct-attribute slice, as its own node.
///
/// Mirrors the diff engine's `attr:core` projection exactly — type, name,
/// description, object type, predefined type, tag — because that component is
/// a collision guard on the whole-entity hash and only guards while the two
/// project identically.
fn attributes_node(input: &DataFingerprintInput) -> Result<Node, AdapterError> {
    let field = |name: &str, value: Option<String>| Field {
        name: name.to_owned(),
        value: value.map_or(FieldValue::Absent, FieldValue::Text),
    };
    Ok(Node::Set {
        kind: SetKind::Attributes,
        name: "core".to_owned(),
        members: vec![
            field("Type", Some(text(&input.ifc_type, "ifcType")?)),
            field("Name", optional_text(&input.name, "name")?),
            field(
                "Description",
                optional_text(&input.description, "description")?,
            ),
            field(
                "ObjectType",
                optional_text(&input.object_type, "objectType")?,
            ),
            field(
                "PredefinedType",
                optional_text(&input.predefined_type, "predefinedType")?,
            ),
            field("Tag", optional_text(&input.tag, "tag")?),
        ],
    })
}

fn name_bag(kind: &str, names: &[JsString], field: &'static str) -> Result<Node, AdapterError> {
    Ok(Node::NameBag {
        kind: kind.to_owned(),
        names: names
            .iter()
            .map(|name| text(name, field))
            .collect::<Result<Vec<String>, AdapterError>>()?,
    })
}

/// Convert one entity.
///
/// `key` is the entity's identity in *this* version — typically its
/// `GlobalId`. It reaches the tree entry and nothing else.
pub fn entity_nodes(key: &str, input: &DataFingerprintInput) -> Result<EntityNodes, AdapterError> {
    let mut nodes = Vec::new();
    let mut components = Vec::new();

    let attributes = attributes_node(input)?;
    components.push(Component {
        key: "attr:core".to_owned(),
        node: attributes.address(),
    });
    nodes.push(attributes);

    refuse_holes(input.property_sets.holes(), "property sets")?;
    for set in input.property_sets.present() {
        let name = text(&set.name, "pset name")?;
        let node = Node::Set {
            kind: SetKind::Property,
            name: name.clone(),
            members: members(&set.properties, "property name", "property value")?,
        };
        components.push(Component {
            key: format!("pset:{name}"),
            node: node.address(),
        });
        nodes.push(node);
    }

    refuse_holes(input.quantity_sets.holes(), "quantity sets")?;
    for set in input.quantity_sets.present() {
        let name = text(&set.name, "qset name")?;
        let node = Node::Set {
            kind: SetKind::Quantity,
            name: name.clone(),
            members: members(&set.quantities, "quantity name", "quantity value")?,
        };
        components.push(Component {
            key: format!("qset:{name}"),
            node: node.address(),
        });
        nodes.push(node);
    }

    refuse_holes(input.type_assignments.holes(), "type assignments")?;
    if input.type_assignments.present().next().is_some() {
        // Semantic identity only: class and name, never the type's own
        // `GlobalId`. A from-scratch re-export regenerates that id, and
        // hashing it would move the fingerprint of every typed element on
        // exactly the re-export this design exists to see through.
        let mut assignments = Vec::new();
        for assignment in input.type_assignments.present() {
            assignments.push(Field {
                name: optional_text(&assignment.type_name, "type class")?.unwrap_or_default(),
                value: FieldValue::Text(
                    optional_text(&assignment.name, "type name")?.unwrap_or_default(),
                ),
            });
        }
        let node = Node::Set {
            kind: SetKind::TypeAssignment,
            name: String::new(),
            members: assignments,
        };
        components.push(Component {
            key: "type-assignment".to_owned(),
            node: node.address(),
        });
        nodes.push(node);
    }

    // Absent and empty are one case for a name bag, so an entity that names no
    // material carries no `material` component rather than an empty one. The
    // diff engine makes the same choice, for the same reason: an
    // unconditional key would have moved the fingerprint of every
    // material-less entity the day the field shipped.
    if !input.materials.is_empty() {
        let node = name_bag("material", &input.materials, "material name")?;
        components.push(Component {
            key: "material".to_owned(),
            node: node.address(),
        });
        nodes.push(node);
    }
    if !input.classifications.is_empty() {
        let node = name_bag("classification", &input.classifications, "classification")?;
        components.push(Component {
            key: "classification".to_owned(),
            node: node.address(),
        });
        nodes.push(node);
    }

    let ifc_type = text(&input.ifc_type, "ifcType")?;
    let element = Node::Element {
        ifc_type: ifc_type.clone(),
        components,
    };
    let entry = TreeEntry {
        key: key.to_owned(),
        node: element.address(),
        ifc_type,
    };
    nodes.push(element);

    Ok(EntityNodes { nodes, entry })
}

#[cfg(test)]
#[path = "adapter_tests.rs"]
mod tests;
