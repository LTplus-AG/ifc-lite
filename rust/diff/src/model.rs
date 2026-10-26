// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Store-independent comparison inputs and key-pass results (#8042).
use crate::JsString;
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
    pub key: JsString,
    pub ifc_type: JsString,
    pub data_hash: JsString,
    pub geometry_hash: Option<JsString>,
    pub aabb: Option<EntityAabb>,
    pub volume: Option<f64>,
    pub components: Option<HashMap<JsString, JsString>>,
    pub container: Option<JsString>,
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
    pub key: JsString,
    pub state: DiffState,
    pub change_kinds: Vec<DiffChangeKind>,
    pub base: Option<&'a EntityFingerprint<R>>,
    pub head: Option<&'a EntityFingerprint<R>>,
    pub changed_components: Option<Vec<JsString>>,
}

#[derive(Debug, Default)]
pub struct KeyDiffOptions {
    pub scope: DiffScope,
    pub exclude_types: Vec<JsString>,
    /// Absence differs from an explicitly supplied empty alias map.
    pub key_aliases: Option<HashMap<JsString, JsString>>,
}

#[derive(Debug)]
pub struct KeyDiff<'a, R> {
    pub scope: DiffScope,
    pub excluded_types: Vec<JsString>,
    pub entries: Vec<DiffEntry<'a, R>>,
    /// Entry indices avoid cloning entities or requiring Clone on adapter handles.
    pub by_key: HashMap<JsString, usize>,
    pub counts: DiffCounts,
    pub applied_key_aliases: Option<Vec<(JsString, JsString)>>,
    /// Resolved once for the content-matching stages too.
    pub use_geometry: bool,
}
