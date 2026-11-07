// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! #9102: which `Items` lists one walk has already read.
//!
//! The Expand work meters bound AMPLIFICATION: work a walk does beyond what the
//! source spells out. The first read of a distinct `Items` list costs no more
//! than the bytes that author it, so it is bounded by the input and does not
//! debit the member meter. Every repeated read of a list, which is how a
//! branching DAG fans out to `O(k^depth)`, still pays its full count before
//! anything is materialized. Charging the first read too refused a single wide,
//! acyclic surface model of 65,536+ items that WASM 10.4 meshed completely.
//!
//! Mapped attempts are NOT exempt, distinct or not: entering a mapped item
//! expands a SHARED source, so N distinct items over one source emit N copies
//! of it from N small records. Every attempt pays the level meter.
//!
//! The set is walk-global and memoizes the CHARGE, never the visit: a source
//! reached down two branches is still walked twice (AGENTS.md "Bounding walks").

use rustc_hash::FxHashSet;

#[derive(Clone, Debug, Default)]
pub(crate) struct FirstSeen(FxHashSet<u32>);

impl FirstSeen {
    pub(crate) fn contains(&self, rep: u32) -> bool {
        self.0.contains(&rep)
    }

    /// Mark representation `rep`'s Items read; whether this was the first read.
    pub(crate) fn first_list(&mut self, rep: u32) -> bool {
        self.0.insert(rep)
    }
}
