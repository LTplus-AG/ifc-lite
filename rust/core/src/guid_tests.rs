// SPDX-License-Identifier: MPL-2.0
use super::*;

#[test]
fn deterministic_matches_the_typescript_golden_values() {
    // Same vectors as rust/export/src/merged/guid_tests.rs and
    // packages/parser/src/deterministic-global-id.ts.
    assert_eq!(deterministic(""), "1IjrY9muLCZQE2I7v1L6Fe");
    assert_eq!(deterministic("abc"), "3CyRD_hmcIGwa2CMg6S2j2");
}

#[test]
fn placeholder_is_pinned() {
    assert_eq!(placeholder(0), "00000000000000000G0000");
    assert_eq!(placeholder(42), "00000000000000000G000g");
    assert!(is_valid_global_id(&placeholder(7)));
}

#[test]
fn one_validity_rule_rejects_a_first_char_outside_0_to_3() {
    // #7777: 22 chars hold 2 + 21*6 bits, so the first char is '0'..='3'.
    assert!(is_global_id_shaped("zzzzzzzzzzzzzzzzzzzzzz"));
    for bad in ["zzzzzzzzzzzzzzzzzzzzzz", "4CyRD_hmcIGwa2CMg6S2j2", "_CyRD_hmcIGwa2CMg6S2j2"] {
        assert!(!is_valid_global_id(bad), "{bad}");
        // The leading-scan and the replacer apply the same rule.
        let line = format!("#1=IFCWALL('{bad}',$);");
        assert_eq!(leading_global_id(line.as_bytes()), None, "{bad}");
        assert_eq!(replace_leading_global_id(&line, "0AAAAAAAAAAAAAAAAAAAAA"), line, "{bad}");
    }
    for ok in ["0CyRD_hmcIGwa2CMg6S2j2", "3CyRD_hmcIGwa2CMg6S2j2"] {
        assert!(is_valid_global_id(ok), "{ok}");
    }
    assert!(!is_valid_global_id("tooshort"));
    assert!(!is_valid_global_id("has a space in it here!"));
    assert!(!is_valid_global_id("3CyRD_hmcIGwa2CMg6S2j2x"));
}

#[test]
fn replace_leading_swaps_only_the_guid_slot() {
    let line = "#5=IFCWALL( '2O2Fr$t4X7Zf8NOew3FLOH',#6,'Wall',$);";
    assert_eq!(
        replace_leading_global_id(line, "10JRGA7NqHOtqjXClEkHK8"),
        "#5=IFCWALL( '10JRGA7NqHOtqjXClEkHK8',#6,'Wall',$);"
    );
    assert_eq!(replace_leading_global_id("#5=IFCWALL($);", "10JRGA7NqHOtqjXClEkHK8"), "#5=IFCWALL($);");
}

#[test]
fn leading_reads_the_first_string_inside_the_window_only() {
    let line = b"#1=IFCWALL( '3CyRD_hmcIGwa2CMg6S2j2',$);";
    assert_eq!(leading_global_id(line), Some("3CyRD_hmcIGwa2CMg6S2j2"));
    assert_eq!(leading_global_id(b"#1=IFCWALL($);"), None);
    let mut far = b"#1=IFCWALL(".to_vec();
    far.extend(std::iter::repeat_n(b' ', 200));
    far.extend_from_slice(b"'3CyRD_hmcIGwa2CMg6S2j2');");
    assert_eq!(leading_global_id(&far), None);
}
