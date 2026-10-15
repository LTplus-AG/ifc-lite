// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! #7633: bound a plane fit to facets connected through complete canonical
//! edges. A point contact is not a common surface. The existing position dedup
//! supplies these IDs, so adjacent jittered facets keep their shared edges.

use std::collections::BTreeMap;

struct Components {
    parent: Vec<usize>,
    size: Vec<usize>,
    count: usize,
}

impl Components {
    fn root(&mut self, mut i: usize) -> usize {
        let mut root = i;
        while self.parent[root] != root {
            root = self.parent[root];
        }
        while self.parent[i] != i {
            let next = self.parent[i];
            self.parent[i] = root;
            i = next;
        }
        root
    }

    fn join(&mut self, a: usize, b: usize) {
        let (mut a, mut b) = (self.root(a), self.root(b));
        if a == b {
            return;
        }
        if self.size[a] < self.size[b] || (self.size[a] == self.size[b] && a > b) {
            std::mem::swap(&mut a, &mut b);
        }
        self.parent[b] = a;
        self.size[a] += self.size[b];
        self.count -= 1;
    }
}

/// At most three edge-map entries per facet, with iterative union-by-size and
/// path compression. No pairwise triangle scan, tolerance, or recursive walk.
/// Each component and the components themselves retain original member order.
pub(super) fn for_each(
    members: &[usize],
    triangle: impl Fn(usize) -> [usize; 3],
    mut allow_split: impl FnMut(&[Vec<usize>]) -> bool,
    mut visit: impl FnMut(&[usize]),
) {
    let n = members.len();
    let mut components = Components {
        parent: (0..n).collect(),
        size: vec![1; n],
        count: n,
    };
    let mut edges = BTreeMap::new();
    for (i, &member) in members.iter().enumerate() {
        let t = triangle(member);
        for k in 0..3 {
            let (a, b) = (t[k], t[(k + 1) % 3]);
            let key = (a.min(b), a.max(b));
            if let Some(&other) = edges.get(&key) {
                components.join(i, other);
            } else {
                edges.insert(key, i);
            }
        }
    }
    if components.count == 1 {
        visit(members);
        return;
    }
    let mut groups: BTreeMap<usize, Vec<usize>> = BTreeMap::new();
    for (i, &member) in members.iter().enumerate() {
        groups.entry(components.root(i)).or_default().push(member);
    }
    let mut groups: Vec<_> = groups.into_values().collect();
    groups.sort_by_key(|g| g[0]);
    // The established fit needs at least two facets. Splitting an admitted
    // cluster into singletons would silently drop its projection/snap writes,
    // including their contribution at vertices shared with other planes.
    // Keep the complete original fit when any proposed patch lacks support.
    if groups.iter().any(|group| group.len() < 2) || !allow_split(&groups) {
        visit(members);
        return;
    }
    for group in groups {
        visit(&group);
    }
}
