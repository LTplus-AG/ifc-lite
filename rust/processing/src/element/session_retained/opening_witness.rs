// SPDX-License-Identifier: MPL-2.0
//! Existing real-source regression anchors, independently evaluated exact oracle.
use super::super::{ElementJobKind, OwnedMeshProductionData, ProductionModel};
use super::*;
use crate::prepass::{resolve_prepass, PrepassSpans, ResolveOptions};
use ifc_lite_core::{EntityScanner, SourceBundle};

pub(super) const OVERLAP: &str =
    include_str!("../../../tests/fixtures/issue_2019_wall_two_overlapping_openings.ifc");
pub(super) const TRAP: &str = include_str!("../../../tests/fixtures/issue_3641_voiding_trap.ifc");
pub(super) fn context(source: &str) -> (ProductionModel, Arc<OwnedMeshProductionContext>) {
    let model = ProductionModel::from_source(SourceBundle::new(source.as_bytes().to_vec()));
    let base = model.snapshot(OwnedMeshProductionData::default());
    let mut decoder = base.source().unwrap().decoder();
    let mut spans = PrepassSpans::default();
    let mut scanner = EntityScanner::new(source);
    while let Some((id, ty, start, end)) = scanner.next_entity() {
        if ty == "IFCRELVOIDSELEMENT" {
            spans.void_rels.push((id, start, end));
        }
    }
    let prepass = resolve_prepass(&spans, &mut decoder, ResolveOptions::default());
    let context = model.snapshot(OwnedMeshProductionData {
        void_index: Arc::new(prepass.void_index),
        ..Default::default()
    });
    (model, context)
}
pub(super) fn execution(
    context: &Arc<OwnedMeshProductionContext>,
    id: u32,
    decoder: &mut EntityDecoder<'_>,
    router: &GeometryRouter,
) -> RetainedProductExecution {
    let entity = decoder.decode_by_id(id).unwrap();
    RetainedProductExecution::new(
        &ElementMeshJob {
            id,
            ifc_type: entity.ifc_type.clone(),
            entity: &entity,
            kind: ElementJobKind::Product,
            element_color: None,
            metadata: None,
        },
        context,
        &MeshProductionOptions::default(),
        decoder,
        router,
    )
    .unwrap()
}
pub(super) fn router(decoder: &mut EntityDecoder<'_>) -> GeometryRouter {
    let scale = decoder.length_unit_scale();
    let angle = decoder.plane_angle_to_radians();
    decoder.seed_unit_scales(scale, angle);
    GeometryRouter::with_scale(scale)
}
pub(super) fn exact_volume(source: &str, id: u32) -> f64 {
    let result = crate::process_geometry(source);
    let meshes: Vec<_> = result
        .meshes
        .iter()
        .filter(|mesh| mesh.express_id == id)
        .collect();
    assert!(
        !meshes.is_empty(),
        "existing exact real-source oracle must produce the host"
    );
    meshes
        .into_iter()
        .map(|mesh| {
            let mut exact = ifc_lite_geometry::Mesh::new();
            exact.positions.clone_from(&mesh.positions);
            exact.indices.clone_from(&mesh.indices);
            assert_eq!(
                ifc_lite_geometry::mesh_check::undirected_defect_count(&exact),
                0
            );
            ifc_lite_geometry::mesh_check::signed_volume(&exact).abs()
        })
        .sum()
}
pub(super) fn repeated_mapped_source() -> String {
    // A stated multiplicity invariant over the existing #2019 authored solids:
    // two distinct host item/style identities and a reused two-occurrence opening body.
    OVERLAP
        .replace("'SweptSolid',(#26)", "'SweptSolid',(#26,#126)")
        .replace("'SweptSolid',(#46)", "'MappedRepresentation',(#201,#202)")
        .replace(
            "ENDSEC;\nEND-ISO-10303-21;",
            "
#126=IFCEXTRUDEDAREASOLID(#23,#25,#4,3.);
#200=IFCREPRESENTATIONMAP(#5,#203);
#201=IFCMAPPEDITEM(#200,#205);#202=IFCMAPPEDITEM(#200,#206);
#203=IFCSHAPEREPRESENTATION(#7,'Body','SweptSolid',(#46));
#204=IFCCARTESIANPOINT((0.2,0.,0.));
#205=IFCCARTESIANTRANSFORMATIONOPERATOR3D($,$,#1,1.,$);
#206=IFCCARTESIANTRANSFORMATIONOPERATOR3D($,$,#204,1.,$);
ENDSEC;END-ISO-10303-21;",
        )
}
pub(super) fn empty_host_source() -> String {
    OVERLAP
        .replace("'SweptSolid',(#26)", "'CSG',(#110)")
        .replace("'SweptSolid',(#46)", "'SweptSolid',(#999)")
        .replace(
            "ENDSEC;\nEND-ISO-10303-21;",
            "
#110=IFCBOOLEANRESULT(.DIFFERENCE.,#26,#26);
ENDSEC;END-ISO-10303-21;",
        )
}
pub(super) fn assert_plan(execution: &RetainedProductExecution, id: u32, parts: usize, cuts: u64) {
    execution.validate_witness().unwrap();
    let plan = execution.traversal_plan().unwrap();
    assert_eq!(plan.values.len(), parts);
    let fact = plan
        .opening_completion
        .as_ref()
        .expect("original terminal void completion");
    assert_eq!(fact.product(), id);
    assert_eq!(fact.accepted_cuts(), cuts);
    assert!(!plan
        .remaining
        .contains(&ifc_lite_geometry::program::RetainedRequirement::OpeningClosure));
    for obligation in [
        ifc_lite_geometry::program::RetainedRequirement::MaterialLayers,
        ifc_lite_geometry::program::RetainedRequirement::IfcAppearance,
        ifc_lite_geometry::program::RetainedRequirement::PersistentFaces,
    ] {
        assert!(
            plan.remaining.contains(&obligation),
            "a cut never closes unrelated product work"
        );
    }
}

pub(super) fn reference_source() -> String {
    OVERLAP.replace(
        "'Body','SweptSolid',(#46)",
        "'Reference','GeometricSet',(#46)",
    )
}
