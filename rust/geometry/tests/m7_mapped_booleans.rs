// SPDX-License-Identifier: MPL-2.0
#![cfg(feature = "retained-runtime")]
//! #7955 M7: source traversal only; no fabricated kernel receipts or meshes.
use ifc_lite_core::SourceBundle;
use ifc_lite_geometry::{
    program::transactions::{Operation, OperationKind, Plan, TransactionError, Traversal},
    GeometryRouter,
};
const SOURCE: &str =
    include_str!("../../../tests/fixtures/synthetic-retained/f-e-mapped-booleans.ifc");

fn walk(id: u32) -> (Vec<Operation>, Result<Plan, TransactionError>) {
    let text = if id == 242 {
        include_str!(
            "../../../tests/fixtures/synthetic-retained/f-e-mapped-booleans-adversarial.ifc"
        )
    } else {
        SOURCE
    };
    walk_text(text, id)
}
fn walk_text(text: &str, id: u32) -> (Vec<Operation>, Result<Plan, TransactionError>) {
    let source = SourceBundle::new(text.as_bytes().to_vec());
    let mut decoder = source.decoder();
    let router = GeometryRouter::with_units(text, &mut decoder);
    let entity = decoder.decode_by_id(id).unwrap();
    let traversal = Traversal::new(7, 7);
    let mut program = traversal.product_parts(&entity);
    let mut observed = Vec::new();
    loop {
        let ticket = match program.request() {
            Ok(Some(ticket)) => ticket,
            Ok(None) => break,
            Err(_) => return (observed, program.finish()),
        };
        let (reply, operations, _storage) = match program.admit(ticket, &router, &mut decoder) {
            Ok(admission) => admission,
            Err(_) => return (observed, program.finish()),
        };
        for op in &operations {
            // Logical nonempty annotation only; never used as numerical evidence.
            op.bind_numerical_outcome(false).unwrap();
        }
        observed.extend(operations);
        if program.accept(reply, &router).is_err() {
            return (observed, program.finish());
        }
    }
    (observed, program.finish())
}

#[test]
fn m7_e5_cached_boolean_runs_once_for_two_occurrences() {
    let (ops, plan) = walk(78);
    let plan = plan.unwrap();
    assert_eq!(
        ops.len(),
        3,
        "two constructions + one Boolean, despite two mapped occurrences"
    );
    assert!(matches!(ops[0].kind(), OperationKind::Construction(_)));
    assert!(matches!(ops[1].kind(), OperationKind::Construction(_)));
    assert!(matches!(ops[2].kind(), OperationKind::Boolean { .. }));
    let values: Vec<_> = plan.values().collect();
    assert_eq!(values.len(), 2);
    assert_eq!(values[0].definition(), values[1].definition());
    assert_ne!(values[0].slot(), values[1].slot());
    assert_eq!(&values[0].object_frame()[12..15], &[0., 0., 0.]);
    assert_eq!(&values[1].object_frame()[12..15], &[4., 0., 0.]);
}

#[test]
fn m7_e1_e2_boolean_is_placed_once_after_evaluation() {
    for (id, angle) in [(38, 0_f64), (46, std::f64::consts::PI / 6.)] {
        let (ops, plan) = walk(id);
        assert_eq!(ops.len(), 3);
        assert!(matches!(ops[2].kind(), OperationKind::Boolean { .. }));
        let plan = plan.unwrap();
        let value = plan.values().next().unwrap();
        assert_eq!(value.definition(), ops[2].value().definition());
        // Target * inverse(identity MappingOrigin) * identity product placement.
        let (s, c) = angle.sin_cos();
        let expected = [c, s, 0., 0., -s, c, 0., 0., 0., 0., 1., 0., 0., 0., 0., 1.];
        for (a, e) in value.object_frame().iter().zip(expected) {
            assert!((a - e).abs() < 1e-14, "frame {a} != {e}");
        }
    }
}

#[test]
fn m7_e9_e10_final_affine_remains_an_explicit_boundary() {
    for id in [133, 141] {
        let (ops, plan) = walk(id);
        let final_op = ops.last().unwrap();
        assert!(matches!(final_op.kind(), OperationKind::Affine { .. }));
        assert_eq!(
            plan.unwrap().values().next().unwrap().definition(),
            final_op.value().definition()
        );
    }
}

#[test]
fn m7_e17_multi_solid_operand_refuses_without_partial_plan() {
    let (ops, plan) = walk(242);
    assert!(!ops.is_empty(), "provisional leaf operations were reached");
    let error = match plan {
        Err(e) => e,
        Ok(_) => panic!("multi-solid operand published a plan"),
    };
    assert_eq!(
        error.kind(),
        ifc_lite_geometry::program::transactions::TransactionFailureKind::Source
    );
}

#[test]
fn m7_e11_m5_plain_halfspace_composes_with_mapping() {
    // #7955: M5 admits this mapped clip through the same three operations as
    // an unmapped host: source construction, finite prism, Difference.
    let (ops, plan) = walk(156);
    assert_eq!(ops.len(), 3);
    assert!(matches!(ops[0].kind(), OperationKind::Construction(_)));
    assert!(matches!(ops[1].kind(), OperationKind::Construction(_)));
    assert!(matches!(ops[2].kind(), OperationKind::Boolean { .. }));
    let plan = plan.unwrap();
    let values: Vec<_> = plan.values().collect();
    assert_eq!(values.len(), 1);
    assert_eq!(values[0].definition(), ops[2].value().definition());
}
