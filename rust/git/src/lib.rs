// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Graph-based version control for IFC: the addressed node layer.
//!
//! Spec set: `docs/architecture/ifc-git/`. This crate is the object layer that
//! the delivery → layer adapter is built on. The diff that computes a change
//! lives in `ifc-lite-diff`; history, refs, merge and review belong to Layer
//! PRs (`docs/architecture/layer-prs/`, see the scope reversal in #8217), not
//! here.
//!
//! # The two decisions this module set carries
//!
//! **1. Identity is content and structural position, not `GlobalId`.** A node's
//! address is the digest of its content plus its children's addresses, and the
//! entity key lives in the tree that points at the node rather than inside the
//! node. So a from-scratch re-export that regenerates every `GlobalId` rewrites
//! tree keys and leaves every node address untouched.
//!
//! This is the one place the crate departs from `node-hash-v0` in
//! `packages/provenance`, which folds the entity `key` into the `element` node
//! and therefore cannot deliver that property. See [`node`] for the detail, and
//! the spec set's index §6.1 for the open question of where the canonical
//! encoding should finally live.
//!
//! **2. A change belongs to the node that carries it.** Edit one property
//! inside one property set and the property-set node's address moves; the
//! owning element's address moves because it encodes that child address; and
//! nothing else moves. The element is *marked* at `pset:<Name>`, not blamed.
//! A set shared by many occurrences is therefore one node change plus N
//! markers.
//!
//! # Evidence, not assertion
//!
//! `tools/ifc-git-corpus` (#8129) derives a ten-revision chain from a committed
//! model and measures each step. Its re-export revision regenerates all 116
//! `GlobalId`s: paired by key that reads as 39 added and 39 deleted, and under
//! content-derived identity it is nothing at all. That gap is why this layer
//! addresses content rather than keys.
//!
//! # Scope of this PR
//!
//! [`tree`] (the keyed, chunked tree that carries entity keys outside the
//! nodes) and [`adapter`] (one entity's content projection to nodes), on top of
//! [`address`] and [`node`]. The commit object follows in the next PR on the
//! same issue; the object store and refs are **not** coming here, because
//! #8217 placed them with Layer PRs.

pub mod adapter;
pub mod address;
pub mod node;
pub mod tree;

pub use adapter::{entity_nodes, AdapterError, EntityNodes};
pub use address::{Address, AddressError, ADDRESS_ALGORITHM};
pub use node::{Component, Field, FieldValue, Node, NodeKind, Role, SetKind};
pub use tree::{build_tree, Tree, TreeChunk, TreeEntry};
