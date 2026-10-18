// SPDX-License-Identifier: MPL-2.0
use super::*;

const REL: &str = "#30=IFCRELDEFINESBYPROPERTIES('2hK1S0rB9DZuP7Qn4c6uVb',#5,$,$,(#21,#22),#29);";

#[test]
fn related_entities_reads_the_related_objects_list_only() {
    // The owner history is NOT a related object. The pattern used to start at
    // the record's own `(` and return it too, which kept an unshared set alive
    // as an orphan once copy-on-write asked who else a relation names (#5794).
    assert_eq!(related_entities(REL), vec![21, 22]);
    assert_eq!(related_property_set(REL), Some(29));
    // A parenthesis inside a string slot does not open the list either.
    let named = "#30=IFCRELDEFINESBYPROPERTIES('g',#5,'Walls (east)',$,(#21),#29);";
    assert_eq!(related_entities(named), vec![21]);
}

#[test]
fn set_names_are_raw_text() {
    assert_eq!(property_set_name("#1=IFCPROPERTYSET('g',#5,'Pset_A',$,(#2));").as_deref(), Some("Pset_A"));
    // The raw text of the whole literal: an escaped quote no longer cuts it
    // short (it read `It`, a different set's name, before #7589).
    assert_eq!(property_set_name("#1=IFCPROPERTYSET('g',#5,'It''s',$,(#2));").as_deref(), Some("It''s"));
    assert_eq!(property_set_name("#1=IFCPROPERTYSET('g',#5,$,$,(#2));"), None);
    assert_eq!(element_quantity_name("#1=IFCELEMENTQUANTITY('g',#5,'Q',$,$,(#2));").as_deref(), Some("Q"));
}

#[test]
fn member_ids_come_from_the_closing_list() {
    assert_eq!(property_ids_in_set("#1=IFCPROPERTYSET('g',#5,'P',$,(#2, #3 ,#4));"), vec![2, 3, 4]);
    assert_eq!(property_ids_in_set("#1=IFCPROPERTYSET('g',#5,'P',$,$);"), Vec::<u32>::new());
}

#[test]
fn owner_history_is_slot_one_of_a_rooted_record() {
    assert_eq!(owner_history_ref("#21=IFCWALL('3nZ2''y9',#5,'Wall A');"), Some(5));
    assert_eq!(owner_history_ref("#18=IFCDOOR('1hA2',$,'Door');"), None);
}

#[test]
fn authored_refs_accept_exactly_one_canonical_reference() {
    assert_eq!(authored_entity_refs(" #12 "), vec![12]);
    assert!(authored_entity_refs("#012").is_empty());
    assert!(authored_entity_refs("(#1,#2)").is_empty());
}

/// #7589: the set name is read to the literal's real end, not cut at the
/// `\S\'` operand, and the owner history after such a literal is found.
#[test]
fn readers_keep_a_page_operand_inside_its_string_7589() {
    assert_eq!(property_set_name(r"#5=IFCPROPERTYSET('g',#2,'Para \S\' 5',$,(#7));").as_deref(), Some(r"Para \S\' 5"));
    assert_eq!(element_quantity_name(r"#5=IFCELEMENTQUANTITY('g',#2,'Art \S\' 7',$,$,(#7));").as_deref(), Some(r"Art \S\' 7"));
    assert_eq!(owner_history_ref(r"#1=IFCWALL('Para \S\' 5',#42,$);"), Some(42));
}

/// F4 M-export-a (CORE-1): JavaScript's `\s` includes the vertical tab, which
/// `u8::is_ascii_whitespace` left out, so a VT before the list or the
/// reference ended a match the TypeScript regex continued.
#[test]
fn readers_treat_a_vertical_tab_as_whitespace_like_js() {
    let rel = "#30=IFCRELDEFINESBYPROPERTIES('g',#5,$,$,(#21,#22)\u{b},\u{b}#29\u{b});";
    assert_eq!(related_entities(rel), vec![21, 22]);
    assert_eq!(related_property_set(rel), Some(29));
    assert_eq!(owner_history_ref("#21=IFCWALL(\u{b}'g'\u{b},\u{b}#5,$);"), Some(5));
    assert_eq!(property_set_name("#1=IFCPROPERTYSET\u{b}('g',#5,'P',$,(#2));").as_deref(), Some("P"));
}
