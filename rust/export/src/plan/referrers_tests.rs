// SPDX-License-Identifier: MPL-2.0
use rustc_hash::FxHashSet;

use super::names_any;
use crate::plan::index::FileIndex;
use crate::plan::types::*;

#[path = "../../examples/plan_memory/synth.rs"]
#[allow(dead_code)]
mod synth;

fn model(walls: u32) -> (synth::Layout, Vec<u8>) {
    let layout = synth::Layout { walls, storeys: 4, quirks: false };
    let mut bytes = Vec::new();
    synth::write_model(&mut bytes, "IFC2X3", &layout).unwrap();
    (layout, bytes)
}

fn place(id: u32) -> (ObjectRef, Disposition) {
    let matrix = [[1.0, 0.0, 0.0, 2.0], [0.0, 1.0, 0.0, 0.0], [0.0, 0.0, 1.0, 0.0], [0.0, 0.0, 0.0, 1.0]];
    (ObjectRef::Id(id), Disposition::Patch(Patch { placement: Some(PlacementPatch { matrix }), ..Default::default() }))
}

fn shared_pset_write(id: u32) -> (ObjectRef, Disposition) {
    let write = PropWrite {
        pset: "Pset_Shared".into(),
        prop: "Grade".into(),
        measure_type: "IFCLABEL".into(),
        literal: "'x'".into(),
        unit: None,
        kind: PsetKind::Property,
        scope: PropScope::Occurrence,
        target: None,
    };
    (ObjectRef::Id(id), Disposition::Patch(Patch { psets: vec![write], ..Default::default() }))
}

/// Run `plan` and return the index as resolution left it.
fn resolved<'a>(content: &'a [u8], plan: &ExportPlan) -> FileIndex<'a> {
    let mut index = FileIndex::scan(content, &FxHashSet::default());
    let schema = crate::schema_detect::detect_schema(content);
    while {
        crate::plan::resolve::resolve(&index, &schema, plan);
        index.collect_missing_referrers()
    } {}
    index
}

/// The shape the memory target is about: placement patches, a copy-on-write
/// property write and deletes settle in two passes, and what gets collected
/// is sized by the plan, not the file.
#[test]
fn an_ordinary_plan_settles_in_two_passes_and_collects_a_plan_sized_set() {
    let (layout, content) = model(3_000);
    let records = ifc_lite_core::entity_count(&content);
    let mut dispositions: Vec<_> = (0..20).map(|k| place(layout.wall(k * 100))).collect();
    dispositions.push(shared_pset_write(layout.wall(1_501)));
    dispositions.push((ObjectRef::Id(layout.wall(1_000)), Disposition::Delete));
    dispositions.push((ObjectRef::Id(layout.wall(2_107)), Disposition::Delete));
    let plan = ExportPlan { dispositions, context: PlanContext::attributed() };

    let index = resolved(&content, &plan);
    assert_eq!(index.referrers.passes(), 2);
    let (lists, counts) = index.referrers.collected();
    assert!(lists + counts < 400, "{lists} lists + {counts} counts collected for {records} records");
}

/// A deletion that other records hang off by a scalar attribute: every wall
/// placement on the storey names the deleted placement, every wall names its
/// placement, and so on. One pass per level of that chain, still exact.
#[test]
fn a_chain_of_scalar_dependants_costs_one_pass_per_level() {
    let (layout, content) = model(200);
    let plan = ExportPlan {
        dispositions: vec![(ObjectRef::Id(layout.storey_placement(0)), Disposition::Delete)],
        context: PlanContext::attributed(),
    };
    let index = resolved(&content, &plan);
    assert!(index.referrers.passes() > 2, "{}", index.referrers.passes());
}

#[test]
fn referrers_are_listed_once_per_mention_and_counted_once_per_record() {
    let content = crate::plan::test_fixtures::wall_with_own_pset("IFC4").into_iter().collect::<Vec<u8>>();
    let text = String::from_utf8(content).unwrap().replace("#50=IFCUNITASSIGNMENT((#51));", "#50=IFCUNITASSIGNMENT((#51,#51));");
    let mut index = FileIndex::scan(text.as_bytes(), &FxHashSet::default());
    index.collect_all_referrers();
    assert_eq!(index.referrers(51), &[(50, 0), (50, 0)]);
    assert_eq!(index.referrer_count(51), Some(1));
}

#[test]
fn an_uncollected_id_is_answered_conservatively_and_recorded() {
    let content = crate::plan::test_fixtures::wall_with_own_pset("IFC4");
    let mut index = FileIndex::scan(&content, &FxHashSet::default());
    assert!(index.referrers(31).is_empty());
    assert_eq!(index.referrer_count(22), None);
    assert!(index.collect_missing_referrers());
    assert_eq!(index.referrers(31), &[(32, 5)]);
    assert_eq!(index.referrer_count(22), Some(1));
    assert!(!index.collect_missing_referrers(), "nothing was asked about since");
}

#[test]
fn the_prefilter_ignores_quotes_so_it_cannot_hide_a_reference() {
    let wanted = |id| id == 7;
    assert!(names_any(b"#1=X(/* it's */ $,#7);", wanted));
    assert!(names_any(b"#1=X('#7');", wanted), "over-reporting is fine: the exact parse decides");
    assert!(!names_any(b"#1=X(#70,#8);", wanted));
}
