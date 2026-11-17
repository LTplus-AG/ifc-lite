// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! #9102: which `Items` lists one walk has read, and so what a read costs.
//!
//! The Expand work meters bound AMPLIFICATION: work a walk does beyond what the
//! source spells out. A first read of a list costs nothing for each DISTINCT
//! item in it: that work is bounded by the records the file holds. It pays for
//! every repeated reference within the list, since `(#B,#B,…)` re-meshes one
//! heavy item per few bytes. A repeated read of a list pays every member,
//! ignored slots too, which is how a branching DAG fans out to `O(k^depth)`.
//! Charging every first read refused a single wide, acyclic surface model of
//! 65,536+ distinct items that WASM 10.4 meshed completely.
//!
//! One item listed by two different representations is meshed twice for
//! the price of two representation records, the same file-bounded class as
//! distinct items sharing one shell (the #9102 model itself), so it is not
//! charged.
//!
//! Mapped attempts are NOT exempt, distinct or not: entering a mapped item
//! expands a SHARED source, so N distinct items over one source emit N copies
//! of it from N small records. Every attempt pays the level meter.
//!
//! The set memoizes the CHARGE, never the visit: a source reached down two
//! branches is still walked twice (AGENTS.md "Bounding walks").

use ifc_lite_core::AttributeValue;
use rustc_hash::FxHashSet;
use smallvec::SmallVec;

/// Lists at most this long find their repeats by pairwise comparison, without
/// allocating. Nearly every Items list is far shorter.
const PAIRWISE_LIMIT: usize = 16;

/// Read lists: inline while few, hashed once a walk reads many.
#[derive(Clone, Debug)]
pub(crate) enum FirstSeen {
    Few(SmallVec<[u32; 8]>),
    Many(FxHashSet<u32>),
}

impl Default for FirstSeen {
    fn default() -> Self {
        Self::Few(SmallVec::new())
    }
}

/// One `Items` read's price, decided before anything is marked or resolved.
pub(crate) struct ListCharge {
    /// Members the meter must admit.
    pub(crate) cost: usize,
    pub(crate) rep: u32,
}

impl FirstSeen {
    pub(crate) fn contains(&self, rep: u32) -> bool {
        match self {
            Self::Few(reps) => reps.contains(&rep),
            Self::Many(reps) => reps.contains(&rep),
        }
    }

    pub(crate) fn insert(&mut self, rep: u32) {
        match self {
            Self::Few(reps) if reps.contains(&rep) => {}
            Self::Few(reps) if reps.len() < reps.inline_size() => reps.push(rep),
            Self::Few(reps) => {
                let mut many: FxHashSet<u32> = reps.drain(..).collect();
                many.insert(rep);
                *self = Self::Many(many);
            }
            Self::Many(reps) => {
                reps.insert(rep);
            }
        }
    }

    /// Price `rep`'s Items `members`: a repeated list (read here or in
    /// `pending`, a speculative step's uncommitted reads) pays every member, a
    /// first read every repeated reference.
    pub(crate) fn price(&self, pending: &[u32], rep: u32, members: &[AttributeValue]) -> ListCharge {
        let cost = if self.contains(rep) || pending.contains(&rep) {
            members.len()
        } else {
            repeated_references(members)
        };
        ListCharge { cost, rep }
    }

    /// Record an admitted read.
    pub(crate) fn admit(&mut self, charge: ListCharge) {
        self.insert(charge.rep);
    }
}

/// References in `members` that repeat an earlier one in the same list.
fn repeated_references(members: &[AttributeValue]) -> usize {
    if members.len() <= PAIRWISE_LIMIT {
        return members
            .iter()
            .enumerate()
            .filter(|(index, member)| {
                member.as_entity_ref().is_some_and(|id| {
                    members[..*index].iter().any(|earlier| earlier.as_entity_ref() == Some(id))
                })
            })
            .count();
    }
    let mut here = FxHashSet::with_capacity_and_hasher(members.len(), Default::default());
    members
        .iter()
        .filter_map(AttributeValue::as_entity_ref)
        .filter(|id| !here.insert(*id))
        .count()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn refs(ids: &[u32]) -> Vec<AttributeValue> {
        ids.iter().map(|id| AttributeValue::EntityRef(*id)).collect()
    }

    /// #9102 review: both detection paths count exactly the repeats, and an
    /// ignored slot is never a repeat on a first read.
    #[test]
    fn issue_9102_repeats_are_counted_alike_below_and_above_the_pairwise_limit() {
        let mut short = refs(&[1, 2, 1, 3, 1]);
        short.push(AttributeValue::Null);
        short.push(AttributeValue::Null);
        assert_eq!(repeated_references(&short), 2);
        let mut long = refs(&(0..40).map(|i| i % 10).collect::<Vec<_>>());
        long.push(AttributeValue::Null);
        assert!(long.len() > PAIRWISE_LIMIT);
        assert_eq!(repeated_references(&long), 30);
        assert_eq!(repeated_references(&refs(&(0..100).collect::<Vec<_>>())), 0);
    }

    #[test]
    fn issue_9102_read_lists_spill_from_inline_to_hashed_without_losing_one() {
        let mut seen = FirstSeen::default();
        for rep in 0..40 {
            seen.insert(rep);
        }
        assert!(matches!(seen, FirstSeen::Many(_)));
        assert!((0..40).all(|rep| seen.contains(rep)));
        assert!(!seen.contains(40));
        let charge = seen.price(&[], 3, &refs(&[7, 7]));
        assert_eq!(charge.cost, 2, "a repeated list pays every member");
        let charge = seen.price(&[41], 41, &refs(&[7]));
        assert_eq!(charge.cost, 1, "a pending read is a read");
        assert_eq!(seen.price(&[], 42, &refs(&[7, 7])).cost, 1);
    }
}
