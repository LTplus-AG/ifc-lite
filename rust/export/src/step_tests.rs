// SPDX-License-Identifier: MPL-2.0
//! Tests for `step.rs`, split out under the house pattern (AGENTS.md).
//!
//! Moved out so the production module stays under the module-size ratchet
//! (`rust/processing/tests/module_size_ratchet.rs`); this file is exempt via
//! the `_tests.rs` suffix convention.

use super::*;
// Exercised directly here; `step.rs` reaches it through `step_cow`.
use crate::step_text::substitute_ref_in_attr;

/// Count `#id=` entity lines in a STEP DATA section + grab the FILE_SCHEMA label.
fn parse_back(step: &str) -> (usize, HashSet<u32>, String) {
    let bytes = step.as_bytes();
    let mut ids = HashSet::new();
    let mut scanner = EntityScanner::new(bytes);
    while let Some((id, _t, _s, _e)) = scanner.next_entity() {
        ids.insert(id);
    }
    let schema = detect_schema(bytes);
    (ids.len(), ids, schema)
}

#[test]
fn full_roundtrip_preserves_all_entities() {
    let src = fixture_or_skip!("ara3d/duplex.ifc");
    let (step, stats) = export_step_with_stats(&src, &StepOptions::default());

    // Source entity count == written count == re-parsed count.
    let (reparsed, _ids, schema) = parse_back(&step);
    assert_eq!(stats.written, stats.total, "wrote every entity");
    assert_eq!(reparsed, stats.total, "re-parse recovers every entity");
    assert!(step.starts_with("ISO-10303-21;"));
    assert!(step.trim_end().ends_with("END-ISO-10303-21;"));
    assert_eq!(schema, "IFC2X3", "preserved source schema label");
}

#[test]
fn subset_export_is_reference_closed() {
    let src = fixture_or_skip!("ara3d/duplex.ifc");
    // Pick a real wall id from the model.
    let mut scanner = EntityScanner::new(&src[..]);
    let mut wall_id = None;
    while let Some((id, t, _s, _e)) = scanner.next_entity() {
        if t.eq_ignore_ascii_case("IFCWALLSTANDARDCASE") || t.eq_ignore_ascii_case("IFCWALL") {
            wall_id = Some(id);
            break;
        }
    }
    let wall_id = wall_id.expect("a wall in duplex");

    let (step, stats) = export_step_with_stats(
        &src,
        &StepOptions {
            included: Some(vec![wall_id]),
            ..StepOptions::default()
        },
    );
    let (_n, ids, _schema) = parse_back(&step);

    assert!(ids.contains(&wall_id), "the requested wall is present");
    assert!(
        stats.written < stats.total,
        "subset is smaller than the whole model"
    );

    // Reference-closed: every #ref emitted must itself be present (no dangling refs).
    for line in step.lines().filter(|l| l.starts_with('#')) {
        let mut refs = Vec::new();
        refs_in_line(line.as_bytes(), &mut refs);
        for r in refs {
            assert!(ids.contains(&r), "dangling reference #{r} in subset export");
        }
    }
}

#[test]
fn attribute_mutation_renames_entity() {
    let src = fixture_or_skip!("ara3d/duplex.ifc");
    // Find a wall to rename (attribute index 2 = Name on IfcRoot products).
    let mut scanner = EntityScanner::new(&src[..]);
    let mut wall_id = None;
    while let Some((id, t, _s, _e)) = scanner.next_entity() {
        if t.eq_ignore_ascii_case("IFCWALLSTANDARDCASE") {
            wall_id = Some(id);
            break;
        }
    }
    let wall_id = wall_id.expect("a wall");

    let step = export_step(
        &src,
        &StepOptions {
            attribute_mutations: vec![AttrMutation {
                express_id: wall_id,
                index: 2,
                value: "'RENAMED_BY_TEST'".to_string(),
            }],
            ..StepOptions::default()
        },
    );
    // The mutated wall line carries the new name; the model still re-parses fully.
    let line = step
        .lines()
        .find(|l| l.starts_with(&format!("#{wall_id}=")))
        .expect("wall line present");
    assert!(line.contains("'RENAMED_BY_TEST'"), "name replaced: {line}");
    let (reparsed, _ids, _schema) = parse_back(&step);
    let mut sc = EntityScanner::new(&src[..]);
    let mut total = 0usize;
    while sc.next_entity().is_some() {
        total += 1;
    }
    assert_eq!(reparsed, total, "no entities dropped by the edit");
}

#[test]
fn property_synthesis_attaches_new_pset() {
    let src = fixture_or_skip!("ara3d/duplex.ifc");
    let mut scanner = EntityScanner::new(&src[..]);
    let mut wall = None;
    while let Some((id, t, _s, _e)) = scanner.next_entity() {
        if t.eq_ignore_ascii_case("IFCWALLSTANDARDCASE") {
            wall = Some(id);
            break;
        }
    }
    let wall = wall.expect("a wall");

    let (step, stats) = export_step_with_stats(
        &src,
        &StepOptions {
            property_mutations: vec![PropMutation {
                express_id: wall,
                pset_name: "Pset_Test".to_string(),
                prop_name: "MyProp".to_string(),
                value: "IFCLABEL('hello')".to_string(),
            }],
            ..StepOptions::default()
        },
    );

    // The three synthesized entities are present.
    assert!(
        step.contains("=IFCPROPERTYSINGLEVALUE('MyProp',$,IFCLABEL('hello'),$);"),
        "single value synthesized"
    );
    assert!(step.contains("'Pset_Test'"), "pset name present");
    // The synthesized rel ($-owner/name/desc) relates the wall to the new pset —
    // distinct from duplex's original rels which carry a real OwnerHistory ref.
    let synth_rel = format!(",$,$,$,(#{wall}),#");
    assert!(
        step.lines()
            .any(|l| l.contains("=IFCRELDEFINESBYPROPERTIES(") && l.contains(&synth_rel)),
        "synthesized rel targeting the wall not found"
    );

    // Re-parses, and the synthesized entities are counted (written = original + 3).
    let (reparsed, _ids, _schema) = parse_back(&step);
    assert_eq!(reparsed, stats.written, "every written entity re-parses");
    assert_eq!(
        stats.written,
        stats.total + 3,
        "added 1 prop + 1 pset + 1 rel"
    );
}

#[test]
fn schema_conversion_to_ifc4_keeps_model_parseable() {
    let src = fixture_or_skip!("ara3d/duplex.ifc");
    let (step, stats) = export_step_with_stats(
        &src,
        &StepOptions {
            schema: Some("IFC4".to_string()),
            ..StepOptions::default()
        },
    );
    assert!(step.contains("FILE_SCHEMA(('IFC4'))"));
    // Conversion preserves every express id (renames type, never drops entities).
    let (reparsed, _ids, schema) = parse_back(&step);
    assert_eq!(reparsed, stats.total, "no entities lost in conversion");
    assert_eq!(schema, "IFC4");
    // The converted file must still re-parse as a coherent entity set.
    assert!(step.lines().filter(|l| l.starts_with('#')).count() == stats.written);
}

#[test]
fn copy_on_write_moves_one_referrer_and_leaves_the_other() {
    let src = concat!(
        "ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION((''),'2;1');\n",
        "FILE_NAME('','',(''),(''),'','','');\nFILE_SCHEMA(('IFC4'));\nENDSEC;\nDATA;\n",
        "#41=IFCPROPERTYSINGLEVALUE('Reference',$,IFCLABEL('shared'),$);\n",
        "#42=IFCPROPERTYSINGLEVALUE('Other',$,IFCLABEL('x'),$);\n",
        "#9=IFCPROPERTYSET('s1',$,'P',$,(#41,#42));\n",
        "#10=IFCPROPERTYSET('s2',$,'P',$,(#41,#42));\n",
        "ENDSEC;\nEND-ISO-10303-21;\n"
    );
    let (out, stats) = export_step_with_stats(
        src.as_bytes(),
        &StepOptions {
            copy_on_write: vec![CopyOnWriteMutation {
                express_id: 41,
                index: 2,
                value: "IFCLABEL('edited')".to_string(),
                referrer_id: 9,
                referrer_index: 4,
            }],
            ..StepOptions::default()
        },
    );

    // The shared original is untouched, so #10 still reads 'shared'.
    assert!(out.contains("#41=IFCPROPERTYSINGLEVALUE('Reference',$,IFCLABEL('shared'),$);"));
    assert!(out.contains("#10=IFCPROPERTYSET('s2',$,'P',$,(#41,#42));"));
    // #9 points at the copy and keeps its other reference in place.
    assert!(out.contains("#43=IFCPROPERTYSINGLEVALUE('Reference',$,IFCLABEL('edited'),$);"));
    assert!(out.contains("#9=IFCPROPERTYSET('s1',$,'P',$,(#43,#42));"));
    // Counted by the writer, which is why this is emitted rather than
    // appended: the copy is one more record than the source held.
    assert_eq!(stats.written, stats.total + 1);
}

#[test]
fn copy_ids_and_synthesized_ids_do_not_collide() {
    let src = concat!(
        "ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION((''),'2;1');\n",
        "FILE_NAME('','',(''),(''),'','','');\nFILE_SCHEMA(('IFC4'));\nENDSEC;\nDATA;\n",
        "#1=IFCWALL('g',$,'W',$,$,$,$,$,$);\n",
        "#41=IFCPROPERTYSINGLEVALUE('Reference',$,IFCLABEL('shared'),$);\n",
        "#9=IFCPROPERTYSET('s1',$,'P',$,(#41));\n",
        "ENDSEC;\nEND-ISO-10303-21;\n"
    );
    let (out, _) = export_step_with_stats(
        src.as_bytes(),
        &StepOptions {
            copy_on_write: vec![CopyOnWriteMutation {
                express_id: 41,
                index: 2,
                value: "IFCLABEL('edited')".to_string(),
                referrer_id: 9,
                referrer_index: 4,
            }],
            property_mutations: vec![PropMutation {
                express_id: 1,
                pset_name: "New".to_string(),
                prop_name: "P".to_string(),
                value: "IFCLABEL('v')".to_string(),
            }],
            ..StepOptions::default()
        },
    );
    let mut ids: Vec<&str> = out
        .lines()
        .filter_map(|l| l.strip_prefix('#'))
        .filter_map(|l| l.split('=').next())
        .collect();
    let before = ids.len();
    ids.sort_unstable();
    ids.dedup();
    assert_eq!(ids.len(), before, "an id was handed out twice");
}

#[test]
fn two_copies_through_one_attribute_both_land() {
    let src = concat!(
        "ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION((''),'2;1');\n",
        "FILE_NAME('','',(''),(''),'','','');\nFILE_SCHEMA(('IFC4'));\nENDSEC;\nDATA;\n",
        "#41=IFCPROPERTYSINGLEVALUE('A',$,IFCLABEL('s1'),$);\n",
        "#42=IFCPROPERTYSINGLEVALUE('B',$,IFCLABEL('s2'),$);\n",
        "#9=IFCPROPERTYSET('g',$,'P',$,(#41,#42));\n",
        "#10=IFCPROPERTYSET('g2',$,'P',$,(#41,#42));\n",
        "ENDSEC;\nEND-ISO-10303-21;\n"
    );
    let (out, _) = export_step_with_stats(
        src.as_bytes(),
        &StepOptions {
            copy_on_write: vec![
                CopyOnWriteMutation {
                    express_id: 41,
                    index: 2,
                    value: "IFCLABEL('e1')".to_string(),
                    referrer_id: 9,
                    referrer_index: 4,
                },
                CopyOnWriteMutation {
                    express_id: 42,
                    index: 2,
                    value: "IFCLABEL('e2')".to_string(),
                    referrer_id: 9,
                    referrer_index: 4,
                },
            ],
            ..StepOptions::default()
        },
    );
    // Both moved, neither orphaned, and the sharer keeps the originals.
    assert!(
        out.contains("#9=IFCPROPERTYSET('g',$,'P',$,(#43,#44));"),
        "{out}"
    );
    assert!(
        out.contains("#10=IFCPROPERTYSET('g2',$,'P',$,(#41,#42));"),
        "{out}"
    );
    assert!(
        out.contains("#43=IFCPROPERTYSINGLEVALUE('A',$,IFCLABEL('e1'),$);"),
        "{out}"
    );
    assert!(
        out.contains("#44=IFCPROPERTYSINGLEVALUE('B',$,IFCLABEL('e2'),$);"),
        "{out}"
    );
}

#[test]
fn a_copy_whose_referrer_cannot_be_repointed_is_not_emitted() {
    let src = concat!(
        "ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION((''),'2;1');\n",
        "FILE_NAME('','',(''),(''),'','','');\nFILE_SCHEMA(('IFC4'));\nENDSEC;\nDATA;\n",
        "#41=IFCPROPERTYSINGLEVALUE('A',$,IFCLABEL('s1'),$);\n",
        "#9=IFCPROPERTYSET('g',$,'P',$,(#42));\n",
        "#42=IFCPROPERTYSINGLEVALUE('B',$,IFCLABEL('s2'),$);\n",
        "ENDSEC;\nEND-ISO-10303-21;\n"
    );
    let (out, stats) = export_step_with_stats(
        src.as_bytes(),
        &StepOptions {
            copy_on_write: vec![CopyOnWriteMutation {
                express_id: 41,
                index: 2,
                value: "IFCLABEL('e1')".to_string(),
                referrer_id: 9,
                referrer_index: 4,
            }],
            ..StepOptions::default()
        },
    );
    assert_eq!(stats.written, stats.total, "no copy should be emitted");
    assert!(!out.contains("IFCLABEL('e1')"), "{out}");
}

#[test]
fn repointing_leaves_non_ascii_text_in_other_attributes_intact() {
    let src = concat!(
        "ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION((''),'2;1');\n",
        "FILE_NAME('','',(''),(''),'','','');\nFILE_SCHEMA(('IFC4'));\nENDSEC;\nDATA;\n",
        "#41=IFCPROPERTYSINGLEVALUE('A',$,IFCLABEL('s'),$);\n",
        "#9=IFCPROPERTYSET('g',$,'Größe',$,(#41));\n",
        "ENDSEC;\nEND-ISO-10303-21;\n"
    );
    let (out, _) = export_step_with_stats(
        src.as_bytes(),
        &StepOptions {
            copy_on_write: vec![CopyOnWriteMutation {
                express_id: 41,
                index: 2,
                value: "IFCLABEL('e')".to_string(),
                referrer_id: 9,
                referrer_index: 4,
            }],
            ..StepOptions::default()
        },
    );
    assert!(out.contains("'Größe'"), "{out}");
}

#[test]
fn a_reference_inside_a_string_is_not_repointed() {
    assert_eq!(
        substitute_ref_in_attr("(IFCLABEL('lot #41'),#41)", 41, 43).as_deref(),
        Some("(IFCLABEL('lot #41'),#43)")
    );
}

/// A file that has spent the whole id space has no room for another record.
/// Saturating the counter left it equal to an id already in use, so the copy
/// collided with a real record instead of being refused.
#[test]
fn an_exhausted_id_space_emits_no_copy() {
    let src = concat!(
        "ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION((''),'2;1');\n",
        "FILE_NAME('','',(''),(''),'','','');\nFILE_SCHEMA(('IFC4'));\nENDSEC;\nDATA;\n",
        "#41=IFCPROPERTYSINGLEVALUE('A',$,IFCLABEL('s'),$);\n",
        "#9=IFCPROPERTYSET('g',$,'P',$,(#41));\n",
        "#4294967295=IFCPROPERTYSINGLEVALUE('Z',$,IFCLABEL('z'),$);\n",
        "ENDSEC;\nEND-ISO-10303-21;\n"
    );
    let (out, stats) = export_step_with_stats(
        src.as_bytes(),
        &StepOptions {
            copy_on_write: vec![CopyOnWriteMutation {
                express_id: 41,
                index: 2,
                value: "IFCLABEL('e')".to_string(),
                referrer_id: 9,
                referrer_index: 4,
            }],
            ..StepOptions::default()
        },
    );
    assert_eq!(stats.written, stats.total, "no record should be added");
    // And nothing acquired a second definition.
    let mut ids: Vec<&str> = out
        .lines()
        .filter_map(|l| l.strip_prefix('#'))
        .filter_map(|l| l.split('=').next())
        .collect();
    let before = ids.len();
    ids.sort_unstable();
    ids.dedup();
    assert_eq!(ids.len(), before, "an id was handed out twice");
}

/// An attribute index past the end of the record. `apply_attr_mutations`
/// ignores it, so the copy would be a byte-identical twin and the referrer
/// would be repointed at a record that changed nothing.
#[test]
fn a_copy_with_an_out_of_range_attribute_is_not_made() {
    let src = concat!(
        "ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION((''),'2;1');\n",
        "FILE_NAME('','',(''),(''),'','','');\nFILE_SCHEMA(('IFC4'));\nENDSEC;\nDATA;\n",
        "#41=IFCPROPERTYSINGLEVALUE('A',$,IFCLABEL('s'),$);\n",
        "#9=IFCPROPERTYSET('g',$,'P',$,(#41));\n",
        "ENDSEC;\nEND-ISO-10303-21;\n"
    );
    let (out, stats) = export_step_with_stats(
        src.as_bytes(),
        &StepOptions {
            copy_on_write: vec![CopyOnWriteMutation {
                express_id: 41,
                // IfcPropertySingleValue has four attributes; this is past them.
                index: 9,
                value: "IFCLABEL('e')".to_string(),
                referrer_id: 9,
                referrer_index: 4,
            }],
            ..StepOptions::default()
        },
    );
    assert_eq!(stats.written, stats.total, "no copy should be emitted");
    assert!(
        out.contains("#9=IFCPROPERTYSET('g',$,'P',$,(#41));"),
        "{out}"
    );
}

/// A synthesized property set costs one id per property plus two. Checking that
/// a single id remained let a group start near the ceiling and wrap part way
/// through, emitting ids that already belong to real records.
#[test]
fn a_property_group_that_does_not_fit_the_id_space_is_skipped_whole() {
    let src = concat!(
        "ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION((''),'2;1');\n",
        "FILE_NAME('','',(''),(''),'','','');\nFILE_SCHEMA(('IFC4'));\nENDSEC;\nDATA;\n",
        "#1=IFCWALL('g',$,'W',$,$,$,$,$,$);\n",
        "#4294967293=IFCPROPERTYSINGLEVALUE('Z',$,IFCLABEL('z'),$);\n",
        "ENDSEC;\nEND-ISO-10303-21;\n"
    );
    let (out, stats) = export_step_with_stats(
        src.as_bytes(),
        &StepOptions {
            property_mutations: vec![
                PropMutation {
                    express_id: 1,
                    pset_name: "New".to_string(),
                    prop_name: "A".to_string(),
                    value: "IFCLABEL('a')".to_string(),
                },
                PropMutation {
                    express_id: 1,
                    pset_name: "New".to_string(),
                    prop_name: "B".to_string(),
                    value: "IFCLABEL('b')".to_string(),
                },
            ],
            ..StepOptions::default()
        },
    );
    // Two properties plus a set plus a relationship is four ids, and only two
    // remain, so the group is not written at all.
    assert_eq!(stats.written, stats.total, "nothing should be synthesized");
    let mut ids: Vec<&str> = out
        .lines()
        .filter_map(|l| l.strip_prefix('#'))
        .filter_map(|l| l.split('=').next())
        .collect();
    let before = ids.len();
    ids.sort_unstable();
    ids.dedup();
    assert_eq!(ids.len(), before, "an id was handed out twice");
}

#[test]
fn copy_on_write_keeps_a_caller_edit_on_the_same_attribute() {
    let src = concat!(
        "ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION((''),'2;1');\n",
        "FILE_NAME('','',(''),(''),'','','');\nFILE_SCHEMA(('IFC4'));\nENDSEC;\nDATA;\n",
        "#41=IFCPROPERTYSINGLEVALUE('Reference',$,IFCLABEL('shared'),$);\n",
        "#42=IFCPROPERTYSINGLEVALUE('Other',$,IFCLABEL('x'),$);\n",
        "#9=IFCPROPERTYSET('s1',$,'P',$,(#41));\n",
        "#10=IFCPROPERTYSET('s2',$,'P',$,(#41));\n",
        "ENDSEC;\nEND-ISO-10303-21;\n"
    );
    let (out, _) = export_step_with_stats(
        src.as_bytes(),
        &StepOptions {
            // The caller adds #42 to the same list the copy has to be
            // repointed through.
            attribute_mutations: vec![AttrMutation {
                express_id: 9,
                index: 4,
                value: "(#41,#42)".to_string(),
            }],
            copy_on_write: vec![CopyOnWriteMutation {
                express_id: 41,
                index: 2,
                value: "IFCLABEL('edited')".to_string(),
                referrer_id: 9,
                referrer_index: 4,
            }],
            ..StepOptions::default()
        },
    );

    // Both survive: the caller's #42 and the repointing of #41 onto the copy.
    // Computing the substitution from the untouched record loses #42, because
    // the rewrite is applied to the same index after the caller's edit.
    assert!(out.contains("#9=IFCPROPERTYSET('s1',$,'P',$,(#43,#42));"));
    assert!(out.contains("#43=IFCPROPERTYSINGLEVALUE('Reference',$,IFCLABEL('edited'),$);"));
    // The other sharer is untouched.
    assert!(out.contains("#10=IFCPROPERTYSET('s2',$,'P',$,(#41));"));
}

#[test]
fn a_copy_carries_a_caller_edit_to_the_record_it_copied() {
    let src = concat!(
        "ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION((''),'2;1');\n",
        "FILE_NAME('','',(''),(''),'','','');\nFILE_SCHEMA(('IFC4'));\nENDSEC;\nDATA;\n",
        "#41=IFCPROPERTYSINGLEVALUE('Reference',$,IFCLABEL('shared'),$);\n",
        "#9=IFCPROPERTYSET('s1',$,'P',$,(#41));\n",
        "#10=IFCPROPERTYSET('s2',$,'P',$,(#41));\n",
        "ENDSEC;\nEND-ISO-10303-21;\n"
    );
    let (out, _) = export_step_with_stats(
        src.as_bytes(),
        &StepOptions {
            // A rename of the property, which is a different attribute from the
            // one the copy edits.
            attribute_mutations: vec![AttrMutation {
                express_id: 41,
                index: 0,
                value: "'Renamed'".to_string(),
            }],
            copy_on_write: vec![CopyOnWriteMutation {
                express_id: 41,
                index: 2,
                value: "IFCLABEL('edited')".to_string(),
                referrer_id: 9,
                referrer_index: 4,
            }],
            ..StepOptions::default()
        },
    );

    // The copy is built from the record as the caller left it, so it carries
    // the rename as well as the new value.
    assert!(out.contains("#42=IFCPROPERTYSINGLEVALUE('Renamed',$,IFCLABEL('edited'),$);"));
    assert!(out.contains("#9=IFCPROPERTYSET('s1',$,'P',$,(#42));"));
    // The original keeps the rename and the value the other sharer still reads.
    assert!(out.contains("#41=IFCPROPERTYSINGLEVALUE('Renamed',$,IFCLABEL('shared'),$);"));
}

#[test]
fn a_record_that_is_itself_copied_is_not_also_repointed() {
    let src = concat!(
        "ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION((\'\'),\'2;1\');\n",
        "FILE_NAME(\'\',\'\',(\'\'),(\'\'),\'\',\'\',\'\');\nFILE_SCHEMA((\'IFC4\'));\nENDSEC;\nDATA;\n",
        "#41=IFCPROPERTYSINGLEVALUE(\'Reference\',$,IFCLABEL(\'shared\'),$);\n",
        "#9=IFCPROPERTYSET(\'s1\',$,\'P\',$,(#41));\n",
        "#5=IFCRELDEFINESBYPROPERTIES(\'a\',$,$,$,(#1),#9);\n",
        "#6=IFCRELDEFINESBYPROPERTIES(\'b\',$,$,$,(#2),#9);\n",
        "ENDSEC;\nEND-ISO-10303-21;\n"
    );
    let (out, stats) = export_step_with_stats(
        src.as_bytes(),
        &StepOptions {
            copy_on_write: vec![
                // A wants its own value, through the set it shares with B.
                CopyOnWriteMutation {
                    express_id: 41,
                    index: 2,
                    value: "IFCLABEL(\'A-value\')".to_string(),
                    referrer_id: 9,
                    referrer_index: 4,
                },
                // ...and its own set, through its own relationship.
                CopyOnWriteMutation {
                    express_id: 9,
                    index: 0,
                    value: "\'A-pset\'".to_string(),
                    referrer_id: 5,
                    referrer_index: 5,
                },
            ],
            ..StepOptions::default()
        },
    );

    // Applying both inverts the edit. #9 is what A keeps reading only until the
    // second mutation moves A onto a copy of it, so the repointing of #9 lands
    // on B, and A ends up on a copy still holding the old value: the element
    // that asked for the edit is the one element that does not get it.
    //
    // Saying what was meant needs the mutation to name the copy rather than the
    // record, which `CopyOnWriteMutation` cannot do. So the inner one is
    // dropped and counted. A gets its own set holding the value it already had,
    // which is incomplete rather than wrong, and nobody reads a value that is
    // not theirs.
    assert_eq!(stats.copies_refused, 1);
    assert!(out.contains("#42=IFCPROPERTYSET(\'A-pset\',$,\'P\',$,(#41));"));
    assert!(out.contains("#5=IFCRELDEFINESBYPROPERTIES(\'a\',$,$,$,(#1),#42);"));
    // B is untouched, and the shared record still says what the source said.
    assert!(out.contains("#6=IFCRELDEFINESBYPROPERTIES(\'b\',$,$,$,(#2),#9);"));
    assert!(out.contains("#9=IFCPROPERTYSET(\'s1\',$,\'P\',$,(#41));"));
    assert!(out.contains("#41=IFCPROPERTYSINGLEVALUE(\'Reference\',$,IFCLABEL(\'shared\'),$);"));
    // And no orphan: the id the dropped mutation would have spent is not spent.
    assert!(!out.contains("#43="));
}

#[test]
fn two_edits_to_one_shared_record_land_in_one_copy() {
    let src = concat!(
        "ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION((\'\'),\'2;1\');\n",
        "FILE_NAME(\'\',\'\',(\'\'),(\'\'),\'\',\'\',\'\');\nFILE_SCHEMA((\'IFC4\'));\nENDSEC;\nDATA;\n",
        "#41=IFCPROPERTYSINGLEVALUE(\'Reference\',$,IFCLABEL(\'shared\'),$);\n",
        "#9=IFCPROPERTYSET(\'s1\',$,\'P\',$,(#41));\n",
        "#10=IFCPROPERTYSET(\'s2\',$,\'P\',$,(#41));\n",
        "ENDSEC;\nEND-ISO-10303-21;\n"
    );
    let (out, _) = export_step_with_stats(
        src.as_bytes(),
        &StepOptions {
            // One mutation carries one attribute, so renaming the property and
            // changing its value is two of them through the same referrer.
            copy_on_write: vec![
                CopyOnWriteMutation {
                    express_id: 41,
                    index: 2,
                    value: "IFCLABEL(\'edited\')".to_string(),
                    referrer_id: 9,
                    referrer_index: 4,
                },
                CopyOnWriteMutation {
                    express_id: 41,
                    index: 0,
                    value: "\'Renamed\'".to_string(),
                    referrer_id: 9,
                    referrer_index: 4,
                },
            ],
            ..StepOptions::default()
        },
    );

    // Both land in the one copy. The second used to find its reference already
    // repointed, conclude the referrer did not hold it, and vanish with no
    // signal, so a caller changing a value and a unit lost the unit.
    assert!(out.contains("#42=IFCPROPERTYSINGLEVALUE(\'Renamed\',$,IFCLABEL(\'edited\'),$);"));
    assert!(out.contains("#9=IFCPROPERTYSET(\'s1\',$,\'P\',$,(#42));"));
    // One copy, not two, so no second id was spent and no orphan emitted.
    assert!(!out.contains("#43="));
    assert!(out.contains("#10=IFCPROPERTYSET(\'s2\',$,\'P\',$,(#41));"));
}

#[test]
fn a_caller_edit_at_a_missing_index_does_not_buy_a_copy() {
    let src = concat!(
        "ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION((\'\'),\'2;1\');\n",
        "FILE_NAME(\'\',\'\',(\'\'),(\'\'),\'\',\'\',\'\');\nFILE_SCHEMA((\'IFC4\'));\nENDSEC;\nDATA;\n",
        "#41=IFCPROPERTYSINGLEVALUE(\'Reference\',$,IFCLABEL(\'shared\'),$);\n",
        "#9=IFCPROPERTYSET(\'s1\',$,\'P\',$,(#41));\n",
        "ENDSEC;\nEND-ISO-10303-21;\n"
    );
    let (out, stats) = export_step_with_stats(
        src.as_bytes(),
        &StepOptions {
            // Index 9 is past the end of #9, and apply_attr_mutations ignores
            // it, so the repointing computed from it never reaches the file.
            attribute_mutations: vec![AttrMutation {
                express_id: 9,
                index: 9,
                value: "(#41)".to_string(),
            }],
            copy_on_write: vec![CopyOnWriteMutation {
                express_id: 41,
                index: 2,
                value: "IFCLABEL(\'v\')".to_string(),
                referrer_id: 9,
                referrer_index: 9,
            }],
            ..StepOptions::default()
        },
    );

    // The referrer index is checked against the record, not against whatever
    // the caller happens to have staged for it. Without that the copy was
    // emitted, an id was spent, `written` was inflated, and nothing pointed at
    // the record that came out.
    assert!(!out.contains("#42="));
    assert_eq!(stats.written, stats.total);
    assert!(out.contains("#9=IFCPROPERTYSET(\'s1\',$,\'P\',$,(#41));"));
}

#[test]
fn a_copy_that_cannot_be_made_does_not_refuse_a_repointing() {
    let src = concat!(
        "ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION((''),'2;1');\n",
        "FILE_NAME('','',(''),(''),'','','');\nFILE_SCHEMA(('IFC4'));\nENDSEC;\nDATA;\n",
        "#41=IFCPROPERTYSINGLEVALUE('Reference',$,IFCLABEL('shared'),$);\n",
        "#9=IFCPROPERTYSET('s1',$,'P',$,(#41));\n",
        "#10=IFCPROPERTYSET('s2',$,'P',$,(#41));\n",
        "#5=IFCRELDEFINESBYPROPERTIES('a',$,$,$,(#1),#10);\n",
        "ENDSEC;\nEND-ISO-10303-21;\n"
    );
    let (out, stats) = export_step_with_stats(
        src.as_bytes(),
        &StepOptions {
            copy_on_write: vec![
                // #5 points at #10, not #9, so there is nothing here to
                // repoint and no copy of #9 can be made.
                CopyOnWriteMutation {
                    express_id: 9,
                    index: 0,
                    value: "'never'".to_string(),
                    referrer_id: 5,
                    referrer_index: 5,
                },
                // This one is expressible and has nothing to do with the above.
                CopyOnWriteMutation {
                    express_id: 41,
                    index: 2,
                    value: "IFCLABEL('edited')".to_string(),
                    referrer_id: 9,
                    referrer_index: 4,
                },
            ],
            ..StepOptions::default()
        },
    );

    // The chain rule refuses a repointing of a record that is being copied.
    // Built from what was asked for rather than what can be made, it refused
    // this one on account of a copy that never happens.
    assert!(out.contains("#42=IFCPROPERTYSINGLEVALUE('Reference',$,IFCLABEL('edited'),$);"));
    assert!(out.contains("#9=IFCPROPERTYSET('s1',$,'P',$,(#42));"));
    // Only the impossible one is counted.
    assert_eq!(stats.copies_refused, 1);
    assert!(out.contains("#10=IFCPROPERTYSET('s2',$,'P',$,(#41));"));
}
