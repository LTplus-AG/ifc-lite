// SPDX-License-Identifier: MPL-2.0
#![cfg(feature = "retained-runtime")]
//! #7955 M3-A: logical sequencing witnesses; no numerical receipts are fabricated.
use ifc_lite_core::{EntityDecoder, SourceBundle};
use ifc_lite_geometry::{program::transactions::{OperationKind, Plan, Program, Requirement, Traversal,
    TransactionFailureKind}, BoolOp, GeometryRouter};
#[path = "support/m3_opening_fixtures.rs"]
mod fixtures;
const ISSUE: &str = include_str!("../../processing/tests/fixtures/issue_2019_wall_two_overlapping_openings.ifc");

fn body(mut program: Program<'_>, router: &GeometryRouter, decoder: &mut EntityDecoder) -> Plan {
    while let Some(ticket) = program.request().unwrap() {
        let (reply, operations, _storage) = program.admit(ticket, router, decoder).unwrap();
        for op in operations { op.bind_numerical_outcome(false).unwrap(); }
        program.accept(reply, router).unwrap_or_else(|e| panic!("{:?}", e.error));
    }
    program.finish().unwrap()
}
#[test]
fn issue_7955_openings_cut_in_order_with_host_as_left_and_discharge_closure() {
    let source = SourceBundle::new(ISSUE.as_bytes().to_vec());
    let mut decoder = source.decoder();
    let router = GeometryRouter::with_units(ISSUE, &mut decoder);
    let traversal = Traversal::new(1, 1);
    let host_entity = decoder.decode_by_id(30).unwrap();
    let host = body(traversal.product_parts(&host_entity), &router, &mut decoder);
    for id in [46, 66, 96] { assert!(decoder.get_cached(id).is_none(), "opening source #{id} decoded before host completion"); }
    let mut left = host.values().next().unwrap().slot();
    let host_frame = *host.values().next().unwrap().object_frame();
    let mut cutters = Vec::new();
    let mut right = Vec::new();
    for id in [50, 70, 100] {
        let entity = decoder.decode_by_id(id).unwrap();
        let plan = body(traversal.opening_body(&entity), &router, &mut decoder);
        right.push(plan.values().next().unwrap().slot());
        cutters.push((id, plan));
    }
    let mut cuts = traversal.opening_cuts(host, cutters).unwrap();
    let mut observed = Vec::new();
    while let Some(ticket) = cuts.request().unwrap() {
        let (reply, operations, _storage) = cuts.admit(ticket, &router, &mut decoder).unwrap();
        assert_eq!(operations.len(), 1);
        let op = &operations[0];
        let OperationKind::Boolean { inputs, operation } = op.kind() else { panic!("Difference required") };
        assert_eq!(operation, BoolOp::Difference);
        assert_eq!(inputs[0].slot(), left);
        assert_ne!(inputs[0].slot(), inputs[1].slot());
        assert_eq!(inputs[1].slot(), right[observed.len()]);
        assert_eq!(*op.value().object_frame(), host_frame);
        observed.push(op.opening().unwrap());
        left = op.value().slot();
        op.bind_numerical_outcome(false).unwrap();
        cuts.accept(reply, &router).unwrap_or_else(|e| panic!("{:?}", e.error));
    }
    assert_eq!(observed, [(50, 0, 0), (70, 1, 0), (100, 2, 0)]);
    let plan = cuts.finish().unwrap();
    assert_eq!(plan.opening(), Some((3, 3, 0)));
    assert_eq!(plan.requirements().collect::<Vec<_>>(), [Requirement::MaterialLayers, Requirement::IfcAppearance, Requirement::PersistentFaces]);
}

fn mapped_source() -> String {
    ISSUE.replace("#47= IFCSHAPEREPRESENTATION(#7,'Body','SweptSolid',(#46));", "#47= IFCSHAPEREPRESENTATION(#7,'Body','MappedRepresentation',(#203));\n#201=IFCSHAPEREPRESENTATION(#7,'Body','SweptSolid',(#46,#66));\n#202=IFCREPRESENTATIONMAP(#5,#201);\n#204=IFCCARTESIANTRANSFORMATIONOPERATOR3D($,$,#1,1.,$);\n#203=IFCMAPPEDITEM(#202,#204);")
}
fn with_cuts(text: &str, run: impl FnOnce(Program<'static>, &GeometryRouter, &mut EntityDecoder)) {
    let source = SourceBundle::new(text.as_bytes().to_vec());
    let mut decoder = source.decoder();
    let router = GeometryRouter::with_units(text, &mut decoder);
    let traversal = Traversal::new(1, 1);
    let entity = decoder.decode_by_id(30).unwrap();
    let host = body(traversal.product_parts(&entity), &router, &mut decoder);
    let entity = decoder.decode_by_id(50).unwrap();
    let cutter = body(traversal.opening_body(&entity), &router, &mut decoder);
    run(traversal.opening_cuts(host, vec![(50, cutter)]).unwrap(), &router, &mut decoder);
}
#[test]
fn issue_7955_mapped_cutter_cuts_every_value_separately() {
    with_cuts(&mapped_source(), |mut cuts, router, decoder| {
        let mut observed = Vec::new();
        while let Some(ticket) = cuts.request().unwrap() {
            let (reply, operations, _storage) = cuts.admit(ticket, router, decoder).unwrap();
            assert_eq!(operations.len(), 1);
            observed.push(operations[0].opening().unwrap());
            operations[0].bind_numerical_outcome(false).unwrap();
            cuts.accept(reply, router).unwrap_or_else(|e| panic!("{:?}", e.error));
        }
        assert_eq!(observed, [(50, 0, 0), (50, 0, 1)]);
        assert_eq!(cuts.finish().unwrap().opening(), Some((1, 2, 0)));
    });
}
#[test]
fn issue_7955_consumed_part_stops_cuts_and_refuses_empty_result() {
    with_cuts(&mapped_source(), |mut cuts, router, decoder| {
        let ticket = cuts.request().unwrap().unwrap();
        let (reply, operations, _storage) = cuts.admit(ticket, router, decoder).unwrap();
        operations[0].bind_numerical_outcome(true).unwrap();
        assert_eq!(cuts.accept(reply, router).err().unwrap().error.kind(), TransactionFailureKind::Empty);
        assert!(cuts.request().unwrap().is_none(), "a consumed part must issue no more cuts");
        let error = cuts.finish().err().unwrap();
        assert_eq!(error.kind(), TransactionFailureKind::Empty);
        assert_eq!(error.origin_view(), Some(("opening_cut", Some(50), "consumed")));
    });
}
#[test]
fn issue_7955_foreign_reply_and_unbound_cut_cannot_advance() {
    with_cuts(ISSUE, |mut cuts, router, decoder| {
        let ticket = cuts.request().unwrap().unwrap();
        let (reply, operations, _storage) = cuts.admit(ticket, router, decoder).unwrap();
        let rejected = cuts.accept(reply, router).err().unwrap();
        assert_eq!(rejected.error.kind(), TransactionFailureKind::NotExecuted);
        let entity = decoder.decode_by_id(50).unwrap();
        let mut foreign = Traversal::new(1, 1).opening_body(&entity);
        let foreign_ticket = foreign.request().unwrap().unwrap();
        assert_eq!(cuts.validate_ticket(foreign_ticket).unwrap_err().kind(), TransactionFailureKind::StaleRequest);
        let (foreign_reply, _, _storage) = foreign.admit(foreign_ticket, router, decoder).unwrap();
        assert_eq!(cuts.accept(foreign_reply, router).err().unwrap().error.kind(), TransactionFailureKind::WrongPayload);
        operations[0].bind_numerical_outcome(false).unwrap();
        cuts.accept(rejected.into_reply(), router).unwrap_or_else(|e| panic!("{:?}", e.error));
        assert!(cuts.request().unwrap().is_none());
        assert_eq!(cuts.finish().unwrap().opening(), Some((1, 1, 0)));
    });
}
#[test]
fn issue_7955_cancel_before_cut_admission_is_terminal() {
    with_cuts(ISSUE, |mut cuts, _, _| {
        cuts.cancel();
        assert_eq!(cuts.request().unwrap_err().original_stop(), Some(ifc_lite_geometry::resource::ProgramStop::Cancelled));
        assert_eq!(cuts.finish().err().unwrap().original_stop(), Some(ifc_lite_geometry::resource::ProgramStop::Cancelled));
    });
}
#[test]
fn issue_7955_foreign_traversal_cutter_is_refused() {
    let source = SourceBundle::new(ISSUE.as_bytes().to_vec());
    let mut decoder = source.decoder();
    let router = GeometryRouter::with_units(ISSUE, &mut decoder);
    let traversal = Traversal::new(1, 1);
    let entity = decoder.decode_by_id(30).unwrap();
    let host = body(traversal.product_parts(&entity), &router, &mut decoder);
    let entity = decoder.decode_by_id(50).unwrap();
    let cutter = body(Traversal::new(1, 1).opening_body(&entity), &router, &mut decoder);
    let error = traversal.opening_cuts(host, vec![(50, cutter)]).err().unwrap();
    assert_eq!(error.kind(), TransactionFailureKind::OperationUnsupported);
}

// #7955 M3-A round-2 ruling: baked affine cutters use M1 Boolean admission.
// This checks admission only; the native/wasm witnesses check numerical results.
#[test]
fn issue_7955_scaled_mapped_cutter_uses_m1_baked_affine_admission() {
    let text = include_str!("../../../tests/fixtures/synthetic-retained/f-d-openings.ifc");
    let source = SourceBundle::new(text.as_bytes().to_vec());
    let mut decoder = source.decoder();
    let router = GeometryRouter::with_units(text, &mut decoder);
    let traversal = Traversal::new(1, 1);
    let entity = decoder.decode_by_id(203).unwrap();
    let host = body(traversal.product_parts(&entity), &router, &mut decoder);
    let entity = decoder.decode_by_id(214).unwrap();
    let cutter = body(traversal.opening_body(&entity), &router, &mut decoder);
    let mut cuts = traversal.opening_cuts(host, vec![(214, cutter)]).unwrap();
    let mut admitted = 0;
    while let Some(ticket) = cuts.request().unwrap() {
        let (reply, operations, _storage) = cuts.admit(ticket, &router, &mut decoder).unwrap();
        admitted += operations.len();
        for operation in operations {
            assert!(matches!(operation.kind(), OperationKind::Boolean { operation: BoolOp::Difference, .. }));
            assert_eq!(operation.opening(), Some((214, 0, 0)));
            operation.bind_numerical_outcome(false).unwrap();
        }
        cuts.accept(reply, &router).unwrap_or_else(|e| panic!("{:?}", e.error));
    }
    assert_eq!(admitted, 1);
    assert_eq!(cuts.finish().unwrap().opening(), Some((1, 1, 0)));
}

#[test]
fn issue_7955_nonbakeable_scaled_cutter_keeps_m1_source_refusal() {
    // Finite positive nonuniform scales whose determinant overflows f64.
    // M1 cannot certify this affine; ordinary nonuniform scales are supported.
    let text = include_str!("../../../tests/fixtures/synthetic-retained/f-d-openings.ifc")
        .replace("OPERATOR3D($,$,#1,2.,$)", "OPERATOR3DNONUNIFORM($,$,#1,1.E200,$,1.E200,1.)");
    let source = SourceBundle::new(text.as_bytes().to_vec());
    let mut decoder = source.decoder();
    let router = GeometryRouter::with_units(&text, &mut decoder);
    let entity = decoder.decode_by_id(214).unwrap();
    for opening in [false, true] {
        let traversal = Traversal::new(1, 1);
        let mut program = if opening { traversal.opening_body(&entity) } else { traversal.product_parts(&entity) };
        while let Some(ticket) = program.request().unwrap() {
            let (reply, operations, _storage) = program.admit(ticket, &router, &mut decoder).unwrap();
            assert!(operations.is_empty(), "nonbakeable mapping must fail before construction");
            program.accept(reply, &router).unwrap_or_else(|e| panic!("{:?}", e.error));
        }
        let failure = program.finish().err().expect("M1 source refusal required");
        assert_eq!(failure.kind(), TransactionFailureKind::Source);
        assert_eq!(failure.origin_view(), Some(("mapping_placement", Some(211), "value")));
    }
}

#[test]
fn issue_7955_cancelled_host_never_decodes_opening_source() {
    let source = SourceBundle::new(ISSUE.as_bytes().to_vec());
    let mut decoder = source.decoder();
    let entity = decoder.decode_by_id(30).unwrap();
    let mut program = Traversal::new(1, 1).product_parts(&entity);
    use ifc_lite_geometry::resource::{ExecutionAccount, ExecutionPolicy, ProgramStop, ResourceLimits};
    let account = ExecutionAccount::new(ExecutionPolicy::Bounded(ResourceLimits::default()));
    account.cancel();
    let error = account.scope(|| program.request()).unwrap_err();
    assert_eq!(error.original_stop(), Some(ProgramStop::Cancelled));
    for id in [50, 46, 70, 66, 100, 96] { assert!(decoder.get_cached(id).is_none()); }
}

#[test]
fn issue_7955_cut_occurrence_budget_is_shared_and_terminal() {
    with_cuts(ISSUE, |mut cuts, router, decoder| {
        use ifc_lite_geometry::resource::{ExecutionAccount, ExecutionPolicy, ResourceLimits};
        let ticket = cuts.request().unwrap().unwrap();
        let account = ExecutionAccount::new(ExecutionPolicy::Bounded(ResourceLimits {
            occurrences: Some(0), ..Default::default()
        }));
        let admission = account.scope(|| cuts.admit(ticket, router, decoder));
        assert!(admission.is_err());
        assert!(matches!(cuts.finish().err().unwrap().original_stop(), Some(ifc_lite_geometry::resource::ProgramStop::ResourceRefused(_))));
    });
}

#[test]
fn issue_7955_two_parts_receive_both_openings_in_order() {
    let text = fixtures::two_parts_two_openings();
    let source = SourceBundle::new(text.as_bytes().to_vec());
    let mut decoder = source.decoder();
    let router = GeometryRouter::with_units(&text, &mut decoder);
    let traversal = Traversal::new(1, 1);
    let entity = decoder.decode_by_id(30).unwrap();
    let host = body(traversal.product_parts(&entity), &router, &mut decoder);
    let original: Vec<_> = host.values().map(|v| v.slot()).collect();
    assert_eq!(original.len(), 2);
    let mut left = original.clone();
    let mut right = Vec::new();
    let mut cutters = Vec::new();
    for id in [50, 70] {
        let entity = decoder.decode_by_id(id).unwrap();
        let plan = body(traversal.opening_body(&entity), &router, &mut decoder);
        assert_eq!(plan.values().len(), 1);
        right.push(plan.values().next().unwrap().slot());
        cutters.push((id, plan));
    }
    let mut cuts = traversal.opening_cuts(host, cutters).unwrap();
    let mut issued = Vec::new();
    while let Some(ticket) = cuts.request().unwrap() {
        let (reply, operations, _storage) = cuts.admit(ticket, &router, &mut decoder).unwrap();
        assert_eq!(operations.len(), 1);
        let op = &operations[0];
        let OperationKind::Boolean { inputs, operation } = op.kind() else { panic!("Difference required") };
        assert_eq!(operation, BoolOp::Difference);
        let part = left.iter().position(|slot| *slot == inputs[0].slot()).expect("current host part as left");
        let opening = right.iter().position(|slot| *slot == inputs[1].slot()).expect("opening as right");
        assert_eq!(op.opening(), Some(([50, 70][opening], opening, 0)));
        issued.push((part, [50, 70][opening]));
        left[part] = op.value().slot();
        op.bind_numerical_outcome(false).unwrap();
        cuts.accept(reply, &router).unwrap_or_else(|e| panic!("{:?}", e.error));
    }
    assert_eq!(issued, [(0, 50), (0, 70), (1, 50), (1, 70)]);
    let plan = cuts.finish().unwrap();
    assert_eq!(plan.opening(), Some((2, 4, 0)));
    assert_eq!(plan.values().map(|v| v.slot()).collect::<Vec<_>>(), left);
    for (final_slot, original_slot) in left.iter().zip(original) {
        assert_ne!(*final_slot, original_slot, "every published part must be a cut result");
    }
}
