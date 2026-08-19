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

/// Synthetic twin of [`attribute_mutation_renames_entity`]: that test's
/// invariant (a root-attribute edit rewrites the targeted line in place,
/// keeps every entity, and the result re-parses) is pure text/line
/// manipulation over `export_step_with_stats` — it does not need
/// duplex.ifc's geometry or property sets, only *an* IFCWALLSTANDARDCASE
/// line to edit. `fixture_or_skip!` means that invariant is unpinned
/// on any checkout without the fixture corpus fetched (`pnpm fixtures`),
/// local or CI. This minimal two-entity model exercises the identical
/// code path without the fixture.
#[test]
fn attribute_mutation_renames_entity_synthetic() {
    const SRC: &str = "ISO-10303-21;\nHEADER;\n\
FILE_DESCRIPTION(('test'),'2;1');\n\
FILE_NAME('','',(''),(''),'','','');\n\
FILE_SCHEMA(('IFC4'));\n\
ENDSEC;\nDATA;\n\
#1=IFCOWNERHISTORY($,$,$,.ADDED.,$,$,$,0);\n\
#2=IFCWALLSTANDARDCASE('1sCS0nJz90qvRDVAJIGGiy',#1,'Original Wall',$,$,$,$,$);\n\
ENDSEC;\nEND-ISO-10303-21;\n";

    let step = export_step(
        SRC.as_bytes(),
        &StepOptions {
            attribute_mutations: vec![AttrMutation {
                express_id: 2,
                index: 2,
                value: "'RENAMED_BY_TEST'".to_string(),
            }],
            ..StepOptions::default()
        },
    );

    let line = step.lines().find(|l| l.starts_with("#2=")).expect("wall line present");
    assert!(line.contains("'RENAMED_BY_TEST'"), "name replaced: {line}");
    assert!(!line.contains("'Original Wall'"), "old name gone: {line}");

    let (reparsed, ids, _schema) = parse_back(&step);
    assert_eq!(reparsed, 2, "both source entities survive the edit");
    assert!(ids.contains(&1) && ids.contains(&2), "both ids present: {ids:?}");
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
