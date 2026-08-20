// SPDX-License-Identifier: MPL-2.0
//! Tests for `step.rs`, split out under the house pattern (AGENTS.md).
//!
//! Moved out so the production module stays under the module-size ratchet
//! (`rust/processing/tests/module_size_ratchet.rs`); this file is exempt via
//! the `_tests.rs` suffix convention.

use super::*;


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
            &StepOptions { included: Some(vec![wall_id]), ..StepOptions::default() },
        );
        let (_n, ids, _schema) = parse_back(&step);

        assert!(ids.contains(&wall_id), "the requested wall is present");
        assert!(stats.written < stats.total, "subset is smaller than the whole model");

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
            step.lines().any(|l| l.contains("=IFCRELDEFINESBYPROPERTIES(") && l.contains(&synth_rel)),
            "synthesized rel targeting the wall not found"
        );

        // Re-parses, and the synthesized entities are counted (written = original + 3).
        let (reparsed, _ids, _schema) = parse_back(&step);
        assert_eq!(reparsed, stats.written, "every written entity re-parses");
        assert_eq!(stats.written, stats.total + 3, "added 1 prop + 1 pset + 1 rel");
    }

    #[test]
    fn schema_conversion_to_ifc4_keeps_model_parseable() {
        let src = fixture_or_skip!("ara3d/duplex.ifc");
        let (step, stats) = export_step_with_stats(
            &src,
            &StepOptions { schema: Some("IFC4".to_string()), ..StepOptions::default() },
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


    fn fixture(rel: &str) -> Vec<u8> {
        let path = format!("{}/../../tests/models/{}", env!("CARGO_MANIFEST_DIR"), rel);
        std::fs::read(&path).unwrap_or_else(|e| panic!("read {path}: {e}"))
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
    assert!(out.contains("#9=IFCPROPERTYSET('g',$,'P',$,(#43,#44));"), "{out}");
    assert!(out.contains("#10=IFCPROPERTYSET('g2',$,'P',$,(#41,#42));"), "{out}");
    assert!(out.contains("#43=IFCPROPERTYSINGLEVALUE('A',$,IFCLABEL('e1'),$);"), "{out}");
    assert!(out.contains("#44=IFCPROPERTYSINGLEVALUE('B',$,IFCLABEL('e2'),$);"), "{out}");
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
