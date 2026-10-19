// SPDX-License-Identifier: MPL-2.0
//! Standalone scanned records and model-bound source selection are distinct contracts.
use ifc_lite_core::{EntityDecoder, EntityScanner, SourceBundle};
use ifc_lite_processing::{
    authored_geometry::{plan_authored_geometry, AuthoredGeometryPlan, EvaluationRequirement},
    element::{OwnedMeshProductionData, ProductionModel},
    extract_extrusion_definitions,
};
use std::collections::HashSet;

fn duplicate_source() -> String {
    // Derived invariant input: one product is authored twice with different
    // real extrusion sources; one relationship is authored twice with different openings.
    let original = include_str!("../../geometry/tests/fixtures/mapped_instances_synthetic.ifc");
    original.replace("ENDSEC;\nEND-ISO-10303-21;", "\
#900=IFCEXTRUDEDAREASOLID(#8,#11,#9,7.0);
#901=IFCSHAPEREPRESENTATION(#5,'Body','SweptSolid',(#900));
#902=IFCPRODUCTDEFINITIONSHAPE($,$,(#901));
#31=IFCBUILDINGELEMENTPROXY('duplicate',$,$,$,$,#30,#902,$,$);
#920=IFCOPENINGELEMENT('first-opening',$,$,$,$,#30,#902,$);
#921=IFCOPENINGELEMENT('last-opening',$,$,$,$,#30,#902,$);
#910=IFCRELVOIDSELEMENT('first-link',$,$,$,#31,#920);
#910=IFCRELVOIDSELEMENT('last-link',$,$,$,#31,#921);
ENDSEC;
END-ISO-10303-21;")
}

fn openings(plan: &AuthoredGeometryPlan) -> Vec<(u32, u32)> {
    plan.products[&31].requirements.iter().filter_map(|requirement| match requirement {
        EvaluationRequirement::ExternalOpening { relationship_id, opening_id } =>
            Some((*relationship_id, *opening_id)),
        _ => None,
    }).collect()
}
fn solids(plan: &AuthoredGeometryPlan) -> Vec<u32> {
    plan.recipes.iter().filter(|recipe| recipe.product_id == 31)
        .map(|recipe| recipe.source.solid_id).collect()
}

#[test]
fn standalone_duplicate_products_keep_scanned_definitions_and_last_instance() {
    let input = duplicate_source();
    let ids = HashSet::from([31]);
    let definitions = extract_extrusion_definitions(input.as_bytes(), Some(&ids));
    assert_eq!(definitions.sources.iter().map(|source| source.source.solid_id).collect::<Vec<_>>(), [12, 900]);
    assert_eq!(definitions.sources.iter().map(|source| source.source.depth).collect::<Vec<_>>(), [Some(1.), Some(7.)]);
    // Historical per-product output is replaced by the last successful scanned
    // record, while both definitions and relationship facts survive analysis.
    assert_eq!(definitions.instances[&31].len(), 1);
    assert_eq!(definitions.instances[&31][0].solid_id, 900);
    let plan = plan_authored_geometry(input.as_bytes(), Some(&ids));
    assert_eq!(solids(&plan), [900]);
    assert_eq!(openings(&plan), [(910, 920), (910, 921)]);
}

fn prewarm_first(decoder: &mut EntityDecoder<'_>, content: &[u8], id: u32) {
    let mut scanner = EntityScanner::new(content);
    while let Some((candidate, _, start, end)) = scanner.next_entity() {
        if candidate == id {
            decoder.decode_at_with_id(id, start, end).unwrap();
            return;
        }
    }
    panic!("missing stated prewarm record #{id}");
}

#[test]
fn bound_duplicate_products_and_links_use_actual_factory_cache_without_replaying_records() {
    let source = SourceBundle::new(duplicate_source().into_bytes());
    let model = ProductionModel::from_source(source.clone());
    let fresh_context = model.snapshot(OwnedMeshProductionData::default());
    let mut fresh = source.decoder();
    let fresh_plan = fresh_context.admit_authored_plan(&mut fresh).unwrap();
    assert_eq!(solids(fresh_plan.plan()), [900]);
    assert_eq!(openings(fresh_plan.plan()), [(910, 921)]);

    // Direct earlier-record reads remain readable but the authenticated decoder
    // deliberately prevents them from poisoning canonical last-record selection.
    let warm_context = model.snapshot(OwnedMeshProductionData::default());
    let mut warm = source.decoder();
    prewarm_first(&mut warm, source.bytes(), 31);
    prewarm_first(&mut warm, source.bytes(), 910);
    let warm_plan = warm_context.admit_authored_plan(&mut warm).unwrap();
    assert_eq!(solids(warm_plan.plan()), [900]);
    assert_eq!(openings(warm_plan.plan()), [(910, 921)]);
    assert_eq!(warm.decode_by_id(31).unwrap().get_ref(6), Some(902));
    assert_eq!(warm.decode_by_id(910).unwrap().get_ref(5), Some(921));
}

#[test]
fn standalone_duplicate_relationship_keeps_earlier_fault_while_bound_uses_selected_record() {
    let input = duplicate_source().replace(
        "#910=IFCRELVOIDSELEMENT('first-link',$,$,$,#31,#920);",
        "#910=IFCRELVOIDSELEMENT('first-link',$,$,$,$,#920);");
    let standalone = plan_authored_geometry(input.as_bytes(), Some(&HashSet::from([31])));
    assert!(standalone.products[&31].requirements.iter().any(|requirement|
        matches!(requirement, EvaluationRequirement::OpeningRelationshipsUnverified)));
    assert!(standalone.diagnostics.iter().any(|message| message.contains("IfcRelVoidsElement #910")));
    assert_eq!(openings(&standalone), [(910, 921)]);

    let source = SourceBundle::new(input.into_bytes());
    let model = ProductionModel::from_source(source.clone());
    let context = model.snapshot(OwnedMeshProductionData::default());
    let mut decoder = source.decoder();
    let bound = context.admit_authored_plan(&mut decoder).unwrap();
    assert!(!bound.plan().products[&31].requirements.iter().any(|requirement|
        matches!(requirement, EvaluationRequirement::OpeningRelationshipsUnverified)));
    assert_eq!(openings(bound.plan()), [(910, 921)]);
}

#[test]
fn same_context_cache_is_bound_to_actual_decoder_configuration_in_both_orders() {
    for warm_first in [true, false] {
        let source = SourceBundle::new(duplicate_source().into_bytes());
        let model = ProductionModel::from_source(source.clone());
        let context = model.snapshot(OwnedMeshProductionData::default());
        let mut warm = source.decoder();
        warm.seed_unit_scales(0.001, 1.0);
        let mut fresh = source.decoder();
        fresh.seed_unit_scales(1.0, 1.0);
        assert_eq!(warm.length_unit_scale(), 0.001);
        assert_eq!(fresh.length_unit_scale(), 1.0);
        let (warm_plan, fresh_plan) = if warm_first {
            let warm_plan = context.admit_authored_plan(&mut warm).unwrap();
            (warm_plan, context.admit_authored_plan(&mut fresh).unwrap())
        } else {
            let fresh_plan = context.admit_authored_plan(&mut fresh).unwrap();
            (context.admit_authored_plan(&mut warm).unwrap(), fresh_plan)
        };
        assert_eq!(solids(warm_plan.plan()), [900]);
        assert_eq!(openings(warm_plan.plan()), [(910, 921)]);
        assert_eq!(solids(fresh_plan.plan()), [900]);
        assert_eq!(openings(fresh_plan.plan()), [(910, 921)]);
        assert_eq!(warm_plan.plan().length_unit_scale, 0.001);
        assert_eq!(fresh_plan.plan().length_unit_scale, 1.0);
        assert!(!std::sync::Arc::ptr_eq(&warm_plan, &fresh_plan));
        assert!(std::sync::Arc::ptr_eq(&warm_plan,
            &context.admit_authored_plan(&mut warm).unwrap()));
        assert!(std::sync::Arc::ptr_eq(&fresh_plan,
            &context.admit_authored_plan(&mut fresh).unwrap()));
    }
}

#[test]
fn cache_mutation_generations_recompute_selected_facts_without_replacing_decoder_policy() {
    let source = SourceBundle::new(duplicate_source().into_bytes());
    let model = ProductionModel::from_source(source.clone());
    let context = model.snapshot(OwnedMeshProductionData::default());
    let mut decoder = source.decoder();
    prewarm_first(&mut decoder, source.bytes(), 31);
    prewarm_first(&mut decoder, source.bytes(), 910);
    let first = context.admit_authored_plan(&mut decoder).unwrap();
    assert_eq!(solids(first.plan()), [900]);
    assert_eq!(openings(first.plan()), [(910, 921)]);
    decoder.clear_cache();
    let cleared = context.admit_authored_plan(&mut decoder).unwrap();
    assert_eq!(solids(cleared.plan()), [900]);
    assert_eq!(openings(cleared.plan()), [(910, 921)]);
    assert!(!std::sync::Arc::ptr_eq(&first, &cleared));
    let _drained = decoder.drain_source_cache();
    let drained = context.admit_authored_plan(&mut decoder).unwrap();
    assert_eq!(solids(drained.plan()), [900]);
    assert!(!std::sync::Arc::ptr_eq(&cleared, &drained));
    let mut donor = source.decoder();
    prewarm_first(&mut donor, source.bytes(), 31);
    prewarm_first(&mut donor, source.bytes(), 910);
    assert!(decoder.inject_source_cache(&donor.drain_source_cache()));
    // Injection follows the actual receiver's existing overwrite policy.
    let selected_solid = decoder.decode_by_id(31).unwrap().get_ref(6).unwrap();
    let selected_opening = decoder.decode_by_id(910).unwrap().get_ref(5).unwrap();
    assert_eq!(selected_solid, 902, "authenticated cache keeps canonical selection");
    assert_eq!(selected_opening, 921);
    let imported = context.admit_authored_plan(&mut decoder).unwrap();
    assert!(!std::sync::Arc::ptr_eq(&drained, &imported));
    assert_eq!(solids(imported.plan()), [900]);
    assert_eq!(openings(imported.plan()), [(910, selected_opening)]);
    decoder.seed_unit_scales(0.001, 1.0);
    let configured = context.admit_authored_plan(&mut decoder).unwrap();
    assert!(!std::sync::Arc::ptr_eq(&imported, &configured));
    assert_eq!(configured.plan().length_unit_scale, 0.001);
    assert_eq!(imported.plan().length_unit_scale, 1.0);
}
