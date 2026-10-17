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
    assert!(is_global_id_shaped(&placeholder(7)));
}

#[test]
fn shaped_and_valid_disagree_exactly_on_the_first_character() {
    let high = "zzzzzzzzzzzzzzzzzzzzzz";
    assert!(is_global_id_shaped(high));
    assert!(!is_valid_global_id(high));
    assert!(is_valid_global_id("3CyRD_hmcIGwa2CMg6S2j2"));
    assert!(!is_global_id_shaped("tooshort"));
    assert!(!is_global_id_shaped("has a space in it here!"));
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

#[test]
fn rendered_reader_and_replacer_recognise_non_conforming_ids() {
    // First char outside 0..=3: shaped, so the merge must still see it.
    let line = "#5=IFCWALL('zzzzzzzzzzzzzzzzzzzzzz',#6,'Wall',$);";
    assert_eq!(read_leading_global_id(line), Some("zzzzzzzzzzzzzzzzzzzzzz"));
    assert_eq!(
        replace_rendered_global_id(line, "10JRGA7NqHOtqjXClEkHK8"),
        "#5=IFCWALL('10JRGA7NqHOtqjXClEkHK8',#6,'Wall',$);"
    );
    assert_eq!(read_leading_global_id("#5=IFCWALL($);"), None);
    assert_eq!(read_leading_global_id("#5=IFCWALL('short',$);"), None);
}
