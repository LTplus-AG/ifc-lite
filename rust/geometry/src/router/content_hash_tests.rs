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
    let mut refused = 0usize;
    let oversized_ref_sig = item_signature(&mut decoder, 2, &mut memo, &mut refused);

    let mut decoder = EntityDecoder::new(content);
    let mut memo = FxHashMap::default();
    let mut refused2 = 0usize;
    let missing_ref_sig = item_signature(&mut decoder, 3, &mut memo, &mut refused2);

    let mut decoder = EntityDecoder::new(content);
    let mut memo = FxHashMap::default();
    let mut refused3 = 0usize;
    let real_ref_sig = item_signature(&mut decoder, 4, &mut memo, &mut refused3);

    assert_eq!(
        oversized_ref_sig, missing_ref_sig,
        "an oversized child ref must hash exactly like a genuinely missing ref"
    );
    assert_ne!(
        oversized_ref_sig, real_ref_sig,
        "an oversized child ref must NEVER hash like the real entity #1 it would wrap onto"
    );
}

/// RED for issue #3752: refusing an oversized reference used to leave no
/// trace anywhere. `item_signature` must count it into its `refused` output
/// param so a caller (`GeometryRouter::take_content_hash_oversized_ref_drops`)
/// can report it — see [`super::sig_entity`]'s doc.
#[test]
fn item_signature_counts_an_oversized_child_ref_as_refused() {
    let content = b"#1=IFCCARTESIANPOINT((0.,0.,0.));\n\
                     #2=IFCEXTRUDEDAREASOLID(#4294967297);\n";
    let mut decoder = EntityDecoder::new(content);
    let mut memo = FxHashMap::default();
    let mut refused = 0usize;
    item_signature(&mut decoder, 2, &mut memo, &mut refused);
    assert_eq!(
        refused, 1,
        "an oversized child ref must be counted, not silently dropped (#3752)"
    );
}

/// Control: an ordinary child ref reports zero refusals.
#[test]
fn item_signature_reports_no_refusals_for_an_ordinary_ref() {
    let content = b"#1=IFCCARTESIANPOINT((0.,0.,0.));\n\
                     #2=IFCEXTRUDEDAREASOLID(#1);\n";
    let mut decoder = EntityDecoder::new(content);
    let mut memo = FxHashMap::default();
    let mut refused = 0usize;
    item_signature(&mut decoder, 2, &mut memo, &mut refused);
    assert_eq!(refused, 0, "an ordinary reference must not be counted as refused");
}

/// Boundary: a child ref at exactly `u32::MAX` parses and is not counted.
#[test]
fn item_signature_reports_no_refusals_for_a_ref_at_exactly_u32_max() {
    let content = b"#4294967295=IFCCARTESIANPOINT((0.,0.,0.));\n\
                     #2=IFCEXTRUDEDAREASOLID(#4294967295);\n";
    let mut decoder = EntityDecoder::new(content);
    let mut memo = FxHashMap::default();
    let mut refused = 0usize;
    item_signature(&mut decoder, 2, &mut memo, &mut refused);
    assert_eq!(refused, 0, "a ref at exactly u32::MAX must not be counted as refused");
}

/// RED for issue #3752, exercised through the real router entry point
/// (`GeometryRouter::geometry_routing_key`, not `item_signature` directly):
/// an oversized child ref hit while computing an element's routing key must
/// reach `GeometryRouter::take_content_hash_oversized_ref_drops`, and a
/// second drain must return zero — proving the counter is a real accumulator
/// that resets, not a value the accessor recomputes or discards.
#[test]
fn geometry_routing_key_feeds_take_content_hash_oversized_ref_drops() {
    use ifc_lite_core::{AttributeValue, DecodedEntity, IfcType};

    // #2's representation item has one child ref above `u32::MAX` (#3421).
    let content = b"#2=IFCEXTRUDEDAREASOLID(#4294967297);\n";
    let mut decoder = EntityDecoder::new(content);
    let element = DecodedEntity::new(
        1,
        IfcType::IfcWall,
        vec![
            AttributeValue::Null,
            AttributeValue::Null,
            AttributeValue::Null,
            AttributeValue::Null,
            AttributeValue::Null,
            AttributeValue::Null,
            AttributeValue::EntityRef(2), // index 6: representation
        ],
    );

    let router = crate::GeometryRouter::new();
    let key = router.geometry_routing_key(&element, &mut decoder);
    assert!(key.is_some(), "an element with a representation must still get a routing key");

    assert_eq!(
        router.take_content_hash_oversized_ref_drops(),
        1,
        "the oversized child ref hit while routing must be counted (#3752)"
    );
    assert_eq!(
        router.take_content_hash_oversized_ref_drops(),
        0,
        "a second drain must return zero — the counter resets, it isn't recomputed"
    );
}

// #3988: a face with two bounds followed by one with a single shorter loop
// must consume exactly those authored corners. Buffer reuse must not retain the
// previous face's hole or the previous loop's fourth point.
#[test]
fn issue_3988_brep_signature_reuses_scratch_without_stale_faces_or_points() {
    let source = "\
#1=IFCFACETEDBREP(#2);
#2=IFCCLOSEDSHELL((#3,#4));
#3=IFCFACE((#5,#6));
#4=IFCFACE((#7));
#5=IFCFACEOUTERBOUND(#10,.T.);
#6=IFCFACEBOUND(#11,.F.);
#7=IFCFACEOUTERBOUND(#12,.T.);
#10=IFCPOLYLOOP((#20,#21,#22,#23));
#11=IFCPOLYLOOP((#20,#21,#22));
#12=IFCPOLYLOOP((#21,#22,#23));
#20=IFCCARTESIANPOINT((0.,0.,0.));
#21=IFCCARTESIANPOINT((1.,0.,0.));
#22=IFCCARTESIANPOINT((0.,1.,0.));
#23=IFCCARTESIANPOINT((0.,0.,1.));
";
    let mut decoder = EntityDecoder::new(source);
    let signature = try_faceted_brep_signature(&mut decoder, 1).expect("complete BREP");
    assert_eq!(decoder.point_cache_stats(), (6, 4), "ten authored corners, four unique points");
    // STEP ids are identities, not geometry: an otherwise identical source
    // with all references renumbered must retain the content signature.
    let mut renumbered = source.to_string();
    for id in (1..=23).rev() {
        // Punctuation delimits STEP refs so #2 cannot accidentally replace #20.
        for suffix in [",", ")", "="] {
            renumbered = renumbered.replace(&format!("#{id}{suffix}"), &format!("#{}{suffix}", id + 100));
        }
    }
    let mut other = EntityDecoder::new(&renumbered);
    assert_eq!(try_faceted_brep_signature(&mut other, 101), Some(signature));
    let missing = source.replace("#12=IFCPOLYLOOP((#21,#22,#23))", "#12=IFCPOLYLOOP((#21,#22,#99))");
    let mut missing_decoder = EntityDecoder::new(&missing);
    assert_eq!(try_faceted_brep_signature(&mut missing_decoder, 1), None);
}
