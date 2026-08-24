// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Tests for the parts of `batch.rs` decidable without a file or a JS runtime.
//!
//! `produce_batch` itself needs a decoder, a geometry router and `Date::now`,
//! so the coverage here is the element record it emits: the diff-engine
//! fingerprint, whose whole point is that the two push sites (flat and
//! partitioned) build it in ONE place and so cannot fill different subsets of
//! the index-parallel arrays.

use super::ElementMeshOutput;

fn output(
    geometry_hash: Option<u64>,
    geometry_aabb: Option<[f64; 6]>,
    geometry_volume: Option<f64>,
    geometry_closure_bits: u8,
) -> ElementMeshOutput {
    ElementMeshOutput {
        id: 4242,
        meshes: Vec::new(),
        geometry_hash,
        geometry_aabb,
        geometry_volume,
        geometry_closure_bits,
    }
}

/// The hash is the record's reason to exist: without one there is nothing for
/// the diff engine to compare, so no record must be emitted at all. An AABB
/// and a volume present alongside a missing hash is the case that separates
/// "gated on the hash" from "gated on anything being measured".
#[test]
fn no_hash_means_no_fingerprint_even_when_the_other_fields_are_present() {
    let out = output(None, Some([1.0; 6]), Some(2.0), 3);
    assert!(
        out.fingerprint().is_none(),
        "a fingerprint without a hash would push an id into the parallel \
         arrays with nothing to compare it against"
    );
}

/// Every field reaches its own slot. The fixture gives each one a value that
/// belongs to no other field and an AABB whose six components are all
/// different, so a transposed min/max or a volume read from the closure bits
/// lands somewhere visible.
#[test]
fn a_hashed_element_carries_every_measured_field_through() {
    let aabb = [-1.5, -2.5, -3.5, 4.5, 5.5, 6.5];
    let out = output(Some(0xDEAD_BEEF_0000_0001), Some(aabb), Some(7.25), 5);
    let fp = out.fingerprint().expect("hashed elements get a record");

    assert_eq!(fp.express_id, 4242, "the record is keyed by the element id");
    assert_eq!(fp.hash, 0xDEAD_BEEF_0000_0001);
    assert_eq!(fp.aabb, Some(aabb));
    assert_eq!(fp.volume, Some(7.25));
    assert_eq!(fp.closure_bits, 5);
}

/// A volume is `Some` only for a provably closed single solid, so `None` is
/// the normal case and must NOT suppress the record or collapse to `0.0` — a
/// zero volume is a real measurement and would read as a degenerate solid.
#[test]
fn an_unmeasured_volume_stays_absent_rather_than_becoming_zero() {
    let fp = output(Some(9), Some([0.0; 6]), None, 0)
        .fingerprint()
        .expect("a hash is present, so the record is emitted");
    assert_eq!(fp.volume, None, "absent is not 0.0 m³");
    assert_eq!(fp.closure_bits, 0, "nothing hashed closed ⇒ no closure bits");
}
