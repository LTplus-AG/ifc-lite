// SPDX-License-Identifier: MPL-2.0
//! STEP entity keywords are case-insensitive per ISO 10303-21, and
//! `EntityScanner::next_entity` returns the keyword exactly as the file wrote
//! it. The merged/federated export path reads `ModelIndex::type_of` with
//! case-sensitive comparisons — a `match` on `"IFCSITE" | "IFCBUILDING" |
//! "IFCBUILDINGSTOREY"` in `unify_spatial`, `!= Some("IFCRELAGGREGATES")` in
//! `skip_redundant_rel_aggregates`, `starts_with("IFCREL")` in
//! `is_relationship_type` and in the empty-container pruner, and an exact
//! `CONTAINER_TYPES.contains` in `is_container_type`. If `type_of` were stored
//! as written rather than folded once at population, a merged model spelling
//! its containers `ifcsite` / `IfcBuilding` / `IfcBuildingStorey` would pass
//! through unmatched and duplicate the shared spatial tree, and its empty
//! containers would never be pruned.
//!
//! These tests pin the merged export end to end on a recased fixture: the
//! mixed-case run must produce output *identical* to the all-uppercase
//! control, not merely be self-consistent. The control is asserted too, so a
//! fixture that merges nothing cannot pass trivially.

use ifc_lite_export::{export_merged_models, MergedModel, MergedOptions};

fn file(entities: &str) -> String {
    format!(
        "ISO-10303-21;\nHEADER;\nFILE_SCHEMA(('IFC4'));\nENDSEC;\nDATA;\n{entities}ENDSEC;\nEND-ISO-10303-21;\n"
    )
}

/// Project → Site → Building → Storey, one wall in the storey. The container
/// GlobalIds are stable across models so the two spatial trees are meant to
/// unify into one; only the wall differs.
fn model(wall_guid: &str) -> String {
    file(&format!(
        concat!(
            "#1=IFCPROJECT('p0',$,'P',$,$,$,$,$,$);\n",
            "#2=IFCSITE('s0',$,'Site',$,$,$,$,$,$,$,$,$,$,$);\n",
            "#3=IFCBUILDING('b0',$,'Building',$,$,$,$,$,$,$,$,$);\n",
            "#4=IFCBUILDINGSTOREY('l0',$,'Level 0',$,$,$,$,$,$,0.);\n",
            "#5=IFCWALL('{wall}',$,'Wall',$,$,$,$,$,$);\n",
            "#6=IFCRELAGGREGATES('r0',$,$,$,#1,(#2));\n",
            "#7=IFCRELAGGREGATES('r1',$,$,$,#2,(#3));\n",
            "#8=IFCRELAGGREGATES('r2',$,$,$,#3,(#4));\n",
            "#9=IFCRELCONTAINEDINSPATIALSTRUCTURE('r3',$,$,$,(#5),#4);\n",
        ),
        wall = wall_guid
    ))
}

/// Recase every STEP keyword the merge path matches on. The string payloads
/// carry no keyword text, so nothing but the keywords changes.
fn recase(step: &str) -> String {
    step.replace("IFCSITE", "ifcsite")
        .replace("IFCBUILDINGSTOREY", "IfcBuildingStorey")
        .replace("IFCBUILDING(", "IfcBuilding(")
        .replace("IFCRELAGGREGATES", "ifcrelaggregates")
        .replace("IFCRELCONTAINEDINSPATIALSTRUCTURE", "IfcRelContainedInSpatialStructure")
        .replace("IFCWALL", "IfcWall")
}

fn merge(a: &str, b: &str) -> (String, usize) {
    let inputs = [
        MergedModel { content: a.as_bytes(), id: "a".into(), included: None },
        MergedModel { content: b.as_bytes(), id: "b".into(), included: None },
    ];
    let (out, stats) = export_merged_models(&inputs, &MergedOptions::default());
    (out, stats.models)
}

/// Count `#id=KEYWORD(` lines for `keyword`, case-insensitively so the count
/// itself never depends on the spelling under test.
fn count(step: &str, keyword: &str) -> usize {
    let needle = format!("={keyword}(");
    step.lines().filter(|l| l.to_ascii_uppercase().contains(&needle)).count()
}

/// Fixture guard: the recased text really is recased. Without this a typo in
/// `recase` would make every assertion below vacuous.
#[test]
fn fixture_is_actually_recased() {
    let m = model("w1");
    let r = recase(&m);
    assert_ne!(m, r, "recase() changed nothing");
    assert!(r.contains("=ifcsite("), "site keyword not recased");
    assert!(r.contains("=IfcBuilding("), "building keyword not recased");
    assert!(r.contains("=IfcBuildingStorey("), "storey keyword not recased");
    assert!(r.contains("=ifcrelaggregates("), "aggregates keyword not recased");
    assert!(!r.contains("=IFCSITE("), "an uppercase site keyword survived");
}

#[test]
fn mixed_case_keywords_unify_the_shared_spatial_tree() {
    let a = model("w1");
    let b = model("w2");

    // Control: both models all-uppercase. This must hold before and after the
    // normalisation, otherwise the fixture merges nothing and the mixed-case
    // case below passes trivially.
    let (control, models) = merge(&a, &b);
    assert_eq!(models, 2, "both models were merged");
    assert_eq!(count(&control, "IFCSITE"), 1, "control: one site");
    assert_eq!(count(&control, "IFCBUILDING"), 1, "control: one building");
    assert_eq!(count(&control, "IFCBUILDINGSTOREY"), 1, "control: one storey");
    // Both walls survive: the merge unified the containers, not the contents.
    assert_eq!(count(&control, "IFCWALL"), 2, "control: both walls kept");

    // Model 2 with non-uppercase keywords must merge exactly the same way.
    let (mixed, models) = merge(&a, &recase(&b));
    assert_eq!(models, 2);
    assert_eq!(count(&mixed, "IFCSITE"), 1, "mixed case: the site must unify, not duplicate");
    assert_eq!(count(&mixed, "IFCBUILDING"), 1, "mixed case: the building must unify");
    assert_eq!(count(&mixed, "IFCBUILDINGSTOREY"), 1, "mixed case: the storey must unify");
    assert_eq!(count(&mixed, "IFCWALL"), 2, "mixed case: both walls kept");

    // Stronger than per-run self-consistency: keyword case is not significant,
    // so the two merges must agree once the carried-through keyword case of the
    // second model is folded out.
    assert_eq!(
        mixed.to_ascii_uppercase(),
        control.to_ascii_uppercase(),
        "a recased input must merge to the same model"
    );
}

/// Every container empty (the wall is excluded from the export), so
/// `drop_empty_containers` should prune site, building and storey alike.
#[test]
fn mixed_case_keywords_still_prune_empty_containers() {
    let m = model("w1");
    let opts = MergedOptions { drop_empty_containers: true, ..Default::default() };

    let run = |content: &str| {
        // Exclude the wall (#5) and its containment relationship (#9) so the
        // containers hold nothing. Recasing leaves express ids untouched, so
        // the same include set applies to both spellings.
        let included: Vec<u32> = vec![1, 2, 3, 4, 6, 7, 8];
        let inputs =
            [MergedModel { content: content.as_bytes(), id: "a".into(), included: Some(included) }];
        export_merged_models(&inputs, &opts).1.dropped_container_count
    };

    // Control first: if this is not 3 the mixed-case assertion proves nothing.
    assert_eq!(run(&m), 3, "control: all three empty containers pruned");
    assert_eq!(run(&recase(&m)), 3, "mixed case: all three empty containers pruned");
}
