// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! #1623 Phase 2 don't-bake: proves the orphan-recovery fallback in
//! `processor/instancing.rs::recover_orphan_occurrences` actually fires and
//! recovers geometry when the plan's designated TEMPLATE occurrence (the
//! min-id `IfcMappedItem` for a repeated source) never materializes.
//!
//! `finalize_instances`'s doc comment calls this path "effectively
//! unreachable for the eligible single-solid type-instanced set (their
//! template occurrence always materializes)". That claim does not hold once
//! the opening filter (`OpeningFilterMode::IgnoreAll`) is combined with
//! instancing: `mapped_item_plan`'s template selection (`processor/mod.rs`,
//! scanning every `IFCMAPPEDITEM` up front) is computed WITHOUT knowledge of
//! which owning product jobs the filter will later skip
//! (`apply_opening_filter` / `skipped_entity_ids`, consulted only in
//! `jobs::process_entity_job`). If the plan's chosen template id belongs to
//! an `IfcWindow`/`IfcDoor` job the filter skips, that job's `EntityDecoder`
//! path returns before the router ever sees mapped item — so
//! `is_template` (`geometry/src/router/processing.rs`) is `item.id ==
//! template_item_id` for every SURVIVING occurrence too, and none of them
//! is ever `true`. Every occurrence of that source becomes a don't-bake
//! placeholder, `template_by_rep.get(&rep)` finds no non-empty template mesh,
//! and the whole group must fall to `recover_orphan_occurrences` or its
//! geometry is silently dropped.
//!
//! Before this test, NO test in the suite exercised
//! `recover_orphan_occurrences`: deleting its body (returning before the
//! bake loop, so every orphan occurrence is silently dropped) left all other
//! processing tests green.

use ifc_lite_processing::{OpeningFilterMode, ProcessingResult, StreamingOptions};

/// The synthetic mapped-instances fixture (one `IfcRepresentationMap`
/// instanced by 64 `IfcBuildingElementProxy` occurrences at distinct
/// placements), with occurrence `Proxy_0` — express id #31, whose
/// `IfcMappedItem` #25 is the plan's min-id template — retyped to
/// `IfcWindow`. `OpeningFilterMode::IgnoreAll` unconditionally skips every
/// window/door job regardless of transparency, so #31's job never reaches
/// the router.
fn fixture_with_template_owner_as_window() -> Vec<u8> {
    let path = format!(
        "{}/../geometry/tests/fixtures/mapped_instances_synthetic.ifc",
        env!("CARGO_MANIFEST_DIR")
    );
    let content = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("read {path}: {e}"));
    let old = "#31=IFCBUILDINGELEMENTPROXY('7777777777777777777771',$,'Proxy_0',$,$,#30,#27,$,$);";
    let new = "#31=IFCWINDOW('7777777777777777777771',$,'Proxy_0',$,$,#30,#27,$,$);";
    let n = content.matches(old).count();
    assert_eq!(n, 1, "fixture layout changed — Proxy_0 line not found exactly once");
    content.replace(old, new).into_bytes()
}

fn run(content: &[u8], mode: OpeningFilterMode, enable_instancing: bool) -> ProcessingResult {
    ifc_lite_processing::process_geometry_streaming_filtered_with_options(
        content,
        mode,
        StreamingOptions {
            enable_instancing,
            ..StreamingOptions::default()
        },
        |_, _, _| {},
        |_| {},
        |_| {},
    )
}

/// Flat baseline (instancing off): #31 (now `IfcWindow`) is skipped by
/// `IgnoreAll`, and the other 63 `IfcBuildingElementProxy` occurrences each
/// materialize their own geometry normally.
#[test]
fn flat_baseline_skips_the_window_and_meshes_the_rest() {
    let bytes = fixture_with_template_owner_as_window();
    let flat = run(&bytes, OpeningFilterMode::IgnoreAll, false);
    assert!(
        flat.meshes.iter().all(|m| m.express_id != 31),
        "IgnoreAll must suppress the window's own mesh"
    );
    let occurrence_count = flat
        .meshes
        .iter()
        .filter(|m| m.geometry_class == 0)
        .count();
    assert_eq!(
        occurrence_count, 63,
        "the 63 non-window proxies must each still mesh in the flat baseline"
    );
}

/// The regression gate: with instancing ON and the plan's template-owning job
/// skipped by the opening filter, every surviving occurrence's geometry must
/// still show up in the instanced result — via `recover_orphan_occurrences`
/// — not vanish. This is the exact production shape the doc comment claims
/// is "effectively unreachable"; it is reachable, and today's fallback
/// (correctly) recovers it. A regression that deletes the fallback body would
/// pass every OTHER test in this suite and only be caught here.
#[test]
fn instancing_recovers_orphaned_occurrences_when_the_template_job_is_skipped() {
    let bytes = fixture_with_template_owner_as_window();
    let flat = run(&bytes, OpeningFilterMode::IgnoreAll, false);
    let instanced = run(&bytes, OpeningFilterMode::IgnoreAll, true);

    let flat_occurrence_ids: std::collections::BTreeSet<u32> = flat
        .meshes
        .iter()
        .filter(|m| m.geometry_class == 0)
        .map(|m| m.express_id)
        .collect();
    assert_eq!(flat_occurrence_ids.len(), 63);

    let instanced_occurrence_ids: std::collections::BTreeSet<u32> = instanced
        .meshes
        .iter()
        .filter(|m| m.geometry_class == 0)
        .map(|m| m.express_id)
        .collect();

    // The hard gate: every occurrence the flat pass meshed must still be
    // present in the instanced pass's `meshes` (recovered as an orphan flat,
    // since no template ever materializes for this source). No instance
    // records should be minted either — the whole group failed to find a
    // template and was recovered as ordinary meshes instead.
    assert_eq!(
        instanced_occurrence_ids, flat_occurrence_ids,
        "instancing must not silently drop occurrences when the plan's template-owning \
         job is filtered out before the router ever sees it (recover_orphan_occurrences \
         must fire for this source)"
    );
    assert!(
        instanced.instances.is_empty(),
        "no template ever materializes for this source (its owner is skipped), so no \
         InstanceRecord should be emitted — recovery must go through `meshes`, not `instances`"
    );

    // And the recovered geometry must be non-degenerate: same triangle/vertex
    // shape as the flat baseline for one representative occurrence.
    let flat_one = flat
        .meshes
        .iter()
        .find(|m| m.express_id == 38 && m.geometry_class == 0)
        .expect("flat Proxy_1 (#38) must have a mesh");
    let recovered_one = instanced
        .meshes
        .iter()
        .find(|m| m.express_id == 38 && m.geometry_class == 0)
        .expect("recovered Proxy_1 (#38) must have a mesh in the instanced pass");
    assert_eq!(
        recovered_one.positions.len(),
        flat_one.positions.len(),
        "recovered occurrence must carry real geometry, not an empty/degenerate mesh"
    );
    assert!(
        !recovered_one.indices.is_empty(),
        "recovered occurrence must carry real triangles"
    );
}
