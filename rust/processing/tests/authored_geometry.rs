// SPDX-License-Identifier: MPL-2.0
//! authored planning preserves source identity without claiming net solids.

use std::collections::HashSet;
use ifc_lite_geometry::analytic::{AnalyticStatus, ProfileLoopKind};
use ifc_lite_processing::authored_geometry::{plan_authored_geometry, AuthoredConstruction,
    AuthoredDefinition, AuthoredEvaluationContract, EvaluationRequirement};
use ifc_lite_processing::AnalyticSourceContext;
use ifc_lite_testkit::fixture_bytes;

const MAPPED: &str = include_str!("../../geometry/tests/fixtures/mapped_instances_synthetic.ifc");
const DISK: &str = include_str!("../../geometry/tests/fixtures/swept_disk_trimmed_line.ifc");

#[test]
fn mapped_millimetre_recipes_share_raw_source_and_keep_distinct_world_frames() {
    let model = MAPPED.replace("#3=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);",
        "#3=IFCSIUNIT(*,.LENGTHUNIT.,.MILLI.,.METRE.);");
    let plan = plan_authored_geometry(model.as_bytes(), Some(&HashSet::from([31, 38])));
    assert!(plan.diagnostics.is_empty(), "{:?}", plan.diagnostics);
    assert_eq!(plan.definitions.len(), 1);
    let AuthoredDefinition::Extrusion(source) = &plan.definitions[0] else { panic!("extrusion") };
    assert_eq!(source.source.depth, Some(1.0));
    assert_eq!(source.source.profile.as_ref().unwrap().loops[0].signed_area, 1.0);
    assert!(matches!(&source.key.context, AnalyticSourceContext::Mapped {
        representation_map_path } if representation_map_path == &[16]));
    assert_eq!(plan.length_unit_scale, 0.001);
    assert_eq!(plan.recipes.len(), 2);
    assert_eq!(plan.recipes[0].source, plan.recipes[1].source);
    assert_eq!(plan.recipes[1].construction, AuthoredConstruction::Extrusion);
    assert_eq!(plan.recipes[1].contract, AuthoredEvaluationContract::AuthoredSourceOnly);
    let second = plan.recipes.iter().find(|recipe| recipe.product_id == 38).unwrap();
    assert!((second.world_from_source[12] - 0.003).abs() < 1e-15);
    assert!((second.world_from_source[0] - 0.001).abs() < 1e-15);
    for product in plan.products.values() {
        assert_eq!(product.requirements, [EvaluationRequirement::RepresentationCoverageUnverified]);
    }
}

#[test]
fn swept_disk_recipe_keeps_raw_radius_and_mapped_occurrence() {
    let plan = plan_authored_geometry(DISK.as_bytes(), Some(&HashSet::from([50])));
    assert!(plan.diagnostics.is_empty(), "{:?}", plan.diagnostics);
    let AuthoredDefinition::SweptDisk(source) = &plan.definitions[0] else { panic!("disk") };
    assert_eq!(source.radius, 14.5);
    assert_eq!(source.status, AnalyticStatus::Complete);
    assert_eq!(plan.recipes[0].construction, AuthoredConstruction::SweptDisk);
    assert_eq!(plan.products[&50].occurrences[0].mapping_path, [47]);
    assert!((plan.recipes[0].world_from_source[0] - 0.001).abs() < 1e-15);
}

#[test]
fn unknown_source_family_and_nonuniform_disk_are_explicitly_unresolved() {
    let unsupported = MAPPED.replace("#12=IFCEXTRUDEDAREASOLID(#8,#11,#9,1.0);",
        "#12=IFCBLOCK(#11,1.,1.,1.);");
    let plan = plan_authored_geometry(unsupported.as_bytes(), Some(&HashSet::from([31])));
    assert!(plan.definitions.is_empty() && plan.recipes.is_empty());
    assert!(plan.products[&31].requirements.contains(&EvaluationRequirement::NoSupportedAuthoredSources));

    let nonuniform = DISK.replace("#46=IFCCARTESIANTRANSFORMATIONOPERATOR3D($,$,#10,$,$);",
        "#46=IFCCARTESIANTRANSFORMATIONOPERATOR3DNONUNIFORM($,$,#10,$,$,2.,1.);");
    let plan = plan_authored_geometry(nonuniform.as_bytes(), Some(&HashSet::from([50])));
    assert_eq!(plan.definitions.len(), 1);
    assert!(plan.recipes.is_empty(), "usable source does not imply usable occurrence");
    assert!(plan.products[&50].occurrences[0].world_from_source.is_some());
    assert!(plan.products[&50].requirements.iter().any(|requirement| matches!(requirement,
        EvaluationRequirement::UnsupportedSource { .. })));
}

#[test]
fn repeated_boolean_operands_are_source_recipes_and_require_evaluation() {
    let model = MAPPED.replace("#13=IFCSHAPEREPRESENTATION(#5,'Body','SweptSolid',(#12));",
        "#500=IFCBOOLEANRESULT(.DIFFERENCE.,#12,#12);\n#13=IFCSHAPEREPRESENTATION(#5,'Body','SolidModel',(#500));");
    let plan = plan_authored_geometry(model.as_bytes(), Some(&HashSet::from([31])));
    assert_eq!(plan.definitions.len(), 1);
    assert_eq!(plan.recipes.len(), 2, "path multiplicity must be preserved");
    assert_eq!(plan.recipes[0].source, plan.recipes[1].source);
    assert_ne!(plan.recipes[0].source_ordinal, plan.recipes[1].source_ordinal);
    assert!(plan.products[&31].occurrences.iter().all(|source| source.source_modified));
    assert!(plan.products[&31].requirements.contains(&EvaluationRequirement::EnclosingBoolean { solid_id: 12 }));
    assert!(plan.recipes.iter().all(|recipe| recipe.contract == AuthoredEvaluationContract::AuthoredSourceOnly));
}

#[test]
fn external_opening_is_dependency_even_when_authored_source_is_complete() {
    let model = MAPPED.replace("ENDSEC;\nEND-ISO-10303-21;",
        "#900=IFCOPENINGELEMENT('opening',$,$,$,$,#30,#27,$,.OPENING.);\n#901=IFCRELVOIDSELEMENT('void',$,$,$,#31,#900);\nENDSEC;\nEND-ISO-10303-21;");
    let plan = plan_authored_geometry(model.as_bytes(), Some(&HashSet::from([31])));
    assert_eq!(plan.recipes.len(), 1);
    assert!(!plan.products[&31].occurrences[0].source_modified,
        "external void relationship must not be confused with boolean ancestry");
    assert!(plan.products[&31].requirements.contains(&EvaluationRequirement::ExternalOpening {
        relationship_id: 901, opening_id: 900 }));
}

#[test]
fn unsupported_and_unavailable_products_remain_reported() {
    let model = MAPPED.replace("#12=IFCEXTRUDEDAREASOLID(#8,#11,#9,1.0);",
        "#12=IFCEXTRUDEDAREASOLIDTAPERED(#8,#11,#9,1.0,#8);");
    let plan = plan_authored_geometry(model.as_bytes(), Some(&HashSet::from([31, 99999])));
    assert_eq!(plan.definitions.len(), 1);
    assert!(plan.recipes.is_empty());
    assert_eq!(plan.products[&31].occurrences.len(), 1);
    assert!(plan.products[&31].requirements.iter().any(|requirement| matches!(requirement,
        EvaluationRequirement::UnsupportedSource { reason, .. } if reason.contains("tapered"))));
    assert!(plan.products[&99999].requirements.contains(&EvaluationRequirement::RequestedProductUnavailable));
    assert!(plan.products[&99999].requirements.contains(&EvaluationRequirement::NoSupportedAuthoredSources));
    let empty = plan_authored_geometry(model.as_bytes(), Some(&HashSet::new()));
    assert!(empty.products.is_empty() && empty.recipes.is_empty() && empty.definitions.is_empty());
}

#[test]
fn arbitrary_profile_holes_remain_exact_boundaries_in_authored_recipe() {
    let model = MAPPED.replace("#8=IFCRECTANGLEPROFILEDEF(.AREA.,$,#7,1.0,1.0);",
        "#8=IFCARBITRARYPROFILEDEFWITHVOIDS(.AREA.,$,#904,(#909));\n\
         #900=IFCCARTESIANPOINT((-2.,-2.));\n#901=IFCCARTESIANPOINT((2.,-2.));\n\
         #902=IFCCARTESIANPOINT((2.,2.));\n#903=IFCCARTESIANPOINT((-2.,2.));\n\
         #904=IFCPOLYLINE((#900,#901,#902,#903,#900));\n\
         #905=IFCCARTESIANPOINT((-1.,-1.));\n#906=IFCCARTESIANPOINT((-1.,1.));\n\
         #907=IFCCARTESIANPOINT((1.,1.));\n#908=IFCCARTESIANPOINT((1.,-1.));\n\
         #909=IFCPOLYLINE((#905,#906,#907,#908,#905));");
    let plan = plan_authored_geometry(model.as_bytes(), Some(&HashSet::from([31])));
    assert_eq!(plan.recipes.len(), 1, "{:?}", plan.products[&31].requirements);
    let AuthoredDefinition::Extrusion(source) = &plan.definitions[0] else { panic!("extrusion") };
    let profile = source.source.profile.as_ref().unwrap();
    assert_eq!(profile.loops.len(), 2);
    assert_eq!(profile.loops[0].kind, ProfileLoopKind::Outer);
    assert_eq!(profile.loops[1].kind, ProfileLoopKind::Inner);
    assert_eq!(source.nominal_quantities.as_ref().unwrap().nominal_volume, 12.0);
}

#[test]
fn malformed_relationship_and_source_do_not_publish_complete_product() {
    let model = DISK.replace("#43=IFCSWEPTDISKSOLID(#42,14.5,$,0.,2750.);",
        "#43=IFCSWEPTDISKSOLID(#42,-1.,$,0.,2750.);")
        .replace("ENDSEC;\nEND-ISO-10303-21;",
            "#901=IFCRELVOIDSELEMENT('void',$,$,$,#50,$);\nENDSEC;\nEND-ISO-10303-21;");
    let plan = plan_authored_geometry(model.as_bytes(), Some(&HashSet::from([50])));
    assert!(plan.recipes.is_empty());
    assert!(!plan.diagnostics.is_empty());
    assert!(plan.products[&50].requirements.contains(&EvaluationRequirement::OpeningRelationshipsUnverified));
    assert!(plan.products[&50].requirements.contains(&EvaluationRequirement::NoSupportedAuthoredSources));
}

#[test]
fn real_authoring_corpus_has_explicit_partial_coverage() {
    let Some(bytes) = fixture_bytes("ara3d/AC20-FZK-Haus.ifc") else { return };
    let plan = plan_authored_geometry(&bytes, None);
    assert!(!plan.definitions.is_empty());
    assert!(!plan.products.is_empty());
    assert!(plan.products.values().all(|product| product.requirements.contains(
        &EvaluationRequirement::RepresentationCoverageUnverified)));
    assert!(plan.products.values().any(|product| product.requirements.iter().any(|requirement|
        matches!(requirement, EvaluationRequirement::ExternalOpening { .. }))));
}
