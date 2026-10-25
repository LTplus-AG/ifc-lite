// SPDX-License-Identifier: MPL-2.0
//! #7955: all actual physical-copy outputs validate before common acceptance.
use super::*;
use super::adversarial_tests::with_case;
use super::super::session_tests::SOURCE;
fn mapped() -> String {
    SOURCE.replace("#13=IFCEXTRUDEDAREASOLID", "#13=IFCMAPPEDITEM(#81,#82);#113=IFCEXTRUDEDAREASOLID")
        .replace("ENDSEC;END-ISO", "#81=IFCREPRESENTATIONMAP(#5,#83);#82=IFCCARTESIANTRANSFORMATIONOPERATOR3D($,$,#84,2.,$);#83=IFCSHAPEREPRESENTATION(#2,'Body','SweptSolid',(#113,#114));#84=IFCCARTESIANPOINT((2.,4.,6.));#114=IFCEXTRUDEDAREASOLID(#14,#5,#15,1.);ENDSEC;END-ISO")
}
#[test]
fn h2b_sdk_swapped_batch_outputs_reject_before_any_common_acceptance() {
    with_case(None, &mapped(), |execution, decoder, router, worker, _, _| {
        for _ in 0..2 {
            let issued = execution.issue_next(decoder, router, worker).unwrap().unwrap();
            let receipt = issued.execute(worker, 0.001, 15., MeshLimits::default()).unwrap();
            execution.accept(receipt, decoder, router).unwrap_or_else(|error| panic!("{}", error.reason));
        }
        let issued = execution.issue_next(decoder, router, worker).unwrap().unwrap();
        assert_eq!(issued.operations.len(), 2);
        let mut receipt = issued.execute(worker, 0.001, 15., MeshLimits::default()).unwrap();
        assert_eq!(receipt.realizations().len(), 2);
        assert!(receipt.realizations().iter().all(|value| value.construction().is_none()));
        let handles = [receipt.realizations()[0].solid(), receipt.realizations()[1].solid()];
        assert_ne!(handles[0], handles[1]);
        // #7955: source rectangles are 2 x 4 m, extruded 3 m and 1 m.
        // The authored scale is 2, so each physical copy has eight times
        // its original volume. Fix these tolerances before the SDK run.
        for (handle, depth) in handles.into_iter().zip([3., 1.]) {
            let mesh = worker.tessellate(handle, 0.001, 15., MeshLimits::default()).unwrap();
            assert_box_geometry(&mesh, [4., 8., 2. * depth], 64. * depth);
        }
        receipt.realizations.swap(0, 1);
        let mut rejected = execution.accept(receipt, decoder, router).err().unwrap();
        assert_eq!(execution.discharged_count(), 2);
        assert!(execution.pending.is_some());
        assert!(rejected.work.realizations().iter().all(|value| value.validate_live().is_ok()));
        assert_eq!([rejected.work.realizations()[0].solid(), rejected.work.realizations()[1].solid()], [handles[1], handles[0]]);
        rejected.work.realizations.swap(0, 1);
        execution.accept(rejected.work, decoder, router).unwrap_or_else(|error| panic!("{}", error.reason));
        assert_eq!(execution.discharged_count(), 4);
        assert!(execution.issue_next(decoder, router, worker).unwrap().is_none());
        execution.validate_witness().unwrap();
        assert_eq!(execution.traversal_plan().unwrap().values().len(), 2);
    });
}
#[test]
fn h2b_released_input_refuses_before_any_affine_packet_is_issued() {
    with_case(None, &mapped(), |execution, decoder, router, worker, _, _| {
        for index in 0..2 {
            let issued = execution.issue_next(decoder, router, worker).unwrap().unwrap();
            let receipt = issued.execute(worker, 0.001, 15., MeshLimits::default()).unwrap();
            let handle = receipt.realizations()[0].solid();
            execution.accept(receipt, decoder, router).unwrap_or_else(|error| panic!("{}", error.reason));
            if index == 0 { worker.release(handle).unwrap(); }
        }
        assert!(matches!(execution.issue_next(decoder, router, worker), Err(RetainedExecutionError::Runtime(_))));
        assert!(execution.pending.is_none());
        assert_eq!(execution.discharged_count(), 2);
        assert!(execution.traversal_plan().is_none());
    });
}

// An analytic source oracle, independent of receipt metadata and tessellation
// ordering. These planar boxes need no chord-dependent tolerance adjustment.
fn assert_box_geometry(mesh: &ifc_lite_geometry_runtime::TessellatedMesh, dimensions: [f64; 3], volume: f64) {
    assert!(!mesh.indices.is_empty());
    let point = |index: u32| {
        let index = index as usize * 3;
        [mesh.positions[index], mesh.positions[index + 1], mesh.positions[index + 2]]
    };
    for (axis, expected) in dimensions.into_iter().enumerate() {
        let lo = mesh.positions.chunks_exact(3).map(|p| p[axis]).fold(f64::INFINITY, f64::min);
        let hi = mesh.positions.chunks_exact(3).map(|p| p[axis]).fold(f64::NEG_INFINITY, f64::max);
        assert!((hi - lo - expected).abs() <= 1e-8, "source-derived extent on axis {axis}: {} != {expected}", hi - lo);
    }
    let origin = point(mesh.indices[0]);
    let mut six_volume = 0.;
    for triangle in mesh.indices.chunks_exact(3) {
        let [a, b, c] = [point(triangle[0]), point(triangle[1]), point(triangle[2])]
            .map(|point| std::array::from_fn::<_, 3, _>(|i| point[i] - origin[i]));
        six_volume += a[0] * (b[1] * c[2] - b[2] * c[1])
            + a[1] * (b[2] * c[0] - b[0] * c[2]) + a[2] * (b[0] * c[1] - b[1] * c[0]);
    }
    assert!((six_volume.abs() / 6. - volume).abs() <= 1e-7, "source-derived box volume: {} != {volume}", six_volume.abs() / 6.);
}

#[test]
fn h2b_sdk_identical_input_matrices_still_bind_each_receipt_to_its_issued_output() {
    let bytes = mapped().replace("'SweptSolid',(#113,#114)", "'MappedRepresentation',(#93,#93)")
        .replace("ENDSEC;END-ISO", "#91=IFCREPRESENTATIONMAP(#5,#94);#92=IFCCARTESIANTRANSFORMATIONOPERATOR3D($,$,#4,1.,$);#93=IFCMAPPEDITEM(#91,#92);#94=IFCSHAPEREPRESENTATION(#2,'Body','SweptSolid',(#113));ENDSEC;END-ISO");
    with_case(None, &bytes, |execution, decoder, router, worker, _, _| {
        let construction = execution.issue_next(decoder, router, worker).unwrap().unwrap();
        let receipt = construction.execute(worker, 0.001, 15., MeshLimits::default()).unwrap();
        execution.accept(receipt, decoder, router).unwrap_or_else(|error| panic!("{}", error.reason));
        let issued = execution.issue_next(decoder, router, worker).unwrap().unwrap();
        assert_eq!(issued.operations.len(), 2);
        let mut receipt = issued.execute(worker, 0.001, 15., MeshLimits::default()).unwrap();
        let [a, b] = receipt.realizations.as_slice() else { panic!("two physical outputs") };
        let (native_types::RealizationKind::Affine(a), native_types::RealizationKind::Affine(b)) = (&a.kind, &b.kind)
            else { panic!("affine receipts") };
        assert_eq!(a.operation_identity(), b.operation_identity(), "the numerical operations intentionally coincide");
        receipt.realizations.swap(0, 1);
        let mut rejected = execution.accept(receipt, decoder, router).err().unwrap();
        assert!(matches!(rejected.reason, RetainedExecutionError::Receipt(ReceiptFailure::ForeignRetainedOutputDefinition)));
        assert_eq!(execution.discharged_count(), 1);
        assert!(rejected.work.realizations.iter().all(|value| value.validate_live().is_ok()));
        rejected.work.realizations.swap(0, 1);
        execution.accept(rejected.work, decoder, router).unwrap_or_else(|error| panic!("{}", error.reason));
        assert!(execution.issue_next(decoder, router, worker).unwrap().is_none());
        execution.validate_witness().unwrap();
        assert_eq!(execution.traversal_plan().unwrap().values().len(), 2);
    });
}
