// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Tests for `content_hash.rs`, split out under the house pattern (AGENTS.md)
//! so the production module stays under the module-size ratchet; this file
//! is exempt via the `_tests.rs` suffix convention.

use super::*;
use ifc_lite_core::EntityDecoder;

/// Control: an ordinary express id is parsed unchanged (issue #3421).
#[test]
fn parse_first_ref_reads_an_ordinary_ref() {
    assert_eq!(parse_first_ref(b"#5=IFCFACETEDBREP(#137924)"), Some(137924));
}

/// Boundary: a ref at exactly `u32::MAX` is not refused (issue #3421).
#[test]
fn parse_first_ref_accepts_a_ref_at_exactly_u32_max() {
    assert_eq!(
        parse_first_ref(b"#5=IFCFACETEDBREP(#4294967295)"),
        Some(u32::MAX)
    );
}

/// RED for issue #3421: `parse_first_ref` used to accumulate with
/// `wrapping_mul`/`wrapping_add`, so `#4294967297` wrapped onto id 1. It must
/// now refuse (`None`) instead of binding to whatever entity happens to hold
/// id 1.
#[test]
fn parse_first_ref_refuses_a_ref_above_u32_max_instead_of_wrapping_onto_a_real_entity() {
    assert_eq!(parse_first_ref(b"#5=IFCFACETEDBREP(#4294967297)"), None);
}

/// RED for issue #3421, exercised through `item_signature` (which drives
/// `sig_entity`/`sig_walk_bytes`, the OTHER wrapping site in this file):
/// a child ref one past `u32::MAX` must be treated as unresolvable — the same
/// structural hash as a plain missing ref — NEVER as a wrapped alias of the
/// real, present entity `#1`. Proven by running it: the oversized-ref
/// signature matches the genuinely-missing-ref signature, and BOTH differ
/// from the signature of an item that really does reference `#1`.
#[test]
fn item_signature_refuses_an_oversized_child_ref_instead_of_aliasing_it_onto_a_real_entity() {
    // `#1` exists and is real; if the old wrapping accumulation ran,
    // `#4294967297` (= 2^32 + 1) would wrap onto exactly this id.
    let content = b"#1=IFCCARTESIANPOINT((0.,0.,0.));\n\
                     #2=IFCEXTRUDEDAREASOLID(#4294967297);\n\
                     #3=IFCEXTRUDEDAREASOLID(#999999999);\n\
                     #4=IFCEXTRUDEDAREASOLID(#1);\n";

    let mut decoder = EntityDecoder::new(content);
    let mut memo = FxHashMap::default();
    let oversized_ref_sig = item_signature(&mut decoder, 2, &mut memo);

    let mut decoder = EntityDecoder::new(content);
    let mut memo = FxHashMap::default();
    let missing_ref_sig = item_signature(&mut decoder, 3, &mut memo);

    let mut decoder = EntityDecoder::new(content);
    let mut memo = FxHashMap::default();
    let real_ref_sig = item_signature(&mut decoder, 4, &mut memo);

    assert_eq!(
        oversized_ref_sig, missing_ref_sig,
        "an oversized child ref must hash exactly like a genuinely missing ref"
    );
    assert_ne!(
        oversized_ref_sig, real_ref_sig,
        "an oversized child ref must NEVER hash like the real entity #1 it would wrap onto"
    );
}
