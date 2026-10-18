// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
// PREPARED ONLY, NOT COMPILED OR RUN. Intended integration-test location:
// rust/core/tests/issue_7779_leaf_cache_authority.rs

use ifc_lite_core::{EntityDecoder, EntityIndex, Error};
use rustc_hash::FxHashMap;
use std::sync::Arc;

fn decoder(content: &str, strict: bool) -> EntityDecoder<'_> {
    let d = EntityDecoder::new(content);
    if strict { d.with_strict_reals() } else { d }
}

fn read(d: &mut EntityDecoder<'_>, direction: bool, id: u32) -> ifc_lite_core::Result<[f64; 3]> {
    if direction { d.direction3(id) } else { d.point3(id) }
}

// The injected entity is parsed from actual independent STEP bytes, including
// malformed leaf shapes that the generic entity decoder can materialize.
fn inject_parsed(d: &mut EntityDecoder<'_>, record: &str, parsed_id: u32, key: u32) {
    let mut donor = EntityDecoder::new(record);
    let entity = donor.decode_by_id(parsed_id).unwrap();
    let shared = FxHashMap::from_iter([(key, Arc::new(entity))]);
    d.inject_shared_cache(&shared);
}

#[test]
fn issue_7779_leaf_values_match_analytic_bits_with_warm_cache_and_clear_controls() {
    for direction in [false, true] {
        let kind = if direction { "IFCDIRECTION" } else { "IFCCARTESIANPOINT" };
        for (list, expected) in [
            ("(1.,2.,3.)", [1.0, 2.0, 3.0]),
            ("(1.5,-2.)", [1.5, -2.0, 0.0]),
            ("(-0.,0.,-0.)", [-0.0, 0.0, -0.0]),
            ("(.5,1E5,+1)", [0.5, 1e5, 1.0]),
        ] {
            let content = format!("#1={kind}({list});");
            for strict in [false, true] {
                for warm in [false, true] {
                    let mut d = decoder(&content, strict);
                    if warm {
                        d.decode_by_id(1).unwrap();
                        assert!(d.get_cached(1).is_some(), "positive warm-cache control");
                    }
                    for clear in 0..3 {
                        if clear == 1 { d.clear_entity_cache(); }
                        if clear == 2 { d.clear_cache(); }
                        let got = read(&mut d, direction, 1).unwrap();
                        assert_eq!(got.map(f64::to_bits), expected.map(f64::to_bits),
                            "direction={direction} strict={strict} warm={warm} clear={clear}");
                        assert_eq!(d.refused_records(), 0);
                    }
                }
            }
        }
    }
}

#[test]
fn issue_7779_leaf_refusals_preserve_shape_type_real_policy_and_dedup_after_clear() {
    for direction in [false, true] {
        let kind = if direction { "IFCDIRECTION" } else { "IFCCARTESIANPOINT" };
        let wrong = if direction { "IFCCARTESIANPOINT" } else { "IFCDIRECTION" };
        for record in [
            format!("#1={kind}((1.,2.,3.,4.));"),
            format!("#1={kind}((1.));"),
            format!("#1={kind}((1.,$,3.));"),
            format!("#1={kind}((1.,'bad',3.));"),
            format!("#1={kind}((1.,IFCLENGTHMEASURE(2.),3.));"),
            format!("#1={kind}((1.,2.,3.),4.);"),
            format!("#1={wrong}((1.,2.,3.));"),
        ] {
            for strict in [false, true] {
                for warm in [false, true] {
                    let mut d = decoder(&record, strict);
                    if warm { d.decode_by_id(1).unwrap(); }
                    for clear in 0..4 {
                        if clear == 2 { d.clear_entity_cache(); }
                        if clear == 3 { d.clear_cache(); }
                        assert!(matches!(read(&mut d, direction, 1), Err(Error::MalformedRecord(1))),
                            "{record} strict={strict} warm={warm} clear={clear}");
                        assert_eq!(d.refused_record_ids(), vec![1], "distinct-record counter survives clears");
                    }
                }
            }
        }
        let content = format!("#1={kind}((1.E400,0.,0.));");
        for strict in [false, true] {
            let mut d = decoder(&content, strict);
            // A lossless decode materializes infinity but deliberately does not
            // cache it; switching back must retain strict REAL refusal.
            d.decode_by_id_lossless(1).unwrap();
            assert!(d.get_cached(1).is_none());
            for clear in 0..3 {
                if clear == 1 { d.clear_entity_cache(); }
                if clear == 2 { d.clear_cache(); }
                let result = read(&mut d, direction, 1);
                if strict { assert!(matches!(result, Err(Error::UnrepresentableReal(1)))); }
                else { assert!(matches!(result, Err(Error::MalformedRecord(1)))); }
                assert_eq!(d.refused_record_ids(), vec![1]);
            }
        }
    }
}

#[test]
fn issue_7779_valid_raw_leaf_wins_contradictory_injected_values_type_shape_and_id() {
    let donors = [
        ("#1=IFCCARTESIANPOINT((90.,80.,70.));", 1),
        ("#1=IFCDIRECTION((90.,80.,70.));", 1),
        ("#1=IFCCARTESIANPOINT((90.,80.,70.,60.));", 1),
        ("#1=IFCCARTESIANPOINT((90.,IFCLENGTHMEASURE(80.),70.));", 1),
        ("#1=IFCCARTESIANPOINT((1.E400,0.,0.));", 1),
        ("#2=IFCCARTESIANPOINT((90.,80.,70.));", 2),
    ];
    for direction in [false, true] {
        let kind = if direction { "IFCDIRECTION" } else { "IFCCARTESIANPOINT" };
        let raw = format!("#1={kind}((1.,2.));");
        for strict in [false, true] {
            for (record, parsed_id) in donors {
                let mut d = decoder(&raw, strict);
                inject_parsed(&mut d, record, parsed_id, 1);
                for clear in 0..3 {
                    if clear == 1 { d.clear_entity_cache(); }
                    if clear == 2 { d.clear_cache(); }
                    assert_eq!(read(&mut d, direction, 1).unwrap(), [1.0, 2.0, 0.0],
                        "raw readable leaf must win {record}, strict={strict}");
                    assert_eq!(d.refused_records(), 0);
                }
            }
        }
    }
}

#[test]
fn issue_7779_leaf_fallback_keeps_injected_overlay_authority_until_cleared() {
    for (raw, strict, unrepresentable) in [
        ("#1=IFCCARTESIANPOINT((1.,IFCLENGTHMEASURE(2.),3.));", false, false),
        ("#1=IFCCARTESIANPOINT((1.E400,0.,0.));", true, true),
    ] {
        let mut d = decoder(raw, strict);
        inject_parsed(&mut d, "#1=IFCCARTESIANPOINT((10.,20.,30.));", 1, 1);
        // Existing raw grammar misses, then decode_by_id returns the overlay.
        // Do not silently replace this existing fallback with raw-only policy.
        assert_eq!(d.point3(1).unwrap(), [10.0, 20.0, 30.0]);
        assert_eq!(d.refused_records(), 0);
        d.clear_entity_cache();
        let result = d.point3(1);
        if unrepresentable { assert!(matches!(result, Err(Error::UnrepresentableReal(1)))); }
        else { assert!(matches!(result, Err(Error::MalformedRecord(1)))); }
        assert_eq!(d.refused_record_ids(), vec![1]);
    }
}

#[test]
fn issue_7779_missing_raw_id_uses_injected_leaf_but_dangling_id_remains_uncounted() {
    let raw = "#1=IFCCARTESIANPOINT((1.,2.,3.));";
    let mut d = EntityDecoder::new(raw);
    inject_parsed(&mut d, "#99=IFCCARTESIANPOINT((10.,20.));", 99, 99);
    assert_eq!(d.point3(99).unwrap(), [10.0, 20.0, 0.0]);
    d.clear_cache();
    let result = d.point3(99);
    assert!(result.is_err());
    assert!(!matches!(result, Err(Error::MalformedRecord(_) | Error::UnrepresentableReal(_))));
    assert_eq!(d.refused_records(), 0);
}

#[test]
fn issue_7779_decoded_source_span_is_not_proof_of_indexed_leaf_authority() {
    let first = "#1=IFCCARTESIANPOINT((90.,80.,70.));\n";
    let second = "#1=IFCCARTESIANPOINT((1.,2.,3.));";
    let content = format!("{first}{second}");
    let mut index = EntityIndex::default();
    index.insert(1, (first.len(), content.len()));
    let mut d = EntityDecoder::with_index(&content, index);
    // Both records are really parsed bytes with the same id. A caller may
    // decode a span independently of the installed lookup's selected span.
    d.decode_at_with_id(1, 0, first.len()).unwrap();
    assert_eq!(d.point3(1).unwrap(), [1.0, 2.0, 3.0]);
    // Replacing an index does not clear the entity cache. Preserve current
    // get_raw_bytes selection without inventing provenance for cached values.
    let mut other = EntityIndex::default();
    other.insert(1, (0, first.len()));
    d.set_entity_index(Arc::new(other));
    assert_eq!(d.point3(1).unwrap(), [90.0, 80.0, 70.0]);
    d.clear_cache();
    assert_eq!(d.point3(1).unwrap(), [90.0, 80.0, 70.0]);
}
