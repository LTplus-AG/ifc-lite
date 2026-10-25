// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Store-independent comparison inputs and key-pass results (#8042).
use std::collections::HashMap;

#[derive(Debug, Clone, PartialEq)]
pub struct EntityAabb {
    pub min: [f64; 3],
    pub max: [f64; 3],
}

/// Geometry hashes are opaque strings. The JS boundary converts bigint hashes
/// to decimal strings, without interpreting string hashes as numbers.
#[derive(Debug, Clone, PartialEq)]
pub struct EntityFingerprint<R = ()> {
    pub key: String,
    pub ifc_type: String,
    pub data_hash: String,
    pub geometry_hash: Option<String>,
    pub aabb: Option<EntityAabb>,
    pub volume: Option<f64>,
    pub components: Option<HashMap<String, String>>,
    pub container: Option<String>,
    pub reference: R,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum DiffScope {
    Data,
    Geometry,
    #[default]
    Both,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DiffState { Added, Modified, Deleted, Unchanged }

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DiffChangeKind { Data, Geometry, Container }

#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct DiffCounts {
    pub added: usize,
    pub modified: usize,
    pub deleted: usize,
    pub unchanged: usize,
}

/// Borrows the caller's entities; opaque adapter handles are never cloned or read.
#[derive(Debug)]
pub struct DiffEntry<'a, R> {
    pub key: String,
    pub state: DiffState,
    pub change_kinds: Vec<DiffChangeKind>,
    pub base: Option<&'a EntityFingerprint<R>>,
    pub head: Option<&'a EntityFingerprint<R>>,
    pub changed_components: Option<Vec<String>>,
}

#[derive(Debug, Default)]
pub struct KeyDiffOptions {
    pub scope: DiffScope,
    pub exclude_types: Vec<String>,
    /// Absence differs from an explicitly supplied empty alias map.
    pub key_aliases: Option<HashMap<String, String>>,
}

#[derive(Debug)]
pub struct KeyDiff<'a, R> {
    pub scope: DiffScope,
    pub excluded_types: Vec<String>,
    pub entries: Vec<DiffEntry<'a, R>>,
    /// Entry indices avoid cloning entities or requiring Clone on adapter handles.
    pub by_key: HashMap<String, usize>,
    pub counts: DiffCounts,
    pub applied_key_aliases: Option<Vec<(String, String)>>,
    /// Resolved once for the content-matching stages too.
    pub use_geometry: bool,
}
