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

    // A real scanner/prepass can warm the first original record. Its cache is
    // authoritative for this source decoder and must not be cleared or replaced
    // by the fresh-worker last-record policy during bound admission.
    let warm_context = model.snapshot(OwnedMeshProductionData::default());
    let mut warm = source.decoder();
    prewarm_first(&mut warm, source.bytes(), 31);
    prewarm_first(&mut warm, source.bytes(), 910);
    let warm_plan = warm_context.admit_authored_plan(&mut warm).unwrap();
    assert_eq!(solids(warm_plan.plan()), [12]);
    assert_eq!(openings(warm_plan.plan()), [(910, 920)]);
    assert_eq!(warm.decode_by_id(31).unwrap().get_ref(6), Some(27));
    assert_eq!(warm.decode_by_id(910).unwrap().get_ref(5), Some(920));
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
