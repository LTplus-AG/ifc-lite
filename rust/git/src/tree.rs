// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Trees: the manifest of one version, mapping `key -> node address`.
//!
//! This is where the entity key lives, and it is the whole of the
//! GUID-agnostic design. A node address is its content ([`crate::node`]); the
//! key that names it is here. So a from-scratch re-export that regenerates
//! every `GlobalId` rewrites tree **keys** and leaves every node address
//! untouched — the version reads as unchanged content under a key remapping,
//! which is the rename case `@ifc-lite/diff`'s content-matching tiers resolve
//! for one-to-one matches. They deliberately abstain where a match is not
//! one-to-one — a group of re-GUIDed coincident duplicates yields no remapping
//! at all — which is the same open case as relationship endpoints under
//! deduplication (`crate::node::Node::Relationship`).
//!
//! # Chunking
//!
//! A real delivery is hundreds of thousands of entities. A monolithic manifest
//! would be rewritten in full for a two-element change, so the manifest is
//! split into content-addressed chunks and a tree is the list of chunk
//! addresses; unchanged chunks are reused by reference between commits.
//!
//! Boundaries are **content-derived**, not positional. With fixed-size chunks,
//! inserting one entity shifts every subsequent entry and invalidates every
//! chunk after the insertion point. With a boundary chosen from the content
//! itself, an insertion disturbs one chunk. This is the packfile problem git
//! already solved; the design is reused, the code is not — git is GPL-2.0 and
//! cannot enter an MPL-2.0 tree (see the spec set, index §6.2).

use crate::address::{sort_key, Address, CanonicalWriter};

/// Magic announcing the tree-chunk format.
pub const CHUNK_MAGIC: &[u8; 4] = b"IGC1";
/// Magic announcing the tree format.
pub const TREE_MAGIC: &[u8; 4] = b"IGT1";
/// Format version within both magics.
pub const TREE_FORMAT_VERSION: u8 = 0;

/// Target entries per chunk. Boundaries are content-derived, so this is an
/// average rather than a cap — see [`is_boundary`].
pub const TARGET_CHUNK_ENTRIES: usize = 512;

/// One entry: an entity key, the node carrying its content, and its class.
///
/// `ifc_type` is duplicated here from the node deliberately, so listing a
/// version's contents needs no node fetch. It costs a few bytes per entry and
/// saves a random read per entry.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TreeEntry {
    /// The entity's stable identity in THIS version — typically `GlobalId`.
    pub key: String,
    /// Address of the node carrying the entity's content.
    pub node: Address,
    /// Exact IFC EXPRESS PascalCase class.
    pub ifc_type: String,
}

/// A run of entries, content-addressed so an unchanged run is reused.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TreeChunk {
    pub entries: Vec<TreeEntry>,
}

impl TreeChunk {
    /// Canonical bytes and address.
    pub fn encode(&self) -> (Address, Vec<u8>) {
        let mut w = CanonicalWriter::new(CHUNK_MAGIC, 0, TREE_FORMAT_VERSION);
        w.u32(self.entries.len() as u32);
        for entry in &self.entries {
            w.string(&entry.key);
            w.address(&entry.node);
            w.string(&entry.ifc_type);
        }
        w.finish()
    }

    pub fn address(&self) -> Address {
        self.encode().0
    }
}

/// A version's manifest: ordered chunk addresses.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Tree {
    pub chunks: Vec<Address>,
    /// Total entries across all chunks, so a count needs no chunk fetch.
    pub entry_count: u32,
}

impl Tree {
    pub fn encode(&self) -> (Address, Vec<u8>) {
        let mut w = CanonicalWriter::new(TREE_MAGIC, 0, TREE_FORMAT_VERSION);
        w.u32(self.entry_count);
        w.u32(self.chunks.len() as u32);
        for chunk in &self.chunks {
            w.address(chunk);
        }
        w.finish()
    }

    pub fn address(&self) -> Address {
        self.encode().0
    }
}

/// Should a chunk end after this entry?
///
/// Derived from the entry's **node address**, which is content, rather than
/// from its position. The probe is the low bits of the first digest byte pair:
/// a boundary falls roughly every [`TARGET_CHUNK_ENTRIES`] entries, and which
/// entries are boundaries depends only on content — so inserting an entity
/// shifts no boundary except possibly the one in its own chunk.
///
/// Deliberately not a rolling hash over a sliding window: the entries are
/// already content-addressed, so their digests are a usable uniform random
/// source and a second hash would buy nothing.
fn is_boundary(entry: &TreeEntry, target: usize) -> bool {
    debug_assert!(target > 0, "chunk target must be positive");
    let bytes = entry.node.as_bytes();
    let probe = u16::from_le_bytes([bytes[0], bytes[1]]);
    (probe as usize).is_multiple_of(target)
}

/// Build a tree from entries, chunking on content-derived boundaries.
///
/// Entries are sorted by NFC-normalized key bytes first, so the same set
/// of entries always produces the same tree regardless of the order the caller
/// walked the model in.
pub fn build_tree(mut entries: Vec<TreeEntry>) -> (Tree, Vec<TreeChunk>) {
    build_tree_with_target(std::mem::take(&mut entries), TARGET_CHUNK_ENTRIES)
}

/// [`build_tree`] with an explicit chunk target, for tests that need small
/// chunks without a hundred thousand entries.
pub fn build_tree_with_target(
    mut entries: Vec<TreeEntry>,
    target: usize,
) -> (Tree, Vec<TreeChunk>) {
    entries.sort_by(|a, b| {
        sort_key(&a.key)
            .cmp(&sort_key(&b.key))
            // A duplicate key is a defect upstream, but the tree must still be
            // deterministic if one arrives, so tie-break on content.
            .then_with(|| a.node.cmp(&b.node))
    });

    let entry_count = entries.len() as u32;
    let mut chunks: Vec<TreeChunk> = Vec::new();
    let mut current: Vec<TreeEntry> = Vec::new();

    for entry in entries {
        let boundary = is_boundary(&entry, target);
        current.push(entry);
        if boundary {
            chunks.push(TreeChunk {
                entries: std::mem::take(&mut current),
            });
        }
    }
    if !current.is_empty() {
        chunks.push(TreeChunk { entries: current });
    }

    let tree = Tree {
        chunks: chunks.iter().map(TreeChunk::address).collect(),
        entry_count,
    };
    (tree, chunks)
}

#[cfg(test)]
#[path = "tree_tests.rs"]
mod tests;
