// SPDX-License-Identifier: MPL-2.0
//! The viewer's visibility filters (`hidden`, `isolated`, `hidden_types`), one
//! decision for every exporter that takes them (glTF, OBJ, the Rhino scene).
//!
//! The lists are hashed once per export rather than scanned per mesh.
//! `isolated: Some(empty)` is an ACTIVE filter that keeps nothing, never the
//! same as `None` (no filter).

use rustc_hash::FxHashSet;

pub(crate) struct ElementFilter {
    hidden: FxHashSet<u32>,
    isolated: Option<FxHashSet<u32>>,
    hidden_types: FxHashSet<String>,
}

impl ElementFilter {
    pub(crate) fn new(hidden: &[u32], isolated: Option<&[u32]>, hidden_types: &[String]) -> Self {
        Self {
            hidden: hidden.iter().copied().collect(),
            isolated: isolated.map(|ids| ids.iter().copied().collect()),
            hidden_types: hidden_types.iter().cloned().collect(),
        }
    }

    /// Whether the element `express_id` of class `ifc_type` passes the filters.
    pub(crate) fn keeps(&self, express_id: u32, ifc_type: &str) -> bool {
        !self.hidden.contains(&express_id)
            && self.isolated.as_ref().is_none_or(|ids| ids.contains(&express_id))
            && !self.hidden_types.contains(ifc_type)
    }
}
