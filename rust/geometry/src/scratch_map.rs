// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Reset a pooled per-worker hash map in time proportional to the pass about to
//! use it, not to the largest pass it ever served.
//!
//! The mesh orienter and the vertex weld keep their maps in a thread-local
//! scratch and `clear()` them before every mesh. A non-empty `HashMap::clear`
//! rewrites the control byte of every bucket, so after one large mesh each
//! later mesh paid for the large table again: on a model of ~100k meshes this
//! zeroing was about 5% of all pipeline instructions, for meshes averaging a
//! few hundred keys. [`reset_for`] keeps the pooled table only while it is
//! within [`SLACK`] times what the next pass needs, and otherwise replaces it
//! with one sized for that pass.
//!
//! Output cannot change: these maps are only ever probed and inserted into,
//! never iterated, so their bucket count is unobservable (the same argument
//! that made pooling them byte-identical, #3988). It also bounds the memory a
//! worker retains after one outsized mesh.

use rustc_hash::FxHashMap;

/// How many times the needed capacity a pooled table may keep before it is
/// replaced. Hysteresis, so a worker alternating between similar sizes keeps
/// its table instead of reallocating on every pass.
pub(crate) const SLACK: usize = 4;

/// Smallest key count the policy compares against, so tiny passes keep a
/// small warm table rather than reallocating for every few-key mesh.
const FLOOR: usize = 64;

/// Empty `map` and make room for `keys` insertions, in O(`keys`) time.
#[inline]
pub(crate) fn reset_for<K: std::hash::Hash + Eq, V>(map: &mut FxHashMap<K, V>, keys: usize) {
    if map.capacity() > SLACK * keys.max(FLOOR) {
        *map = FxHashMap::with_capacity_and_hasher(keys, Default::default());
    } else {
        map.clear();
        map.reserve(keys);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_outsized_pooled_table_is_replaced_and_a_fitting_one_kept() {
        let mut map: FxHashMap<u32, u32> = FxHashMap::default();
        reset_for(&mut map, 100_000);
        map.extend((0..100_000).map(|k| (k, k)));
        let big = map.capacity();
        reset_for(&mut map, 10);
        assert!(map.is_empty());
        assert!(map.capacity() < big, "a small pass must not keep the large table");
        assert!(map.capacity() <= SLACK * FLOOR);
        map.extend((0..10).map(|k| (k, k)));
        let warm = map.capacity();
        reset_for(&mut map, 10);
        assert!(map.is_empty());
        assert_eq!(map.capacity(), warm, "a fitting table stays warm");
        reset_for(&mut map, 5_000);
        assert!(map.capacity() >= 5_000);
    }
}
