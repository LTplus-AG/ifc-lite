// SPDX-License-Identifier: MPL-2.0
//! Copy-on-write for STEP records, resolved into copies and repointings.
//!
//! One `CopyOnWriteMutation` says: this element should stop sharing that
//! record, so give it a private copy carrying a new value and point it at the
//! copy instead. Two things come out, and the exporter needs both before it
//! emits anything: the copies to write after the DATA section it already has,
//! and the rewritten attribute each referrer now carries.
//!
//! Split out of `step.rs` because the pass grew its own rules, and each of them
//! exists because a file came out wrong without it: an id budget, a chain that
//! cannot be expressed, two edits landing on one copy, and a referrer index
//! that has to be checked before an id is spent.

use std::collections::{BTreeMap, HashMap, HashSet};

use crate::step_text::{attribute_of, substitute_ref_in_attr};
use crate::CopyOnWriteMutation;

/// A record to emit: the id it gets, the record it copies, and the attributes
/// that differ in the copy.
pub(crate) type Copy = (u32, u32, BTreeMap<usize, String>);

/// What the pass produces. `repointed` is keyed by referrer id and then by
/// attribute index, which is the shape the emit loop applies.
pub(crate) struct Resolved {
    pub(crate) copies: Vec<Copy>,
    pub(crate) repointed: HashMap<u32, BTreeMap<usize, String>>,
    /// Mutations that were asked for and not made. Counted so the caller learns
    /// an edit is missing rather than reading a clean export.
    pub(crate) refused: usize,
    /// Where the next synthesized record starts, so property synthesis
    /// continues from the same counter and the two cannot collide.
    pub(crate) next_id: Option<u32>,
}

/// A mutation that survived every check not needing an allocated id, carrying
/// the referrer attribute as the record spells it.
struct Candidate<'a> {
    cow: &'a CopyOnWriteMutation,
    from_record: String,
}

/// Everything that can be decided from the file alone.
///
/// Separated from the emit loop because the chain rule below needs to know
/// which copies are real before it can refuse anything on their account, and
/// "the caller asked for it" is not the same as "it can be made".
fn candidate<'a>(
    cow: &'a CopyOnWriteMutation,
    content: &[u8],
    line_of: &HashMap<u32, (usize, usize)>,
    included: &HashSet<u32>,
) -> Option<Candidate<'a>> {
    let &(source_start, source_end) = line_of.get(&cow.express_id)?;
    if !included.contains(&cow.referrer_id) {
        return None;
    }
    // The attribute has to exist before an id is spent on the copy.
    // `apply_attr_mutations` ignores an index past the end, so without this the
    // copy comes out identical to the record it copied and the referrer is
    // repointed at a duplicate that changed nothing.
    let source_line = String::from_utf8_lossy(&content[source_start..source_end]);
    attribute_of(&source_line, cow.index)?;

    let &(rs, re) = line_of.get(&cow.referrer_id)?;
    // Checked against the record, and not against whatever the caller happens
    // to have staged for that attribute. A caller edit at an index the record
    // does not have would otherwise satisfy the lookup in the loop below, and
    // the repointing computed from it is dropped at emit time by the same
    // out-of-range rule: an id spent and a copy nothing points at.
    let referrer_line = String::from_utf8_lossy(&content[rs..re]);
    let from_record = attribute_of(&referrer_line, cow.referrer_index)?;
    // The referrer has to hold the reference for there to be anything to
    // repoint. Checked here as well as in the loop, because a mutation that
    // cannot emit must not make the chain rule refuse another one.
    substitute_ref_in_attr(&from_record, cow.express_id, 0)?;

    Some(Candidate { cow, from_record })
}

/// Resolve every mutation the file can express, and count the rest.
///
/// `next_id` is `None` when the id space is spent. Saturating was worse than
/// the overflow it replaced: on a file holding `u32::MAX` it leaves the counter
/// equal to an id the file already uses, so the first copy silently collides
/// with a real record. A file that has spent the whole id space has no room for
/// another record, and emitting one anyway corrupts it.
pub(crate) fn resolve(
    mutations: &[CopyOnWriteMutation],
    content: &[u8],
    line_of: &HashMap<u32, (usize, usize)>,
    included: &HashSet<u32>,
    caller_edits: &HashMap<u32, BTreeMap<usize, String>>,
    mut next_id: Option<u32>,
) -> Resolved {
    let candidates: Vec<Candidate<'_>> = mutations
        .iter()
        .filter_map(|cow| candidate(cow, content, line_of, included))
        .collect();
    let mut refused = mutations.len() - candidates.len();

    // A record that is itself being copied cannot also be repointed.
    //
    // Take one element wanting both its own property set and its own value in
    // it: the caller issues "copy the property, repoint the set" and "copy the
    // set, repoint the relationship". The first rewrites the *shared* set, so
    // every other element reading that set silently picks up this element's new
    // value, while this element reads its own copy of the set, which still
    // points at the old record. The edit lands on everyone except the element
    // that asked for it.
    //
    // Saying what was meant needs the mutation to name the copy rather than the
    // record, and `CopyOnWriteMutation` has no way to. So the inner one is
    // dropped: the element gets its own set holding the value it already had,
    // which is incomplete and not wrong. Applying it is wrong.
    //
    // Built from the candidates rather than the request, so a copy that cannot
    // be made does not refuse a repointing that can.
    let copied: HashSet<u32> = candidates.iter().map(|c| c.cow.express_id).collect();

    let mut copies: Vec<Copy> = Vec::new();
    let mut repointed: HashMap<u32, BTreeMap<usize, String>> = HashMap::new();
    // Which copy already serves a (record, referrer, attribute), so a second
    // edit to the same record folds into it. `CopyOnWriteMutation` carries one
    // attribute, so editing a property's value and its unit is two mutations
    // through one referrer; the second used to find its reference already
    // repointed, conclude the referrer did not hold it, and vanish.
    let mut serving: HashMap<(u32, u32, usize), usize> = HashMap::new();

    for Candidate { cow, from_record } in candidates {
        if copied.contains(&cow.referrer_id) {
            refused += 1;
            continue;
        }

        // A second edit to a record this referrer already has a copy of. No new
        // id, no second substitution: the value joins the copy that is already
        // being emitted.
        if let Some(&at) = serving.get(&(cow.express_id, cow.referrer_id, cow.referrer_index)) {
            copies[at].2.insert(cow.index, cow.value.clone());
            continue;
        }
        let Some(copy_id) = next_id else {
            // No id left to give it. Skipped rather than duplicated, and
            // counted: a caller reading a clean export would have no way to
            // know the edit is not in it.
            refused += 1;
            continue;
        };

        // What the attribute holds now: an earlier substitution's output, then
        // the caller's edit, then the record. An earlier substitution already
        // started from the caller's value, so reading it first accumulates.
        let current = repointed
            .get(&cow.referrer_id)
            .and_then(|edits| edits.get(&cow.referrer_index))
            .or_else(|| {
                caller_edits
                    .get(&cow.referrer_id)
                    .and_then(|edits| edits.get(&cow.referrer_index))
            })
            .cloned()
            .unwrap_or(from_record);
        let Some(rewritten) = substitute_ref_in_attr(&current, cow.express_id, copy_id) else {
            // The record holds the reference and the value staged for that
            // attribute does not, so an earlier edit took it out. Emitting the
            // copy anyway would leave a record nothing points at.
            refused += 1;
            continue;
        };

        next_id = copy_id.checked_add(1);
        serving.insert(
            (cow.express_id, cow.referrer_id, cow.referrer_index),
            copies.len(),
        );
        copies.push((
            copy_id,
            cow.express_id,
            BTreeMap::from([(cow.index, cow.value.clone())]),
        ));
        repointed
            .entry(cow.referrer_id)
            .or_default()
            .insert(cow.referrer_index, rewritten);
    }

    Resolved {
        copies,
        repointed,
        next_id,
        refused,
    }
}
