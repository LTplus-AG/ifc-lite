// SPDX-License-Identifier: MPL-2.0
//! Tests for `guid.rs`, split out under the house pattern (AGENTS.md).
//!
//! Moved out so the production module stays under the module-size ratchet
//! (`rust/processing/tests/module_size_ratchet.rs`); this file is exempt via
//! the `_tests.rs` suffix convention.

use super::*;

// Golden values captured from the JS `deterministicGlobalId` (parity anchor).
#[test]
fn deterministic_global_id_matches_js_golden_values() {
    assert_eq!(deterministic_global_id(""), "1IjrY9muLCZQE2I7v1L6Fe");
    assert_eq!(deterministic_global_id("abc"), "3CyRD_hmcIGwa2CMg6S2j2");
    assert_eq!(
        deterministic_global_id("2O2Fr$t4X7Zf8NOew3FLOH#model-b"),
        "3rFme4j$_k02NB735Nchfc"
    );
    assert_eq!(
        deterministic_global_id("2O2Fr$t4X7Zf8NOew3FLOH#model-b#0"),
        "10JRGA7NqHOtqjXClEkHK8"
    );
}

#[test]
fn minted_ids_are_valid_and_first_char_in_range() {
    // 128 = 2 + 21*6: the first char encodes only 2 bits, so it is '0'..'3'.
    for seed in ["", "a", "wall-guid#m1", "long seed with spaces"] {
        let g = deterministic_global_id(seed);
        assert!(is_global_id(&g), "{g:?} is a valid GlobalId");
        assert!(matches!(g.as_bytes()[0], b'0'..=b'3'), "first char '0'-'3'");
    }
}

#[test]
fn is_global_id_rejects_wrong_length_and_charset() {
    assert!(is_global_id("2O2Fr$t4X7Zf8NOew3FLOH"));
    assert!(!is_global_id("tooshort"));
    assert!(!is_global_id("has a space in it here!")); // 22 chars but space
    assert!(!is_global_id("2O2Fr$t4X7Zf8NOew3FLOHx")); // 23 chars
}

#[test]
fn extract_and_replace_round_trip_the_guid_slot() {
    let line = b"#5=IFCWALL('2O2Fr$t4X7Zf8NOew3FLOH',#6,'Wall',$,$,#7,#8,'tag');";
    let g = extract_global_id_fast("IFCWALL", line).expect("guid");
    assert_eq!(g, "2O2Fr$t4X7Zf8NOew3FLOH");
    let text = std::str::from_utf8(line).unwrap();
    let replaced = replace_global_id(text, "10JRGA7NqHOtqjXClEkHK8");
    assert!(replaced.contains("'10JRGA7NqHOtqjXClEkHK8',#6,'Wall'"));
    assert_eq!(read_leading_guid(&replaced).as_deref(), Some("10JRGA7NqHOtqjXClEkHK8"));
}

#[test]
fn non_rooted_string_type_is_not_read_as_a_guid() {
    // A property whose Name is 22 charset chars must not be mistaken for a root.
    let line = b"#9=IFCPROPERTYSINGLEVALUE('AAAAAAAAAAAAAAAAAAAAAA',$,IFCLABEL('x'),$);";
    assert_eq!(extract_global_id_fast("IFCPROPERTYSINGLEVALUE", line), None);
}

#[test]
fn non_rooted_colour_and_material_types_are_not_guids() {
    // IfcColourRgb leads with an optional Name that can be 22 charset chars;
    // it must not be classified as a rooted GlobalId (CR regression #2952).
    let colour = b"#12=IFCCOLOURRGB('AAAAAAAAAAAAAAAAAAAAAA',0.5,0.5,0.5);";
    assert_eq!(extract_global_id_fast("IFCCOLOURRGB", colour), None);
    assert_eq!(leading_rooted_global_id(colour), None);
    // A real rooted entity with the same-shaped leading string IS read.
    let wall = b"#5=IFCWALL('2O2Fr$t4X7Zf8NOew3FLOH',#6,'Wall',$,$,#7,#8,'tag');";
    assert_eq!(leading_rooted_global_id(wall).as_deref(), Some("2O2Fr$t4X7Zf8NOew3FLOH"));
    // IfcMaterialLayer leads with a #ref, so it never even reaches the shape test.
    let layer = b"#8=IFCMATERIALLAYER(#7,200.,$);";
    assert_eq!(leading_rooted_global_id(layer), None);
}

#[test]
fn schema_check_rejects_non_rooted_name_carrying_types() {
    // Every one of these is a non-rooted resource whose FIRST attribute is a
    // Name/Identifier string that can be 22 charset chars. A shape-only check
    // would misread it as a GlobalId; the schema (IfcRoot-subtype) check must
    // not (CR regression #2952). `IfcRegularTimeSeries` is the headline case:
    // its first inherited attribute is `Name`, while `IfcRoot` leads with
    // `GlobalId`.
    let cases: [(&str, &[u8]); 4] = [
        ("IFCREGULARTIMESERIES", b"#1=IFCREGULARTIMESERIES('AAAAAAAAAAAAAAAAAAAAAA',$,$,$,$,$,$,(#2));"),
        ("IFCPROPERTYSINGLEVALUE", b"#2=IFCPROPERTYSINGLEVALUE('AAAAAAAAAAAAAAAAAAAAAA',$,IFCLABEL('x'),$);"),
        ("IFCCOLOURSPECIFICATION", b"#3=IFCCOLOURSPECIFICATION('AAAAAAAAAAAAAAAAAAAAAA');"),
        ("IFCMATERIAL", b"#4=IFCMATERIAL('AAAAAAAAAAAAAAAAAAAAAA',$,$);"),
    ];
    for (ty, line) in cases {
        assert!(!is_rooted_entity_type(ty), "{ty} is not rooted");
        assert_eq!(extract_global_id_fast(ty, line), None, "{ty} not read as a GlobalId");
        assert_eq!(leading_rooted_global_id(line), None, "{ty} not read as a GlobalId");
    }
    // Positive control: rooted entities ARE classified as such.
    assert!(is_rooted_entity_type("IFCWALL"));
    assert!(is_rooted_entity_type("IFCPROPERTYSET"), "IfcPropertySet is rooted");
    assert!(is_rooted_entity_type("IFCRELAGGREGATES"), "objectified relationships are rooted");
}

#[test]
fn legacy_ifc2x3_rooted_types_dropped_from_schema_are_still_rooted() {
    // Deprecated IFC2X3 rooted entities that no longer exist in the generated
    // IFC4X3 schema resolve to IfcType::Unknown, which is not an IfcRoot
    // subtype — so the schema check alone would misclassify them as non-rooted
    // and let a shared GlobalId duplicate across models (#2952). The legacy
    // fallback must still classify them as rooted.
    for ty in [
        "IFCELECTRICALCIRCUIT",
        "IFCCONDITION",
        "IFCRELASSIGNSTASKS",
        "IFCSERVICELIFE",
        "IFCTIMESERIESSCHEDULE",
        "IFCMOVE",
    ] {
        assert!(is_rooted_entity_type(ty), "{ty} is a legacy IFC2X3 rooted type");
        // And its leading 22-char GlobalId is read through the full pipeline.
        let line = format!("#1={ty}('2O2Fr$t4X7Zf8NOew3FLOH',$,$,$);");
        assert_eq!(
            leading_rooted_global_id(line.as_bytes()).as_deref(),
            Some("2O2Fr$t4X7Zf8NOew3FLOH"),
            "{ty} GlobalId read"
        );
    }
    // A genuinely unknown, non-rooted vendor type stays non-rooted.
    assert!(!is_rooted_entity_type("IFCFOOBARNOTATHING"));
}

#[test]
fn entity_type_upper_tolerates_spacing_and_case() {
    assert_eq!(entity_type_upper(b"#1=IFCWALL('g',$);").as_deref(), Some("IFCWALL"));
    assert_eq!(entity_type_upper(b"#1= IfcProject('g',$);").as_deref(), Some("IFCPROJECT"));
    assert_eq!(entity_type_upper(b"not an entity"), None);
}

#[test]
fn mint_avoids_collisions_with_emitted_pending_and_local() {
    let mut emitted = HashSet::new();
    let empty = HashSet::new();
    let mut minter = GuidMinter::new();
    let first = minter.mint("dup", "m1", &emitted, &empty);
    emitted.insert(first.clone());
    // Same original+model, but the first candidate now collides → different id.
    let second = minter.mint("dup", "m1", &emitted, &empty);
    assert_ne!(first, second);
    assert!(is_global_id(&second));
    // A candidate already emitted by THIS model (passed via `also`) is avoided
    // even though it is absent from `emitted`. Seed `also` with the *exact*
    // deterministic id that minting "y#m2" would otherwise return, so the mint
    // is forced off its first candidate specifically by the `also` guard.
    let mut also = HashSet::new();
    also.insert(deterministic_global_id("y#m2"));
    let third = minter.mint("y", "m2", &empty, &also);
    assert!(!also.contains(&third));
}
