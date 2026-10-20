// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use super::*;

fn kids(edges: &[(u32, &[u32])]) -> HashMap<u32, Vec<u32>> {
    edges.iter().map(|&(p, c)| (p, c.to_vec())).collect()
}

fn ids(visits: &[SpatialVisit]) -> Vec<u32> {
    visits.iter().map(|v| v.id).collect()
}

#[test]
fn pre_order_in_source_order() {
    let tree = kids(&[(1, &[2, 3]), (2, &[4, 5]), (3, &[6])]);
    let visits = walk(&tree, 1);
    assert_eq!(ids(&visits), [1, 2, 4, 5, 3, 6]);
    assert_eq!(visits[0], SpatialVisit { id: 1, parent: None, level: 0 });
    assert_eq!(visits[2], SpatialVisit { id: 4, parent: Some(2), level: 2 });
}

/// #4 hangs under both #2 and #3: the first in walk order, #2, owns it.
#[test]
fn the_first_parent_owns_a_shared_child() {
    let tree = kids(&[(1, &[2, 3]), (2, &[4]), (3, &[4, 5])]);
    let visits = walk(&tree, 1);
    assert_eq!(ids(&visits), [1, 2, 4, 3, 5]);
    assert_eq!(visits.iter().find(|v| v.id == 4).unwrap().parent, Some(2));
}

#[test]
fn a_cycle_ends() {
    let tree = kids(&[(1, &[2]), (2, &[1, 3]), (3, &[2])]);
    assert_eq!(ids(&walk(&tree, 1)), [1, 2, 3]);
}

#[test]
fn a_deep_chain_does_not_overflow_the_stack() {
    let tree: HashMap<u32, Vec<u32>> = (1..200_000u32).map(|i| (i, vec![i + 1])).collect();
    assert_eq!(walk(&tree, 1).len(), 200_000);
}
