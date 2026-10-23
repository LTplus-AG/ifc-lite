// SPDX-License-Identifier: MPL-2.0
//! Pins `plan::execute`'s complete result, output bytes and report alike, on
//! a synthetic model and a spread of plans: renames, placement rewrites,
//! in-place/folded/copy-on-write/type-scoped property writes, delete cascades
//! up and down the reference graph, refusals, and the malformed-but-legal
//! record shapes of the model's quirks block (mixed-case keywords, a
//! multi-line record, a duplicated id, descending ids, a dangling reference,
//! a duplicated GlobalId, a comment holding an unbalanced quote).
//!
//! The digests below were recorded from the whole-file-index executor, and
//! re-recorded once since: when the quirks block's doubly declared point
//! moved to its last declaration's position and began to be reported as a
//! finding (output length unchanged). Any implementation change that alters
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
/// first: callers may not rely on their order across objects.
fn digest(output: &[u8], report: &WriteReport) -> String {
    let mut findings: Vec<String> =
        report.findings.iter().map(|f| format!("{:?}|{}", f.express_id, f.message)).collect();
    findings.sort();
    let summary = format!(
        "{}/{}/{}/{}/{}|{:?}|{:?}",
        report.total, report.written, report.deleted, report.patched, report.added_unsupported, report.refusals, findings
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
    ("IFC2X3/preserve", "80411c334de4bd07:124189"),
    ("IFC2X3/rename_by_guid", "1518d1d507065968:124205"),
    ("IFC2X3/placements", "f819f59591d7f6dd:125065"),
    // `props` and `benchmark` each write one IfcQuantityLength value. It is
    // written bare (`7.`), not as `IFCLENGTHMEASURE(7.)`: LengthValue is the
    // defined type itself, not a SELECT. 18 bytes shorter per scenario.
    ("IFC2X3/props", "f734d93209564412:124753"),
    ("IFC2X3/delete_with_opening_and_boundary", "0cd5d0106d59a06f:121863"),
    ("IFC2X3/delete_storey", "6d5c307a147219e7:123783"),
    ("IFC2X3/delete_storey_placement", "dce3ea988bf6bdae:83972"),
    ("IFC2X3/delete_whole_group", "04c3a081316974cc:74942"),
    ("IFC2X3/delete_type", "5e55d9b1b4ab4a9e:123831"),
    ("IFC2X3/delete_wins_and_unknowns", "a7f1debb5adefae8:122990"),
    ("IFC2X3/quirks", "fba5a217eefd61fa:124395"),
    // `benchmark` deletes a wall from a shared-pset group and patches
    // another wall of the SAME group in one plan. The delete's own list
    // rewrite and the patch's copy-on-write detach used to be resolved
    // independently and land on the same relationship's RelatedObjects,
    // so whichever ran last silently discarded the other's strip — the
    // patched wall kept a stray reference to the old relationship on top
    // of its new one, and the validator flagged the resulting duplicate
    // `Pset_Shared`. Composing both strips into one rewrite drops that
    // stray reference (6 fewer bytes) and the finding along with it.
    ("IFC2X3/benchmark", "70f5086a7d06d781:129144"),
    ("IFC4/preserve", "bd388bd3c7e550c2:124703"),
    ("IFC4/rename_by_guid", "82e307937639bf61:124719"),
    ("IFC4/placements", "f6119086b8ffe1a4:125579"),
    ("IFC4/props", "b2e98127eb353a1b:125267"),
    ("IFC4/delete_with_opening_and_boundary", "30a92c7c7ff10b40:122367"),
    ("IFC4/delete_storey", "bfaff42a94222d7e:124297"),
    ("IFC4/delete_storey_placement", "b4444e0718912b9b:84308"),
    ("IFC4/delete_whole_group", "442b54feba95cf1f:75246"),
    ("IFC4/delete_type", "cc3eda45c1ac0247:124345"),
    ("IFC4/delete_wins_and_unknowns", "e3f38c10f4ea8ac5:123498"),
    ("IFC4/quirks", "fbca61a00ac4c43b:124907"),
    // Same fix, same scenario, IFC4: see the IFC2X3 comment above.
    ("IFC4/benchmark", "0ac47b1862130c3a:129644"),
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
