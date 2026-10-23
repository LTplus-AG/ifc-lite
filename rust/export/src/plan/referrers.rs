// SPDX-License-Identifier: MPL-2.0
//! Who refers to a record, collected only for the records a plan asks about.
//!
//! Two questions get asked, and they cost differently:
//!
//! - [`FileIndex::referrers`]: the full `(referrer, attribute index)` list.
//!   Needed where a referrer has to be edited or judged by its type: the
//!   records a delete repairs, the sharing checks on a placement or property
//!   set, the relationships attached to a patched object.
//! - [`FileIndex::referrer_count`]: how many distinct records refer to it.
//!   Enough to decide whether a record is orphaned once some of its
//!   referrers are gone, which is all delete's cascade and a placement's
//!   sweep need for everything below the record they started from.
//!
//! Resolution runs against whatever has been collected so far. A question
//! about an id not collected yet is recorded as missing and answered
//! conservatively (no referrers to repair, not orphaned). [`super::execute`]
//! then makes one streaming pass over the file for everything missing and
//! resolves again, until a resolution completes without a miss. Only that
//! last resolution is used, and every answer it read was exact.
//!
//! A count miss collects counts for the record's whole forward closure in the
//! same pass, so a cascade running down a geometry tree costs one pass, not
//! one per level. A list miss is one level of the other direction: a record
//! that dies because it names a dying record. That is what bounds the number
//! of passes: one to learn the referrers of what the plan names, one more for
//! each level of such chains. On an ordinary model the relationships a
//! deleted object takes with it are referred to by nothing, so the chain
//! stops at the first level and resolution converges after two passes.
//! Deleting a record that many others hang off by a scalar attribute (a
//! storey's placement, say) runs one pass per level of that chain.

use std::cell::RefCell;

use rustc_hash::{FxHashMap, FxHashSet};

use super::index::{parse_attrs, FileIndex};

#[derive(Default)]
pub(crate) struct Referrers {
    lists: FxHashMap<u32, Vec<(u32, usize)>>,
    counts: FxHashMap<u32, u32>,
    missing_lists: RefCell<FxHashSet<u32>>,
    missing_counts: RefCell<FxHashSet<u32>>,
    passes: usize,
}

impl Referrers {
    /// Streaming passes made so far.
    #[cfg(test)]
    pub(crate) fn passes(&self) -> usize {
        self.passes
    }

    /// `(ids with a collected list, ids with a collected count)`.
    #[cfg(test)]
    pub(crate) fn collected(&self) -> (usize, usize) {
        (self.lists.len(), self.counts.len())
    }
}

impl<'a> FileIndex<'a> {
    /// Every `(referrer, attribute index)` naming `id`, in file order, one
    /// entry per slot or list entry. Empty (and recorded as missing) until
    /// collected.
    pub(crate) fn referrers(&self, id: u32) -> &[(u32, usize)] {
        match self.referrers.lists.get(&id) {
            Some(list) => list,
            None => {
                self.referrers.missing_lists.borrow_mut().insert(id);
                &[]
            }
        }
    }

    /// Distinct records naming `id`, or `None` (recorded as missing) until
    /// collected.
    pub(crate) fn referrer_count(&self, id: u32) -> Option<usize> {
        if let Some(list) = self.referrers.lists.get(&id) {
            let distinct: FxHashSet<u32> = list.iter().map(|&(r, _)| r).collect();
            return Some(distinct.len());
        }
        if let Some(&n) = self.referrers.counts.get(&id) {
            return Some(n as usize);
        }
        self.referrers.missing_counts.borrow_mut().insert(id);
        None
    }

    /// Collect everything the last resolution found missing, in one pass.
    /// Returns `false` when nothing was missing: that resolution is final.
    pub(crate) fn collect_missing_referrers(&mut self) -> bool {
        let lists: FxHashSet<u32> = self.referrers.missing_lists.take();
        let count_roots: FxHashSet<u32> = self.referrers.missing_counts.take();
        if lists.is_empty() && count_roots.is_empty() {
            return false;
        }
        let counts = self.forward_closure(count_roots);
        self.collect(lists, counts);
        true
    }

    /// `roots` and every record reachable from them through attribute
    /// references, minus what is already collected.
    fn forward_closure(&self, roots: FxHashSet<u32>) -> FxHashSet<u32> {
        let mut seen: FxHashSet<u32> = FxHashSet::default();
        let mut stack: Vec<u32> = roots.into_iter().collect();
        while let Some(id) = stack.pop() {
            if !seen.insert(id) {
                continue;
            }
            stack.extend(self.refs_of(id).into_iter().filter(|t| !seen.contains(t)));
        }
        let r = &self.referrers;
        seen.retain(|id| !r.lists.contains_key(id) && !r.counts.contains_key(id));
        seen
    }

    fn collect(&mut self, lists: FxHashSet<u32>, counts: FxHashSet<u32>) {
        let mut found_lists: FxHashMap<u32, Vec<(u32, usize)>> = lists.iter().map(|&id| (id, Vec::new())).collect();
        let mut found_counts: FxHashMap<u32, u32> = counts.iter().map(|&id| (id, 0)).collect();
        let mut counted: Vec<u32> = Vec::new();

        for (id, _, start, end) in self.records() {
            let bytes = &self.content()[start..end];
            if !names_any(bytes, |t| lists.contains(&t) || counts.contains(&t)) {
                continue;
            }
            let Some(attrs) = parse_attrs(&String::from_utf8_lossy(bytes)) else { continue };
            counted.clear();
            for (idx, attr) in attrs.iter().enumerate() {
                for target in attr.refs() {
                    if let Some(list) = found_lists.get_mut(&target) {
                        list.push((id, idx));
                    }
                    if found_counts.contains_key(&target) && !counted.contains(&target) {
                        counted.push(target);
                    }
                }
            }
            for target in &counted {
                *found_counts.get_mut(target).expect("counted only when present") += 1;
            }
        }

        self.referrers.lists.extend(found_lists);
        self.referrers.counts.extend(found_counts);
        self.referrers.passes += 1;
    }

    /// Test fixtures are small enough to collect every list up front, so a
    /// unit test can call a resolver once and get the exact answer.
    #[cfg(test)]
    pub(crate) fn complete(content: &'a [u8]) -> Self {
        let mut index = Self::scan(content, &FxHashSet::default());
        index.collect_all_referrers();
        index
    }

    #[cfg(test)]
    pub(crate) fn collect_all_referrers(&mut self) {
        let mut every: FxHashSet<u32> = FxHashSet::default();
        for (id, _, start, end) in self.records() {
            every.insert(id);
            let mut refs = Vec::new();
            crate::step_text::refs_in_line(&self.content()[start..end], &mut refs);
            every.extend(refs);
        }
        self.collect(every, FxHashSet::default());
    }
}

/// Whether `line` holds any `#digits` token `wanted` accepts. Deliberately
/// blind to quotes and comments, so it can only over-report: a quote inside a
/// comment would otherwise hide the references after it, which the exact
/// parse that follows does see.
fn names_any(line: &[u8], wanted: impl Fn(u32) -> bool) -> bool {
    let mut i = 0;
    while let Some(off) = line[i..].iter().position(|&b| b == b'#') {
        let mut j = i + off + 1;
        let mut value: u64 = 0;
        let digits_start = j;
        while j < line.len() && line[j].is_ascii_digit() {
            value = value.saturating_mul(10).saturating_add(u64::from(line[j] - b'0'));
            j += 1;
        }
        if j > digits_start {
            if let Ok(id) = u32::try_from(value) {
                if wanted(id) {
                    return true;
                }
            }
        }
        i = j;
    }
    false
}

#[cfg(test)]
#[path = "referrers_tests.rs"]
mod tests;
