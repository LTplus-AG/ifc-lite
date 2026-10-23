// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
use crate::model::{EntityFingerprint, KeyDiff};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ContentMatchKind { Renamed, Moved, Reshaped, Respecified, Duplicated, Deduplicated, Ambiguous }
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ContentMatchTier { GeometryHash, GeometryOnly, ResidueOneToOne, Positional, Unresolved }
#[derive(Debug)]
pub struct ContentMatch<'a, R> {
    pub kind: ContentMatchKind,
    pub tier: ContentMatchTier,
    pub data_hash: String,
    pub geometry_hash: Option<String>,
    pub changed_components: Option<Vec<String>>,
    pub base: Vec<&'a EntityFingerprint<R>>,
    pub head: Vec<&'a EntityFingerprint<R>>,
    pub distance: Option<f64>,
}
#[derive(Debug)]
pub struct ContentDiff<'a, R> {
    pub core: KeyDiff<'a, R>,
    pub content_matches: Vec<ContentMatch<'a, R>>,
}
