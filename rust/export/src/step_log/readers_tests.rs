// SPDX-License-Identifier: MPL-2.0
use super::*;

const REL: &str = "#30=IFCRELDEFINESBYPROPERTIES('2hK1S0rB9DZuP7Qn4c6uVb',#5,$,$,(#21,#22),#29);";

#[test]
fn related_entities_reads_what_the_typescript_pattern_matches() {
    // The pattern starts at the record's first `(`, so the owner history is
    // among the "related" ids. Ported as matched, not as meant.
    assert_eq!(related_entities(REL), vec![5, 21, 22]);
    assert_eq!(related_property_set(REL), Some(29));
}

#[test]
fn set_names_are_raw_text() {
    assert_eq!(property_set_name("#1=IFCPROPERTYSET('g',#5,'Pset_A',$,(#2));").as_deref(), Some("Pset_A"));
    // An escaped quote ends the raw name early, as `[^']*` does.
    assert_eq!(property_set_name("#1=IFCPROPERTYSET('g',#5,'It''s',$,(#2));").as_deref(), Some("It"));
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
