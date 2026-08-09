// SPDX-License-Identifier: MPL-2.0
//! Unit tests for the STEP/IFC exporter in `step.rs`.
//!
//! A CHILD module of `step` so it can reach that module's private helpers
//! (`escape`, `apply_attr_mutations`, `detect_schema`) without widening their
//! visibility. Split out of `step.rs` to keep the production module under the
//! `module_size_ratchet` budget.

use super::*;

fn fixture(rel: &str) -> Vec<u8> {
    let path = format!("{}/../../tests/models/{}", env!("CARGO_MANIFEST_DIR"), rel);
    std::fs::read(&path).unwrap_or_else(|e| panic!("read {path}: {e}"))
}

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
    let src = fixture("ara3d/duplex.ifc");
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
    let src = fixture("ara3d/duplex.ifc");
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
    let src = fixture("ara3d/duplex.ifc");
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
    let src = fixture("ara3d/duplex.ifc");
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
fn split_top_level_args_respects_nesting() {
    let args = "'a',$,(#1,#2,#3),IFCBOOLEAN(.T.),#9";
    let parts = split_top_level_args(args);
    assert_eq!(parts.len(), 5);
    assert_eq!(parts[2], "(#1,#2,#3)");
    assert_eq!(parts[3], "IFCBOOLEAN(.T.)");
}

#[test]
fn schema_conversion_to_ifc4_keeps_model_parseable() {
    let src = fixture("ara3d/duplex.ifc");
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

/// #2323: parse → export → parse must return the authored characters.
///
/// The reader now un-doubles `''` and `\\`, so the writer has to re-double
/// both or the fix becomes a write bug: a pset named `C:\share` would come
/// back as `C:share` (one `\` written raw, then read as an unknown escape's
/// prefix) and one named `O'Neil` would terminate its own literal. Names carry
/// the payload here because a synthesized pset is the one place `escape` runs
/// on caller text; the value token arrives pre-serialized.
#[test]
fn synthesized_names_round_trip_through_both_step_escapes() {
    let src = fixture("ara3d/duplex.ifc");
    let mut scanner = EntityScanner::new(&src[..]);
    let mut wall = None;
    while let Some((id, t, _s, _e)) = scanner.next_entity() {
        if t.eq_ignore_ascii_case("IFCWALLSTANDARDCASE") {
            wall = Some(id);
            break;
        }
    }
    let wall = wall.expect("a wall");

    let pset_name = "O\u{27}Neil C:\u{5C}share";
    let prop_name = "a\u{27}b\u{5C}c";
    let (step, _stats) = export_step_with_stats(
        &src,
        &StepOptions {
            included: Some(vec![wall]),
            property_mutations: vec![PropMutation {
                express_id: wall,
                pset_name: pset_name.to_string(),
                prop_name: prop_name.to_string(),
                value: "IFCLABEL('v')".to_string(),
            }],
            ..StepOptions::default()
        },
    );

    // Both escapes are doubled on the wire (this is what makes the STEP valid).
    assert!(
        step.contains("'O''Neil C:\\\\share'"),
        "pset name is escaped on the wire, got:\n{}",
        step.lines().filter(|l| l.contains("IFCPROPERTYSET")).collect::<Vec<_>>().join("\n")
    );

    // Re-parse the exported text through the same attribute path a consumer
    // uses and assert the ORIGINAL characters came back.
    let model = crate::model::build_export_model(step.as_bytes());
    let row = model
        .entities
        .iter()
        .find(|r| r.express_id == wall)
        .expect("the wall survived the round trip");
    let pset = row
        .property_sets
        .iter()
        .find(|p| p.name == pset_name)
        .unwrap_or_else(|| {
            panic!(
                "pset name did not round trip; got {:?}",
                row.property_sets.iter().map(|p| &p.name).collect::<Vec<_>>()
            )
        });
    assert_eq!(pset.properties.len(), 1);
    assert_eq!(pset.properties[0].name, prop_name, "prop name round trips");
}

/// The header fields go through the same `escape`, and a re-export of the
/// exported text must not grow the doubling on every pass.
#[test]
fn header_escapes_do_not_accumulate_across_re_export() {
    let src = fixture("ara3d/duplex.ifc");
    let opts = || StepOptions {
        included: Some(vec![]),
        author: "O\u{27}Neil".to_string(),
        organization: "C:\u{5C}share".to_string(),
        ..StepOptions::default()
    };
    let once = export_step(&src, &opts());
    let twice = export_step(once.as_bytes(), &opts());
    let header = |s: &str| s.lines().find(|l| l.starts_with("FILE_NAME")).unwrap().to_string();
    assert_eq!(header(&once), header(&twice), "escaping is idempotent");
    assert!(header(&once).contains("('O''Neil')"));
    assert!(header(&once).contains("('C:\\\\share')"));
}
