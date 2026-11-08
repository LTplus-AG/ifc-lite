// SPDX-License-Identifier: MPL-2.0
//! Pins `plan::execute`'s complete result, output bytes and report alike, on
//! a synthetic model and a spread of plans: renames, placement rewrites,
//! in-place/folded/copy-on-write/type-scoped property writes, body geometry
//! replacement, delete cascades
//! up and down the reference graph, refusals, and the malformed-but-legal
//! record shapes of the model's quirks block (mixed-case keywords, a
//! multi-line record, a duplicated id, descending ids, a dangling reference,
//! a duplicated GlobalId, a comment holding an unbalanced quote).
//!
//! The digests below were recorded from the whole-file-index executor, and
//! re-recorded since: once when the quirks block's doubly declared point
//! moved to its last declaration's position and began to be reported as a
//! finding (output length unchanged), once when delete stopped pruning
//! objects the plan did not name (the comments below say which moved), and
//! once when a patch whose every part is refused stopped counting as patched
//! (quirks: two refused placements; output bytes unchanged), and once when
//! IFC2X3 output began placing one product per placement (#9209): every
//! IFC2X3 scenario but `delete_storey_placement` gains one 37-byte copy of the
//! placement two products share; IFC4 is unchanged. Any implementation change that alters
//! a single output byte, a count, a refusal or a finding fails here.
//!
//! To re-record after an intended output change:
//! `PLAN_PIN_PRINT=1 cargo test -p ifc-lite-export --test plan_output_pinned -- --nocapture`

#[path = "../examples/plan_memory/plans.rs"]
mod plans;
#[path = "../examples/plan_memory/synth.rs"]
mod synth;

use ifc_lite_export::plan::{execute, WriteReport};

const WALLS: u32 = 120;

fn fnv1a(bytes: &[u8], mut h: u64) -> u64 {
    for &b in bytes {
        h ^= u64::from(b);
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
    }
    h
}

/// One digest over everything a caller can observe. Findings are sorted
/// first: callers may not rely on their order across objects. The finding
/// that these plans name no `ExportingApplication` is left out: the pins
/// then show a plan without one writes the bytes it always did.
fn digest(output: &[u8], report: &WriteReport) -> String {
    let mut findings: Vec<String> = report
        .findings
        .iter()
        .filter(|f| !f.message.starts_with("no ExportingApplication"))
        .map(|f| format!("{:?}|{}", f.express_id, f.message))
        .collect();
    findings.sort();
    let summary = format!(
        "{}/{}/{}/{}/{}|{:?}|{:?}",
        report.total, report.written, report.deleted, report.patched, report.added, report.refusals, findings
    );
    let h = fnv1a(summary.as_bytes(), fnv1a(output, 0xcbf2_9ce4_8422_2325));
    format!("{h:016x}:{}", output.len())
}

fn run_all() -> Vec<(String, String)> {
    let mut out = Vec::new();
    for schema in ["IFC2X3", "IFC4"] {
        let layout = synth::Layout { walls: WALLS, storeys: 3, quirks: true };
        let mut model = Vec::new();
        synth::write_model(&mut model, schema, &layout).expect("write the model");
        for (name, plan) in plans::scenarios(&layout) {
            let mut bytes = Vec::new();
            let report = execute(&model, &plan, &mut bytes).expect(name);
            out.push((format!("{schema}/{name}"), digest(&bytes, &report)));
        }
    }
    out
}

const PINNED: &[(&str, &str)] = &[
    ("IFC2X3/preserve", "ab693db8904310ba:124226"),
    ("IFC2X3/rename_by_guid", "4c827df678f41e51:124242"),
    ("IFC2X3/placements", "7ce04d727726bf5b:125102"),
    // `props` and `benchmark` each write one IfcQuantityLength value. It is
    // written bare (`7.`), not as `IFCLENGTHMEASURE(7.)`: LengthValue is the
    // defined type itself, not a SELECT. 18 bytes shorter per scenario.
    ("IFC2X3/props", "2d63a7ee5d89205a:124790"),
    ("IFC2X3/delete_with_opening_and_boundary", "8e8de201a824f201:121900"),
    ("IFC2X3/delete_storey", "48b2ff02b282094f:123820"),
    // `delete_storey_placement` reaches the quirks block's dangling reference.
    // It names no record, so it is not counted in `deleted`. It and
    // `delete_whole_group` also delete every wall bounding one space. The
    // space used to be pruned with its last boundary; as an object the plan
    // did not delete it now stays (one 70-byte IFCSPACE line more in each,
    // nothing else moved).
    ("IFC2X3/delete_storey_placement", "68fd48c10ae89f54:84042"),
    ("IFC2X3/delete_whole_group", "6293a3c3f4310e49:75049"),
    ("IFC2X3/delete_type", "ca392d068aa1b586:123868"),
    // `delete_wins_and_unknowns` includes an Add keyed by a wall that
    // already exists. It is refused and writes nothing, so the output bytes
    // are unchanged; only the report moved (a refusal, `added` 0).
    ("IFC2X3/delete_wins_and_unknowns", "b6f17bd7acf2eca6:123027"),
    ("IFC2X3/quirks", "99b09b375dda1f54:124432"),
    // `benchmark` deletes a wall from a shared-pset group and patches
    // another wall of the SAME group in one plan. The delete's own list
    // rewrite and the patch's copy-on-write detach used to be resolved
    // independently and land on the same relationship's RelatedObjects,
    // so whichever ran last silently discarded the other's strip — the
    // patched wall kept a stray reference to the old relationship on top
    // of its new one, and the validator flagged the resulting duplicate
    // `Pset_Shared`. Composing both strips into one rewrite drops that
    // stray reference (6 fewer bytes) and the finding along with it.
    ("IFC2X3/benchmark", "345ad0bd2065df2d:129181"),
    // New bodies for eight walls (one with an opening, one with a space
    // boundary), each replacing an extruded solid and its profile chain.
    ("IFC2X3/geometry", "31ad94378d5ca40f:136426"),
    // Two of three storeys and every wall they contain.
    ("IFC2X3/bulk_delete", "6e43d2da160df417:45415"),
    ("IFC4/preserve", "bd388bd3c7e550c2:124703"),
    ("IFC4/rename_by_guid", "82e307937639bf61:124719"),
    ("IFC4/placements", "f6119086b8ffe1a4:125579"),
    ("IFC4/props", "b2e98127eb353a1b:125267"),
    ("IFC4/delete_with_opening_and_boundary", "30a92c7c7ff10b40:122367"),
    ("IFC4/delete_storey", "5d6cbab320e92424:124297"),
    // Same space as in IFC2X3, see above.
    ("IFC4/delete_storey_placement", "d43c18bf0f615a99:84378"),
    ("IFC4/delete_whole_group", "f262523aaedc86ba:75316"),
    ("IFC4/delete_type", "cc3eda45c1ac0247:124345"),
    ("IFC4/delete_wins_and_unknowns", "3b9736287ed34429:123498"),
    ("IFC4/quirks", "3088e24e98413835:124907"),
    // Same fix, same scenario, IFC4: see the IFC2X3 comment above.
    ("IFC4/benchmark", "0ac47b1862130c3a:129644"),
    ("IFC4/geometry", "6b055df60c996be8:125923"),
    ("IFC4/bulk_delete", "7f9fd7d71e72f5ea:45556"),
];

#[test]
fn executor_output_matches_the_pinned_digests() {
    let got = run_all();
    if std::env::var_os("PLAN_PIN_PRINT").is_some() {
        for (name, d) in &got {
            println!("    (\"{name}\", \"{d}\"),");
        }
        return;
    }
    assert_eq!(got.len(), PINNED.len(), "scenario count changed");
    let mut mismatched = Vec::new();
    for ((name, d), (pinned_name, pinned)) in got.iter().zip(PINNED) {
        assert_eq!(name, pinned_name, "scenario order changed");
        if d != pinned {
            mismatched.push(format!("{name}: got {d}, pinned {pinned}"));
        }
    }
    assert!(mismatched.is_empty(), "output drifted:\n{}", mismatched.join("\n"));
}
