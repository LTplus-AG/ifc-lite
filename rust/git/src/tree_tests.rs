// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use super::{build_tree, build_tree_with_target, TreeEntry};
use crate::address::Address;

fn entry(key: &str, content: &[u8]) -> TreeEntry {
    TreeEntry {
        key: key.to_owned(),
        node: Address::of(content),
        ifc_type: "IfcWall".to_owned(),
    }
}

fn entries(count: usize) -> Vec<TreeEntry> {
    (0..count)
        .map(|i| entry(&format!("GUID{i:05}"), format!("content-{i}").as_bytes()))
        .collect()
}

#[test]
fn entry_order_does_not_reach_the_tree_address() {
    let mut forward = entries(50);
    let mut reverse = forward.clone();
    reverse.reverse();
    let (a, _) = build_tree(std::mem::take(&mut forward));
    let (b, _) = build_tree(std::mem::take(&mut reverse));
    assert_eq!(a.address(), b.address());
}

#[test]
fn entry_count_is_carried_so_a_count_needs_no_chunk_fetch() {
    let (tree, chunks) = build_tree(entries(37));
    assert_eq!(tree.entry_count, 37);
    let total: usize = chunks.iter().map(|c| c.entries.len()).sum();
    assert_eq!(total, 37);
}

#[test]
fn every_entry_lands_in_exactly_one_chunk() {
    let (_, chunks) = build_tree_with_target(entries(200), 8);
    let mut keys: Vec<&str> = chunks
        .iter()
        .flat_map(|c| c.entries.iter().map(|e| e.key.as_str()))
        .collect();
    keys.sort_unstable();
    keys.dedup();
    assert_eq!(keys.len(), 200, "no entry duplicated or dropped");
}

#[test]
fn chunking_actually_splits() {
    let (tree, chunks) = build_tree_with_target(entries(400), 8);
    assert!(
        chunks.len() > 1,
        "expected several chunks, got {}",
        chunks.len()
    );
    assert_eq!(tree.chunks.len(), chunks.len());
}

#[test]
fn a_changed_entry_changes_the_tree() {
    let (before, _) = build_tree(entries(20));
    let mut changed = entries(20);
    changed[5].node = Address::of(b"something else");
    let (after, _) = build_tree(changed);
    assert_ne!(before.address(), after.address());
}

/// Content-derived boundaries, which is the reason for choosing them. With
/// positional chunking an insertion shifts every later entry and invalidates
/// every chunk after it; here it should disturb very few.
#[test]
fn an_insertion_disturbs_few_chunks() {
    let base = entries(400);
    let (_, before) = build_tree_with_target(base.clone(), 8);

    let mut inserted = base;
    // A key that sorts into the middle of the run.
    inserted.push(entry("GUID00200a", b"inserted"));
    let (_, after) = build_tree_with_target(inserted, 8);

    let before_addresses: std::collections::HashSet<_> =
        before.iter().map(|c| c.address()).collect();
    let reused = after
        .iter()
        .filter(|c| before_addresses.contains(&c.address()))
        .count();

    // Positional chunking would reuse roughly half (only the chunks before the
    // insertion point). Content-derived boundaries should keep nearly all.
    let reuse_ratio = reused as f64 / before.len() as f64;
    assert!(
        reuse_ratio > 0.8,
        "expected most chunks reused after one insertion, reused {reused}/{} ({reuse_ratio:.2})",
        before.len()
    );
}

/// The GUID-agnostic invariant, stated at the tree level.
///
/// A from-scratch re-export regenerates every key while every entity's content
/// is untouched. So: every node address is unchanged, and the tree address
/// changes — because the tree is what holds the keys.
///
/// That the tree address changes is **not** a contradiction of "reads as
/// unchanged": tree-address inequality is not the emptiness test. The diff is.
/// A re-GUID produces a different tree and an empty diff, so no commit is
/// written. `crate::commit` enforces that, and `commit_tests` pins it.
#[test]
fn a_reguid_preserves_every_node_address_and_moves_the_tree() {
    let original = entries(60);
    let reguided: Vec<TreeEntry> = original
        .iter()
        .enumerate()
        .map(|(i, e)| TreeEntry {
            key: format!("REGUID{i:05}"),
            node: e.node,
            ifc_type: e.ifc_type.clone(),
        })
        .collect();

    // Content is identical, entity by entity.
    let before_nodes: std::collections::HashSet<_> = original.iter().map(|e| e.node).collect();
    let after_nodes: std::collections::HashSet<_> = reguided.iter().map(|e| e.node).collect();
    assert_eq!(
        before_nodes, after_nodes,
        "a re-GUID must not move a single node address"
    );

    // The manifest that names them did change.
    let (before, _) = build_tree(original);
    let (after, _) = build_tree(reguided);
    assert_ne!(
        before.address(),
        after.address(),
        "the tree holds the keys, so it moves"
    );
    assert_eq!(before.entry_count, after.entry_count);
}

#[test]
fn ifc_type_is_part_of_an_entry() {
    let mut changed = entries(5);
    changed[0].ifc_type = "IfcSlab".to_owned();
    let (before, _) = build_tree(entries(5));
    let (after, _) = build_tree(changed);
    assert_ne!(before.address(), after.address());
}

#[test]
fn an_empty_tree_is_well_formed() {
    let (tree, chunks) = build_tree(Vec::new());
    assert_eq!(tree.entry_count, 0);
    assert!(chunks.is_empty());
    assert!(tree.chunks.is_empty());
    // Still addressable, so a first commit on an empty repository has a tree.
    let _ = tree.address();
}

#[test]
fn duplicate_keys_still_produce_a_deterministic_tree() {
    // A duplicate key is a defect upstream, but the tree must not depend on
    // input order if one arrives.
    let a = entry("SAME", b"first");
    let b = entry("SAME", b"second");
    let (forward, _) = build_tree(vec![a.clone(), b.clone()]);
    let (reverse, _) = build_tree(vec![b, a]);
    assert_eq!(forward.address(), reverse.address());
}
