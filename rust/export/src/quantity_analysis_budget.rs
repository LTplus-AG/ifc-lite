// SPDX-License-Identifier: MPL-2.0
//! Aggregate work accounting before shared quantity-record decoding.

use std::collections::HashMap;
use ifc_lite_core::{AttributeValue, EntityIndex};

use super::{MAX_AUTHORED_ROWS, MAX_CONFLICT_COMPARISONS, MAX_LEAF_DECODE_BYTES,
    MAX_QUANTITY_LEAF_VISITS, MAX_REF_RECORD_BYTES, MAX_REL_LINKS, MAX_SET_DECODE_BYTES,
    MAX_SET_VISITS};

pub(super) struct AnalysisLimits {
    pub rows: usize,
    pub sets: usize,
    pub leaves: usize,
    pub set_bytes: usize,
    pub leaf_bytes: usize,
    pub links: usize,
    pub comparisons: usize,
}

impl Default for AnalysisLimits {
    fn default() -> Self {
        Self { rows: MAX_AUTHORED_ROWS, sets: MAX_SET_VISITS,
            leaves: MAX_QUANTITY_LEAF_VISITS, set_bytes: MAX_SET_DECODE_BYTES,
            leaf_bytes: MAX_LEAF_DECODE_BYTES, links: MAX_REL_LINKS,
            comparisons: MAX_CONFLICT_COMPARISONS }
    }
}

pub(super) struct ExpansionBudget {
    pub rows: usize,
    pub sets: usize,
    pub leaves: usize,
    pub set_bytes: usize,
    pub leaf_bytes: usize,
    pub leaf_counts: HashMap<u32, usize>,
}

pub(super) enum LeafBudgetError { Visits, Bytes, Oversized(u32) }

impl ExpansionBudget {
    /// Charge every reference, including repeated or unsupported leaves, before
    /// `decode_quantity_records` clones any entity from the decoder cache.
    pub(super) fn charge_leaf_refs(&mut self, refs: &[AttributeValue],
        index: &EntityIndex) -> Result<(), LeafBudgetError> {
        if refs.len() > self.leaves { return Err(LeafBudgetError::Visits); }
        self.leaves -= refs.len();
        let mut bytes = 0usize;
        for id in refs.iter().filter_map(AttributeValue::as_entity_ref) {
            let record_bytes = index.get(&id).map_or(0, |(start, end)| end.saturating_sub(*start));
            if record_bytes > MAX_REF_RECORD_BYTES { return Err(LeafBudgetError::Oversized(id)); }
            bytes = bytes.checked_add(record_bytes).ok_or(LeafBudgetError::Bytes)?;
            if bytes > self.leaf_bytes { return Err(LeafBudgetError::Bytes); }
        }
        self.leaf_bytes -= bytes;
        Ok(())
    }
}
