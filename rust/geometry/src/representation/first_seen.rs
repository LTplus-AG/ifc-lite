// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! #9102: what one walk has already read, and so what an `Items` read costs.
//!
//! The Expand work meters bound AMPLIFICATION: work a walk does beyond what the
//! source spells out. A first read of a list costs nothing for each DISTINCT
//! item it is the first to reach: that work is bounded by the records the file
//! holds. It pays for every reference to an item the walk has already reached,
//! including a repeat earlier in the same list, since `(#B,#B,…)` re-meshes
//! one heavy item per few bytes. A repeated read of a list pays every member,
//! ignored slots too, which is how a branching DAG fans out to `O(k^depth)`.
//! Charging every first read refused a single wide, acyclic surface model of
//! 65,536+ distinct items that WASM 10.4 meshed completely.
//!
//! Mapped attempts are NOT exempt, distinct or not: entering a mapped item
//! expands a SHARED source, so N distinct items over one source emit N copies
//! of it from N small records. Every attempt pays the level meter.
//!
//! The sets memoize the CHARGE, never the visit: a source reached down two
//! branches is still walked twice (AGENTS.md "Bounding walks").

use ifc_lite_core::AttributeValue;
use rustc_hash::FxHashSet;

#[derive(Clone, Debug, Default)]
pub(crate) struct FirstSeen {
    lists: FxHashSet<u32>,
    members: FxHashSet<u32>,
}

/// One `Items` read's price, decided before anything is marked or resolved.
pub(crate) struct ListCharge {
    /// Members the meter must admit.
    pub(crate) cost: usize,
    rep: u32,
    /// References this read is the first to reach.
    fresh: Vec<u32>,
}

impl FirstSeen {
    /// Price `rep`'s Items `members` against this walk's reads, here and in
    /// `pending` (reads a speculative step has not committed yet).
    pub(crate) fn price(&self, pending: Option<&FirstSeen>, rep: u32, members: &[AttributeValue]) -> ListCharge {
        let list_read = |id: u32| self.lists.contains(&id) || pending.is_some_and(|p| p.lists.contains(&id));
        if list_read(rep) {
            return ListCharge { cost: members.len(), rep, fresh: Vec::new() };
        }
        let reached = |id: u32| self.members.contains(&id) || pending.is_some_and(|p| p.members.contains(&id));
        let mut here = FxHashSet::default();
        let mut fresh = Vec::new();
        let mut cost = 0;
        for id in members.iter().filter_map(AttributeValue::as_entity_ref) {
            if reached(id) || !here.insert(id) {
                cost += 1;
            } else {
                fresh.push(id);
            }
        }
        ListCharge { cost, rep, fresh }
    }

    /// Record an admitted read.
    pub(crate) fn admit(&mut self, charge: ListCharge) {
        self.lists.insert(charge.rep);
        self.members.extend(charge.fresh);
    }

    /// Fold another walk state's reads into this one.
    pub(crate) fn absorb(&mut self, other: FirstSeen) {
        self.lists.extend(other.lists);
        self.members.extend(other.members);
    }

    pub(crate) fn is_empty(&self) -> bool {
        self.lists.is_empty() && self.members.is_empty()
    }

    /// Test seam: treat `rep`'s Items as already read.
    #[cfg(test)]
    pub(crate) fn mark_list_read(&mut self, rep: u32) {
        self.lists.insert(rep);
    }
}
