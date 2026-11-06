// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! #9102: what one walk has already paid for with the file itself.
//!
//! The Expand work meters bound AMPLIFICATION: work a walk does beyond what the
//! source spells out. The first materialization of a distinct `Items` list, and
//! the first entry into a distinct `IfcMappedItem`, cost no more than the bytes
//! that author them, so they are bounded by the input and do not debit the
//! meters. Every repeated occurrence, which is how a branching DAG fans out to
//! `O(k^depth)`, still pays the full count before anything is materialized.
//! Charging the first read too refused a single wide, acyclic surface model of
//! 65,536+ items that WASM 10.4 meshed completely.
//!
//! The set is walk-global and memoizes the CHARGE, never the visit: a source
//! reached down two branches is still walked twice (AGENTS.md "Bounding walks").

use rustc_hash::FxHashSet;

#[derive(Clone, Debug, Default)]
pub(crate) struct FirstSeen(FxHashSet<u64>);

impl FirstSeen {
    /// The key of representation `rep`'s `Items` list.
    pub(crate) fn list(rep: u32) -> u64 {
        u64::from(rep)
    }

    /// The key of an entry into `IfcMappedItem` `item`.
    pub(crate) fn entry(item: u32) -> u64 {
        (1 << 32) | u64::from(item)
    }

    pub(crate) fn contains(&self, key: u64) -> bool {
        self.0.contains(&key)
    }

    /// Mark `key` seen; whether this was its first time.
    pub(crate) fn insert(&mut self, key: u64) -> bool {
        self.0.insert(key)
    }

    /// Whether this walk materializes the `Items` of representation `rep` for
    /// the first time. Marks it seen.
    pub(crate) fn first_list(&mut self, rep: u32) -> bool {
        self.insert(Self::list(rep))
    }

    /// Whether this walk enters `IfcMappedItem` `item` for the first time.
    /// Marks it seen.
    pub(crate) fn first_entry(&mut self, item: u32) -> bool {
        self.insert(Self::entry(item))
    }
}
