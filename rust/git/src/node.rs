// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Nodes: the vertices of the versioned IFC graph.
//!
//! A node exists where a change should be **attributable on its own**;
//! everything else is a field of its owner. See
//! `docs/architecture/ifc-git/02-graph-object-model.md` §2.2.
//!
//! # The one thing this does differently from node-hash v0
//!
//! v0 encodes the `element` node as "header, `key` (string — the entity's
//! stable identity, typically `GlobalId`), `ifcType`, `componentCount`, then
//! components sorted by `componentKey`". The key is **inside the hashed byte
//! stream**, so a from-scratch re-export that regenerates every `GlobalId`
//! changes every element address, and therefore every tree and commit — the
//! exact case GUID-agnostic identity exists to prevent.
//!
//! Here the key is **not** hashed. A node address is its content; the key lives
//! in the `tree` that points at it (a later PR on #8262). That is git's arrangement — a blob
//! is content, a tree maps names to blobs, two identical files share one blob —
//! and it makes a re-GUID a change of tree keys and no change of node
//! addresses. Measured end to end by `tools/ifc-git-corpus`: 116 regenerated
//! `GlobalId`s, 39 added and 39 deleted when paired by key, nothing at all once
//! identity is content-derived.

use crate::address::{canonical_f64, sort_key, Address, CanonicalWriter};

/// Magic announcing this node format. A wire-format change mints a new one.
pub const NODE_MAGIC: &[u8; 4] = b"IGN1";
/// Format version within [`NODE_MAGIC`].
pub const NODE_FORMAT_VERSION: u8 = 0;

/// What a node is.
///
/// Tags are stable and may not be renumbered: a tag is part of the hashed
/// header, so changing one rewrites every address of that kind.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
#[repr(u8)]
pub enum NodeKind {
    /// One element's folded components. Composite.
    Element = 1,
    /// A named set of properties. Shared by many occurrences through
    /// `IfcRelDefinesByProperties`, which is why it is a node: one edit must be
    /// one change, not N.
    PropertySet = 2,
    /// A named set of quantities. Same argument.
    QuantitySet = 3,
    /// A named IFC relationship. Its identity is its endpoints, which are node
    /// addresses — see [`Node::Relationship`] for what that drops.
    Relationship = 4,
    /// Tessellated or parametric geometry for one element, by tier.
    Geometry = 5,
    /// A resolved name bag: materials or classification references.
    NameBag = 6,
    /// One element's direct attributes, the `attr:core` component.
    Attributes = 7,
    /// An element's assigned types, by name and class.
    TypeAssignment = 8,
}

/// What one field of a node holds.
///
/// A number is carried as an `f64` rather than pre-rendered text, so the
/// encoder can write its raw bits (v0 section 3) and no rendering has to be
/// chosen. `Absent` is distinct from `Text(String::new())` in both the
/// encoding and the ordering.
#[derive(Debug, Clone, PartialEq)]
pub enum FieldValue {
    Absent,
    Text(String),
    Number(f64),
    Bool(bool),
}

impl FieldValue {
    /// Tag byte written before the payload, so no two variants can produce
    /// the same bytes.
    fn tag(&self) -> u8 {
        match self {
            FieldValue::Absent => 0,
            FieldValue::Text(_) => 1,
            FieldValue::Number(_) => 2,
            FieldValue::Bool(_) => 3,
        }
    }
}

/// One scalar field of a node, as a name/value pair.
#[derive(Debug, Clone, PartialEq)]
pub struct Field {
    pub name: String,
    pub value: FieldValue,
}

/// One component of an element: a key and the address of the node carrying it.
///
/// The key vocabulary is shared with `@ifc-lite/diff` and `@ifc-lite/merge` —
/// `attr:core`, `pset:<Name>`, `qset:<Name>`, `type-assignment`, `material`,
/// `classification`, `placement`, `geometry:<tier>`, `child:<name>` — so diff
/// keys and op keys have one spelling.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Component {
    pub key: String,
    pub node: Address,
}

/// A node, before it is addressed.
// No `Eq`: a `Field` can hold an `f64`, which has no total equality. Node
// identity is its address, not structural equality, so nothing needs `Eq`.
#[derive(Debug, Clone, PartialEq)]
pub enum Node {
    /// A fold of component addresses. **Carries no key** — see the module docs.
    Element {
        /// Exact IFC EXPRESS PascalCase class, e.g. `IfcWallStandardCase`.
        ifc_type: String,
        components: Vec<Component>,
    },
    /// A named set of scalar members.
    Set {
        kind: SetKind,
        name: String,
        members: Vec<Field>,
    },
    /// A relationship: a class and its roles, each role a set of targets.
    ///
    /// Targets are **node addresses**, which keeps the node content-only and
    /// is also where this encoding drops information the source records: two
    /// coincident duplicates have distinct `GlobalId`s and the source
    /// relationship names one of them, but they share one address, so a
    /// relationship naming either names both. Whether such duplicates are one
    /// node or must be separated — and by what, if not a `GlobalId` — is the
    /// spec set's **open** equivalence policy (`02-graph-object-model.md`
    /// §2.8); node-address endpoints are the current proposal, not a decision.
    /// A forthcoming dedup-boundary integration suite on #8262 measures this.
    Relationship { ifc_type: String, roles: Vec<Role> },
    /// Geometry for one tier, addressed by the digest the geometry pass already
    /// produces rather than re-hashed here.
    Geometry { tier: String, digest: String },
    /// A bag of resolved names: materials, classification references.
    NameBag { kind: String, names: Vec<String> },
}

/// Which set kind a [`Node::Set`] is.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SetKind {
    Property,
    Quantity,
    /// Direct attributes. A distinct kind rather than a reserved name, so a
    /// property set legitimately called `core` cannot collide with it.
    Attributes,
    /// Assigned types, each member a class with its type name as the value.
    TypeAssignment,
}

/// One relationship role and the nodes it points at.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Role {
    pub name: String,
    pub targets: Vec<Address>,
    /// Whether `targets`' order is content. Most IFC roles are sets — e.g.
    /// `IfcRelAggregates.RelatedObjects` — where reference order is an
    /// authoring artifact and must not reach the address (review on #8265:
    /// §2.5 preserves order for a role whose attribute is declared `LIST`,
    /// e.g. `IfcRelNests.RelatedObjects` for alignment segments, where
    /// `[seg1, seg2]` and `[seg2, seg1]` are different content). `false`
    /// sorts `targets` before encoding, exactly as every role did before this
    /// field existed; `true` encodes them as given.
    pub ordered: bool,
}

impl Node {
    /// The kind tag written into the header.
    pub fn kind(&self) -> NodeKind {
        match self {
            Node::Element { .. } => NodeKind::Element,
            Node::Set {
                kind: SetKind::Property,
                ..
            } => NodeKind::PropertySet,
            Node::Set {
                kind: SetKind::Quantity,
                ..
            } => NodeKind::QuantitySet,
            Node::Set {
                kind: SetKind::Attributes,
                ..
            } => NodeKind::Attributes,
            Node::Set {
                kind: SetKind::TypeAssignment,
                ..
            } => NodeKind::TypeAssignment,
            Node::Relationship { .. } => NodeKind::Relationship,
            Node::Geometry { .. } => NodeKind::Geometry,
            Node::NameBag { .. } => NodeKind::NameBag,
        }
    }

    /// Canonical bytes and the resulting address.
    ///
    /// Sets are sorted; lists whose order is content are not. Sorting is by
    /// NFC-normalized UTF-8 bytes (see [`sort_key`]) — the same bytes the
    /// encoder writes — so neither input order nor the producer's choice of
    /// Unicode spelling can reach the hash.
    pub fn encode(&self) -> (Address, Vec<u8>) {
        let mut w = CanonicalWriter::new(NODE_MAGIC, self.kind() as u8, NODE_FORMAT_VERSION);
        match self {
            Node::Element {
                ifc_type,
                components,
            } => {
                w.string(ifc_type);
                let mut sorted: Vec<&Component> = components.iter().collect();
                // Key first, then the child address, for the same reason the
                // set branch tie-breaks on value: `Node` is public and
                // enforces no uniqueness, and duplicate same-named property
                // sets are a real IFC shape (#8136). Sorting on the key alone
                // with a stable sort let the caller's order decide the bytes.
                //
                // `sort_by_cached_key` rather than `sort_by`: `sort_key` NFC-
                // normalizes and allocates, and calling it from inside a
                // `sort_by` comparator re-derives both sides on every
                // comparison. The cached-key form calls the key function once
                // per component (review on #8265).
                sorted.sort_by_cached_key(|component| (sort_key(&component.key), component.node));
                w.u32(count(sorted.len()));
                for component in sorted {
                    w.string(&component.key);
                    w.address(&component.node);
                }
            }
            Node::Set {
                kind: _,
                name,
                members,
            } => {
                w.string(name);
                let mut sorted: Vec<&Field> = members.iter().collect();
                // Name first, then value, so two members sharing a name are
                // still totally ordered and input order cannot leak in. Cached
                // key for the same reason as the element branch above.
                sorted.sort_by_cached_key(|field| (sort_key(&field.name), value_key(&field.value)));
                w.u32(count(sorted.len()));
                for field in sorted {
                    w.string(&field.name);
                    w.u8(field.value.tag());
                    match &field.value {
                        FieldValue::Absent => {}
                        FieldValue::Text(text) => {
                            w.string(text);
                        }
                        FieldValue::Number(number) => {
                            w.f64_bits(*number);
                        }
                        FieldValue::Bool(flag) => {
                            w.u8(u8::from(*flag));
                        }
                    }
                }
            }
            Node::Relationship { ifc_type, roles } => {
                w.string(ifc_type);
                // A role whose attribute is a set has no content order, so its
                // targets are sorted before anything else runs — comparing
                // unsorted targets, or re-sorting inside the role comparator,
                // would either leak input order or re-sort on every
                // comparison. A role whose attribute is an ordered `LIST`
                // (`ordered: true`, e.g. `IfcRelNests.RelatedObjects`) keeps
                // its targets exactly as given instead: that order is content
                // (review on #8265).
                let mut sorted: Vec<(String, bool, Vec<Address>)> = roles
                    .iter()
                    .map(|role| {
                        let mut targets = role.targets.clone();
                        if !role.ordered {
                            targets.sort();
                        }
                        (role.name.clone(), role.ordered, targets)
                    })
                    .collect();
                // Name, then those targets, then `ordered`, so two roles
                // sharing a name and targets but differing only in `ordered`
                // are still totally ordered — `Node` is public and enforces
                // no uniqueness there, and the flag is written to the bytes,
                // so leaving it out of the key would let input order decide
                // them (review on #8265). Cached key for the same reason as
                // above; the extra `targets.clone()` this needs is one Vec of
                // `Address` per role, once, not a re-sort per comparison.
                sorted.sort_by_cached_key(|(name, ordered, targets)| {
                    (sort_key(name), targets.clone(), *ordered)
                });
                w.u32(count(sorted.len()));
                for (name, ordered, targets) in &sorted {
                    w.string(name);
                    w.u8(u8::from(*ordered));
                    w.u32(count(targets.len()));
                    for target in targets {
                        w.address(target);
                    }
                }
            }
            Node::Geometry { tier, digest } => {
                w.string(tier);
                w.string(digest);
            }
            Node::NameBag { kind, names } => {
                w.string(kind);
                // Duplicates are kept: cardinality is content. Cached key for
                // the same reason as the branches above.
                let mut sorted: Vec<&String> = names.iter().collect();
                sorted.sort_by_cached_key(|name| sort_key(name));
                w.u32(count(sorted.len()));
                for name in sorted {
                    w.string(name);
                }
            }
        }
        w.finish()
    }

    /// The node's content address.
    pub fn address(&self) -> Address {
        self.encode().0
    }
}

/// A member count, checked rather than truncated. `as u32` on `usize::MAX`
/// members would wrap to a wrong but valid-looking count instead of failing;
/// no real IFC file reaches this, so the cost of checking is only ever paid
/// once, right before the fixed-width field is written (review on #8265).
fn count(len: usize) -> u32 {
    u32::try_from(len).expect("more than u32::MAX members in one node's list")
}

/// Sort key for a field value, keeping the variants apart and total.
///
/// `Absent` sorts below every present value, including empty text. Collapsing
/// them would make a member's absence indistinguishable from an empty value in
/// the ordering, which the encoding is careful to distinguish in its bytes. A
/// number sorts by the bit pattern of its canonicalized value — the same
/// value `f64_bits` writes — so two numbers that encode identically also
/// compare identically; sorting on the raw bits would let `-0.0` vs `0.0`, or
/// a signed vs unsigned `NaN`, disagree with the bytes on order alone (review
/// on #8265).
fn value_key(value: &FieldValue) -> (u8, Vec<u8>, u64) {
    match value {
        FieldValue::Absent => (0, Vec::new(), 0),
        FieldValue::Text(text) => (1, sort_key(text), 0),
        FieldValue::Number(number) => (2, Vec::new(), canonical_f64(*number).to_bits()),
        FieldValue::Bool(flag) => (3, Vec::new(), u64::from(*flag)),
    }
}

#[cfg(test)]
#[path = "node_tests.rs"]
mod tests;
