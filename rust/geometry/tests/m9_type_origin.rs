// SPDX-License-Identifier: MPL-2.0
#![cfg(feature = "retained-runtime")]
//! #7955 M9: source-only placement authority; no numerical receipts or kernel mocks.
use ifc_lite_core::{EntityDecoder, SourceBundle};
use ifc_lite_geometry::{GeometryRouter, program::transactions::{Plan, Program, Requirement, Traversal}};

const SOURCE: &str = include_str!("fixtures/issue_6446_mapped_source_frames.ifc");

fn walk(program: &mut Program<'_>, router: &GeometryRouter, decoder: &mut EntityDecoder) {
    while let Some(ticket) = program.request().unwrap() {
        let (reply, _, _storage) = program.admit(ticket, router, decoder).unwrap();
        program.accept(reply, router).unwrap_or_else(|e| panic!("{:?}", e.error));
    }
}
fn plan(type_id: u32, class: u8) -> Plan {
    let source = SourceBundle::new(SOURCE.as_bytes().to_vec());
    let mut decoder = source.decoder();
    let router = GeometryRouter::with_units(SOURCE, &mut decoder);
    let traversal = Traversal::new(1, 1);
    let textures = Default::default();
    let mut maps = Vec::new();
    for id in [101, 103, 108] {
        let mut program = traversal.type_map(decoder.decode_by_id(id).unwrap(), &textures);
        walk(&mut program, &router, &mut decoder);
        maps.push(program.finish_type_map(type_id, class, [1.; 4]).unwrap());
    }
    Plan::type_maps(maps).unwrap()
}
fn assert_placement_unmet(plan: Plan) {
    let requirements: Vec<_> = plan.requirements().collect();
    assert!(requirements.contains(&Requirement::ProductPlacement));
    assert!(requirements.contains(&Requirement::OpeningClosure));
}

#[test]
fn issue_7955_m9_orphan_maps_discharge_both_obligations_atomically() {
    let plan = plan(105, 1);
    assert_eq!(plan.values().len(), 6);
    assert!(plan.type_origin_placed(105, &[101, 103, 108]));
    let plan = plan.discharge_type_origin(105, &[101, 103, 108]).unwrap();
    assert_eq!(plan.requirements().collect::<Vec<_>>(), [Requirement::MaterialLayers,
        Requirement::IfcAppearance, Requirement::PersistentFaces]);
    // Frames are not asserted here: discharge only edits obligations, so a
    // before/after frame comparison could not fail. Placement correctness is
    // checked in world space by m9_native (real SDK, all six cubes incl. the
    // far box at x = 5 000 000.123456 m), which the geometry-platform lane runs.
}

#[test]
fn issue_7955_m9_product_plan_keeps_product_placement() {
    let source = SourceBundle::new(SOURCE.as_bytes().to_vec());
    let mut decoder = source.decoder();
    let router = GeometryRouter::with_units(SOURCE, &mut decoder);
    let entity = decoder.decode_by_id(70).unwrap();
    let mut program = Traversal::new(1, 1).product_parts(&entity);
    walk(&mut program, &router, &mut decoder);
    // Wrapping a product-placed plan as a type aggregate grants no authority.
    let plan = Plan::type_maps(vec![program.finish().unwrap()]).unwrap();
    assert!(!plan.type_origin_placed(105, &[101, 103, 108]));
    assert_placement_unmet(plan.discharge_type_origin(105, &[101, 103, 108]).unwrap());
}

#[test]
fn issue_7955_m9_wrong_type_map_or_instanced_class_keeps_both_obligations() {
    for (bound_type, class, planned_type, maps) in [
        (104, 1, 105, vec![101, 103, 108]),
        (105, 1, 105, vec![101, 103]),
        (105, 2, 105, vec![101, 103, 108]),
    ] {
        let plan = plan(bound_type, class);
        assert!(!plan.type_origin_placed(planned_type, &maps));
        assert_placement_unmet(plan.discharge_type_origin(planned_type, &maps).unwrap());
    }
    let empty = Plan::type_maps(Vec::new()).unwrap();
    assert!(!empty.type_origin_placed(105, &[101]));
    assert_placement_unmet(empty.discharge_type_origin(105, &[101]).unwrap());
}

#[test]
fn issue_7955_m9_discharge_charges_the_shared_work_budget() {
    use ifc_lite_geometry::resource::{ExecutionAccount, ExecutionPolicy, ResourceLimits};
    let plan = plan(105, 1);
    let account = ExecutionAccount::new(ExecutionPolicy::Bounded(ResourceLimits {
        work: Some(5), ..Default::default()
    }));
    let error = account.scope(|| plan.discharge_type_origin(105, &[101, 103, 108])).err().unwrap();
    assert!(error.original_stop().is_some(), "six values exceed five remaining work units");
}
