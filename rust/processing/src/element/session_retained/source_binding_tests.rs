// SPDX-License-Identifier: MPL-2.0
//! #7955 actual source-owner admission and consumed native correspondence.
use super::super::session_tests::SOURCE;
use super::adversarial_tests::with_case;
use super::*;
#[test]
fn j5_source_binding_original_owner_expires_even_after_real_mesh_acceptance() {
    with_case(
        None,
        SOURCE,
        |execution, decoder, router, worker, model, _| {
            worker.require_source_faces();
            let issued = execution
                .issue_next(decoder, router, worker)
                .unwrap()
                .unwrap();
            let receipt = issued
                .execute(worker, 0.001, 5., MeshLimits::default())
                .unwrap();
            let proof = receipt.realizations()[0]
                .source_correspondence()
                .unwrap()
                .unwrap();
            assert_eq!(proof.request().recipe().solid_id(), 13);
            assert_eq!(proof.roles().len(), 6);
            assert!(!proof.triangle_roots().is_empty());
            execution
                .accept(receipt, decoder, router)
                .unwrap_or_else(|e| panic!("{}", e.reason));
            assert!(execution
                .issue_next(decoder, router, worker)
                .unwrap()
                .is_none());
            execution.validate_witness().unwrap();
            model.invalidate_source();
            assert!(
                execution.validate_witness().is_err(),
                "owned source expiry invalidates consumed correspondence"
            );
        },
    );
}
#[test]
fn j5_source_binding_two_mapped_sources_keep_distinct_physical_ancestry() {
    let mapped=SOURCE.replace("#13=IFCEXTRUDEDAREASOLID","#13=IFCMAPPEDITEM(#81,#82);#113=IFCEXTRUDEDAREASOLID")
        .replace("ENDSEC;END-ISO","#81=IFCREPRESENTATIONMAP(#5,#83);#82=IFCCARTESIANTRANSFORMATIONOPERATOR3DNONUNIFORM($,$,#84,2.,$,3.,0.5);#83=IFCSHAPEREPRESENTATION(#2,'Body','SweptSolid',(#113,#114));#84=IFCCARTESIANPOINT((2.,4.,6.));#114=IFCEXTRUDEDAREASOLID(#14,#5,#15,1.);ENDSEC;END-ISO");
    check_mapped(&mapped);
    let reflected = mapped.replace("NONUNIFORM($,$,#84,2.,$,3.,0.5)",
        "NONUNIFORM(#85,#86,#84,2.,#87,3.,0.5)")
        .replace("ENDSEC;END-ISO", "#85=IFCDIRECTION((-1.,0.,0.));#86=IFCDIRECTION((0.,1.,0.));#87=IFCDIRECTION((0.,0.,1.));ENDSEC;END-ISO");
    check_mapped(&reflected);
}
fn check_mapped(mapped: &str) {
    with_case(None, mapped, |execution, decoder, router, worker, _, _| {
        worker.require_source_faces();
        let mut ids = std::collections::BTreeSet::new();
        let mut seen = 0;
        while let Some(issued) = execution.issue_next(decoder, router, worker).unwrap() {
            let receipt = issued
                .execute(worker, 0.001, 5., MeshLimits::default())
                .unwrap();
            for value in receipt.realizations() {
                let proof = value.source_correspondence().unwrap().unwrap();
                ids.insert(proof.request().recipe().solid_id());
                assert!(!proof.triangle_roots().is_empty(),
                    "J5_R1 execute receipt must consume final triangle coverage");
                assert_final_geometry(value);
                seen += 1;
            }
            execution
                .accept(receipt, decoder, router)
                .unwrap_or_else(|e| panic!("{}", e.reason));
        }
        assert_eq!(ids, std::collections::BTreeSet::from([113, 114]));
        assert!(seen >= 4);
        execution.validate_witness().unwrap();
    });
}

fn assert_final_geometry(value: &CommonRetainedRealization) {
    use ifc_lite_geometry::document::retained_source::ConstructionRole;
    use super::native_types::RealizationKind;
    let proof = value.source_correspondence().unwrap().unwrap();
    let (positions, indices, transform) = match &value.kind {
        RealizationKind::Construction(value) => {
            let mesh = &value.completion().tessellation;
            (&mesh.positions, &mesh.indices, None)
        }
        RealizationKind::Affine(value) => {
            let mesh = value.source_mesh().expect("J5_R1 execute owns final affine mesh");
            (&mesh.positions, &mesh.indices, Some(value.operation_identity().column_major))
        }
        _ => panic!("unexpected source fixture operation"),
    };
    assert_eq!(indices.len()/3, proof.triangle_roots().len());
    let recipe = &proof.request().payload().bytes;
    let scalar = |offset| f64::from_le_bytes(recipe[offset..offset+8].try_into().unwrap());
    for (triangle, &root) in indices.chunks_exact(3).zip(proof.triangle_roots()) {
        for &vertex in triangle {
            let mut p = [positions[vertex as usize*3],positions[vertex as usize*3+1],positions[vertex as usize*3+2]];
            if let Some(matrix) = transform {
                for i in [1,2,4,6,8,9] { assert_eq!(matrix[i],0.); }
                for axis in 0..3 { p[axis]=(p[axis]-matrix[12+axis])/matrix[axis*5]; }
            }
            let residual = match proof.roles()[root as usize] {
                ConstructionRole::StartCap => p[2],
                ConstructionRole::EndCap => p[2]-scalar(40),
                ConstructionRole::SweptSegment(n) => {
                    let at=64+n as usize*104;
                    let (ax,ay,bx,by)=(scalar(at),scalar(at+8),scalar(at+24),scalar(at+32));
                    ((p[0]-ax)*(by-ay)-(p[1]-ay)*(bx-ax))/(bx-ax).hypot(by-ay)
                }
            };
            assert!(residual.abs()<=1e-9,"J5_R1 production triangle matches original role");
        }
    }
}
