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
    with_case(None, &mapped, |execution, decoder, router, worker, _, _| {
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
                let mesh = worker
                    .tessellate(value.solid(), 0.001, 5., MeshLimits::default())
                    .unwrap();
                assert!(mesh
                    .source_correspondence
                    .as_ref()
                    .unwrap()
                    .same_source(proof));
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
