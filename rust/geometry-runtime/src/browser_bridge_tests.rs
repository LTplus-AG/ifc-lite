// SPDX-License-Identifier: MPL-2.0
//! Actual browser Worker cancellation; requires staged canonical /smlib assets.
use super::*;
use ifc_lite_core::{build_entity_index, EntityDecoder};
use ifc_lite_geometry::{
    analytic::extract_analytic_extrusion,
    document::{EvaluationContract, GeometryDocument, RetainedExtrusion},
};
use std::{
    future::Future,
    task::{Context, Poll, Waker},
};
use wasm_bindgen_test::*;
wasm_bindgen_test_configure!(run_in_browser);

#[wasm_bindgen_test(async)]
async fn abandoned_commit_future_retires_actual_worker_without_killing_replacement() {
    let mut worker = BrowserWorker::new().unwrap();
    // The full actual SDK witness ensures this captured module Worker exists
    // before cancellation, rather than cancelling an unstarted import.
    worker.qualify().await.unwrap();
    let input = b"#1=IFCCARTESIANPOINT((0.,0.));#2=IFCAXIS2PLACEMENT2D(#1,$);#3=IFCRECTANGLEPROFILEDEF(.AREA.,$,#2,1.,1.);#4=IFCDIRECTION((0.,0.,1.));#5=IFCEXTRUDEDAREASOLID(#3,$,#4,1.);";
    let mut decoder = EntityDecoder::with_index(input, build_entity_index(input));
    let entity = decoder.decode_by_id(5).unwrap();
    let mut document = GeometryDocument::new();
    let definition = document
        .add_retained_extrusion(RetainedExtrusion {
            source: extract_analytic_extrusion(&entity, &mut decoder),
            length_unit_scale: 1.,
            source_epoch: 1,
            source_revision: 1,
        })
        .unwrap();
    let request = document
        .prepare_retained_extrusion(
            definition,
            EvaluationContract::RetainedBrep,
            worker.incarnation(),
        )
        .unwrap();
    let owner = worker.owner.clone();
    let submitted = owner.driver.next_dispatch(15); // actual staged sweep commit
    let mut future = Box::pin(worker.evaluate(request, 0.001, 5., 1024 * 1024));
    let mut context = Context::from_waker(Waker::noop());
    assert!(matches!(future.as_mut().poll(&mut context), Poll::Pending));
    // Wait for the actual commit transfer, not session creation or upload
    // chunks. The Rust future has not accepted the newly allocated result.
    assert_eq!(JsFuture::from(submitted).await.unwrap().as_f64(), Some(15.));
    assert!(owner.validate().is_ok());
    drop(future);
    assert_eq!(worker.incarnation(), 0);
    let mut replacement = BrowserWorker::new().unwrap();
    replacement.qualify().await.unwrap();
    worker.retire();
    let next = replacement.evaluate(rectangle(&replacement), 0.001, 5., 1_048_576).await.unwrap();
    assert!((volume(&next.completion().tessellation) - 1.).abs() < 1e-6);
    next.validate_live().unwrap();
}

fn rectangle(worker: &BrowserWorker) -> RetainedRequest {
    let input = b"#1=IFCCARTESIANPOINT((0.,0.));#2=IFCAXIS2PLACEMENT2D(#1,$);#3=IFCRECTANGLEPROFILEDEF(.AREA.,$,#2,1.,1.);#4=IFCDIRECTION((0.,0.,1.));#5=IFCEXTRUDEDAREASOLID(#3,$,#4,1.);";
    let mut decoder = EntityDecoder::with_index(input, build_entity_index(input));
    let entity = decoder.decode_by_id(5).unwrap();
    let mut document = GeometryDocument::new();
    let definition = document.add_retained_extrusion(RetainedExtrusion {
        source: extract_analytic_extrusion(&entity, &mut decoder), length_unit_scale: 1.,
        source_epoch: 1, source_revision: 1,
    }).unwrap();
    document.prepare_retained_extrusion(definition, EvaluationContract::RetainedBrep, worker.incarnation()).unwrap()
}
const IDENTITY: [f64; 16] = [1.,0.,0.,0., 0.,1.,0.,0., 0.,0.,1.,0., 0.,0.,0.,1.];
fn source(realization: &BrowserRealization, frame: [f64; 16]) -> BrowserDependency<'_> {
    BrowserDependency::Source { realization, world_from_source: frame }
}
fn volume(mesh: &RetainedTessellation) -> f64 {
    let p = |i: u32| { let i = i as usize * 3; [mesh.positions[i], mesh.positions[i+1], mesh.positions[i+2]] };
    mesh.indices.chunks_exact(3).map(|tri| {
        let [a,b,c] = [p(tri[0]),p(tri[1]),p(tri[2])];
        (a[0]*(b[1]*c[2]-b[2]*c[1])+a[1]*(b[2]*c[0]-b[0]*c[2])+a[2]*(b[0]*c[1]-b[1]*c[0]))/6.
    }).sum::<f64>().abs()
}

#[wasm_bindgen_test(async)]
async fn actual_browser_difference_survives_operand_drop_and_can_feed_next_dependency() {
    use ifc_lite_geometry::document::BooleanOperation;
    let mut worker = BrowserWorker::new_retained_execution().unwrap();
    worker.qualify().await.unwrap();
    let a = worker.evaluate(rectangle(&worker), 0.001, 5., 1_048_576).await.unwrap();
    let b = worker.evaluate(rectangle(&worker), 0.001, 5., 1_048_576).await.unwrap();
    let mut left = IDENTITY; left[12] = 1e9; left[13] = 2e9;
    let mut right = left; right[12] += 0.5;
    let expected_left = crate::retained_values::multiply(left, a.completion().source_from_evaluation);
    let expected_right = crate::retained_values::multiply(right, b.completion().source_from_evaluation);
    let result = worker.evaluate_retained_boolean(source(&a, left), source(&b, right),
        BooleanOperation::Difference, 0.001, 5., 1_048_576).await.unwrap();
    assert_eq!(result.operation_identity().left, *a.handle());
    assert_eq!(result.operation_identity().right, *b.handle());
    assert_eq!(result.operation_identity().operation, BooleanOperation::Difference);
    assert_eq!(result.operation_identity().left_world_from_evaluation, expected_left);
    assert_eq!(result.operation_identity().right_world_from_evaluation, expected_right);
    assert_eq!(*result.world_from_evaluation(), expected_left);
    assert!((volume(result.mesh()) - 0.5).abs() < 1e-6);
    drop(a); drop(b);
    result.validate_live().unwrap();
    assert_ne!(worker.incarnation(), 0);
    // A repeated dependency counts both branches. It is not visited-set deduped
    // away and remains independently usable after its input result is dropped.
    let repeated = worker.evaluate_retained_boolean(BrowserDependency::Result(&result),
        BrowserDependency::Result(&result), BooleanOperation::Union, 0.001, 5., 1_048_576).await.unwrap();
    drop(result);
    repeated.validate_live().unwrap();
    assert!((volume(repeated.mesh()) - 0.5).abs() < 1e-6);
    drop(repeated);
    assert_ne!(worker.incarnation(), 0);
    worker.retire();
}

#[wasm_bindgen_test(async)]
async fn actual_browser_foreign_and_nonrigid_rejection_preserve_operands_and_workers() {
    use ifc_lite_geometry::document::BooleanOperation;
    let mut worker = BrowserWorker::new_retained_execution().unwrap();
    worker.qualify().await.unwrap();
    let a = worker.evaluate(rectangle(&worker), 0.001, 5., 1_048_576).await.unwrap();
    let mut foreign = BrowserWorker::new_retained_execution().unwrap();
    let b = foreign.evaluate(rectangle(&foreign), 0.001, 5., 1_048_576).await.unwrap();
    assert!(worker.evaluate_retained_boolean(source(&a, IDENTITY), source(&b, IDENTITY),
        BooleanOperation::Difference, 0.001, 5., 1_048_576).await.is_err());
    a.validate_live().unwrap(); b.validate_live().unwrap();
    assert_ne!(worker.incarnation(), 0); assert_ne!(foreign.incarnation(), 0);
    let mut scale = IDENTITY; scale[0] = 2.;
    assert!(worker.evaluate_retained_boolean(source(&a, IDENTITY), source(&a, scale),
        BooleanOperation::Union, 0.001, 5., 1_048_576).await.is_err());
    assert!(worker.evaluate_retained_boolean(source(&a, IDENTITY), source(&a, IDENTITY),
        BooleanOperation::Union, 0.001, 181., 1_048_576).await.is_err());
    a.validate_live().unwrap(); b.validate_live().unwrap();
    assert_ne!(worker.incarnation(), 0);
    worker.retire(); foreign.retire();
}

#[wasm_bindgen_test(async)]
async fn abandoned_actual_browser_boolean_future_retires_only_captured_incarnation() {
    use ifc_lite_geometry::document::BooleanOperation;
    let mut worker = BrowserWorker::new_retained_execution().unwrap();
    worker.qualify().await.unwrap();
    let a = worker.evaluate(rectangle(&worker), 0.001, 5., 1_048_576).await.unwrap();
    let b = worker.evaluate(rectangle(&worker), 0.001, 5., 1_048_576).await.unwrap();
    let owner = worker.owner.clone();
    let submitted = owner.driver.next_dispatch(5); // actual Boolean, after operand copy
    let mut future = Box::pin(worker.evaluate_retained_boolean(source(&a, IDENTITY), source(&b, IDENTITY),
        BooleanOperation::Union, 0.001, 5., 1_048_576));
    assert!(matches!(future.as_mut().poll(&mut Context::from_waker(Waker::noop())), Poll::Pending));
    assert_eq!(JsFuture::from(submitted).await.unwrap().as_f64(), Some(5.));
    drop(future);
    assert_eq!(worker.incarnation(), 0);
    assert!(a.validate_live().is_err()); assert!(b.validate_live().is_err());
    let mut replacement = BrowserWorker::new_retained_execution().unwrap();
    replacement.qualify().await.unwrap();
    drop(a); drop(b); drop(worker);
    let next = replacement.evaluate(rectangle(&replacement), 0.001, 5., 1_048_576).await.unwrap();
    assert!((volume(&next.completion().tessellation) - 1.).abs() < 1e-6);
    next.validate_live().unwrap();
}

#[wasm_bindgen_test(async)]
async fn actual_browser_source_only_drop_keeps_existing_worker_teardown_boundary() {
    let mut worker = BrowserWorker::new().unwrap();
    let source = worker.evaluate(rectangle(&worker), 0.001, 5., 1_048_576).await.unwrap();
    drop(source);
    assert_eq!(worker.incarnation(), 0);
}

#[wasm_bindgen_test(async)]
async fn invalid_construction_limits_preserve_actual_browser_object_and_worker() {
    let mut worker = BrowserWorker::new_retained_execution().unwrap();
    let original = worker.evaluate(rectangle(&worker), 0.001, 5., 1_048_576).await.unwrap();
    let incarnation = worker.incarnation();
    for (chord, angle, bytes) in [
        (0., 5., 1_048_576),
        (-0.001, 5., 1_048_576),
        (f64::NAN, 5., 1_048_576),
        (f64::INFINITY, 5., 1_048_576),
        (0.001, 0., 1_048_576),
        (0.001, -5., 1_048_576),
        (0.001, f64::NAN, 1_048_576),
        (0.001, f64::INFINITY, 1_048_576),
        (0.001, 181., 1_048_576),
        (0.001, 5., 0),
    ] {
        assert!(worker.evaluate(rectangle(&worker), chord, angle, bytes).await.is_err());
        original.validate_live().unwrap();
        assert_eq!(worker.incarnation(), incarnation);
    }
    // A second actual SDK construction proves the captured executor remains
    // usable, rather than merely retaining a nonzero bookkeeping identity.
    let next = worker.evaluate(rectangle(&worker), 0.001, 180., 1_048_576).await.unwrap();
    assert!((volume(&next.completion().tessellation) - 1.).abs() < 1e-6);
    original.validate_live().unwrap();
    drop(next);
    original.validate_live().unwrap();
    worker.retire();
}

// P2 actual private driver + Worker + pinned SDK. UNRUN until browser execution.
#[wasm_bindgen_test(async)]
async fn actual_browser_sealed_empty_boolean_identities_and_independent_leases() {
    use ifc_lite_geometry::document::BooleanOperation::{Union, Intersection, Difference};
    use crate::NumericalOutcome;
    let mut worker = BrowserWorker::new_retained_execution().unwrap();
    worker.qualify().await.unwrap();
    let a = worker.evaluate(rectangle(&worker), 0.001, 5., 1_048_576).await.unwrap();
    let b = worker.evaluate(rectangle(&worker), 0.001, 5., 1_048_576).await.unwrap();
    let mut far = IDENTITY; far[12] = 100.;
    let empty = worker.evaluate_retained_boolean(source(&a, IDENTITY), source(&b, far),
        Intersection, 0.001, 5., 1_048_576).await.unwrap();
    let removed = worker.evaluate_retained_boolean(source(&a, IDENTITY), source(&a, IDENTITY),
        Difference, 0.001, 5., 1_048_576).await.unwrap();
    for operation in [Union, Intersection, Difference] {
        let result = worker.evaluate_retained_boolean(BrowserDependency::Result(&empty),
            BrowserDependency::Result(&removed), operation, 0.001, 5., 1_048_576).await.unwrap();
        assert!(result.is_empty()); drop(result);
        empty.validate_live().unwrap(); removed.validate_live().unwrap();
    }
    for zero in [&empty, &removed] {
        assert_eq!(zero.outcome(), NumericalOutcome::Empty);
        assert!(zero.is_empty()); assert!(zero.mesh().positions.is_empty());
        for operation in [Union, Intersection, Difference] {
            for reverse in [false, true] {
                let (left, right) = if reverse {
                    (source(&a, IDENTITY), BrowserDependency::Result(zero))
                } else { (BrowserDependency::Result(zero), source(&a, IDENTITY)) };
                let result = worker.evaluate_retained_boolean(left, right, operation,
                    0.001, 5., 1_048_576).await.unwrap();
                let expected = operation == Intersection || (operation == Difference && !reverse);
                assert_eq!(result.is_empty(), expected);
                assert_eq!(result.mesh().indices.is_empty(), expected);
                if !expected { assert!((volume(result.mesh()) - 1.).abs() < 1e-6); }
                drop(result);
                // Actual result lease release must leave all independent input
                // leases live and usable for the next iteration.
                a.validate_live().unwrap(); b.validate_live().unwrap(); zero.validate_live().unwrap();
            }
        }
    }
    drop(empty);
    removed.validate_live().unwrap(); a.validate_live().unwrap(); b.validate_live().unwrap();
    let intact = worker.evaluate_retained_boolean(source(&a, IDENTITY), source(&b, IDENTITY),
        Union, 0.001, 5., 1_048_576).await.unwrap();
    assert!((volume(intact.mesh()) - 1.).abs() < 1e-6);
    drop(a); drop(b); drop(removed);
    intact.validate_live().unwrap();
    assert_ne!(worker.incarnation(), 0);
}

#[wasm_bindgen_test(async)]
async fn p3_actual_domain_membership_uses_captured_owner_and_live_object_leases() {
    let mut first=BrowserWorker::new_retained_execution().unwrap();
    let mut second=BrowserWorker::new_retained_execution().unwrap();
    let a=first.evaluate(rectangle(&first),0.001,5.,1_048_576).await.unwrap();
    let b=second.evaluate(rectangle(&second),0.001,5.,1_048_576).await.unwrap();
    let domain=first.cancellation();let clone=domain.clone();let foreign=second.cancellation();
    assert!(domain.same_domain(&clone));assert!(!domain.same_domain(&foreign));
    assert!(a.belongs_to(&domain));assert!(!a.belongs_to(&foreign));assert!(b.belongs_to(&foreign));
    domain.retire();assert!(domain.incarnation().is_none());assert!(a.validate_live().is_err());
    assert!(a.belongs_to(&clone),"membership alone does not grant liveness");
    b.validate_live().unwrap();assert!(foreign.incarnation().is_some());
}

#[wasm_bindgen_test(async)]
async fn p3_actual_affine_copy_receipt_survives_source_drop_and_feeds_ordered_boolean() {
    let mut worker=BrowserWorker::new_retained_execution().unwrap();worker.qualify().await.unwrap();
    let original=worker.evaluate(rectangle(&worker),0.001,5.,1_048_576).await.unwrap();
    let domain=worker.cancellation();let handle=original.handle().clone();let mut scale=IDENTITY;scale[0]=2.;
    let copy=worker.copy_retained_affine(BrowserTransformInput::Source(&original),scale).await.unwrap();
    assert_eq!(copy.operation_identity().input,handle);assert_eq!(copy.operation_identity().column_major,scale);
    assert!(copy.belongs_to(&domain));drop(original);copy.validate_live().unwrap();
    let result=worker.evaluate_retained_boolean(BrowserDependency::Affine {copy:&copy,world_from_affine:IDENTITY},
        BrowserDependency::Affine {copy:&copy,world_from_affine:IDENTITY},
        ifc_lite_geometry::document::BooleanOperation::Union,0.001,5.,1_048_576).await.unwrap();
    assert!(result.belongs_to(&domain));assert!((volume(result.mesh())-2.).abs()<1e-6);
    drop(copy);result.validate_live().unwrap();
}

#[wasm_bindgen_test(async)]
async fn p3_retirement_after_observed_actual_release_isolated_from_replacement() {
    let mut worker=BrowserWorker::new_retained_execution().unwrap();
    let object=worker.evaluate(rectangle(&worker),0.001,5.,1_048_576).await.unwrap();
    let survivor=worker.evaluate(rectangle(&worker),0.001,5.,1_048_576).await.unwrap();
    let domain=worker.cancellation();let release=domain.observe_dispatch(8);
    drop(object);
    assert_eq!(JsFuture::from(release).await.unwrap().as_f64(),Some(8.));
    // An uncertain in-flight release is terminal for only this captured domain.
    // This is actual dispatch retirement, not a fixture's synthesized failure.
    domain.retire();assert!(survivor.validate_live().is_err());
    let mut replacement=BrowserWorker::new_retained_execution().unwrap();
    let next=replacement.evaluate(rectangle(&replacement),0.001,5.,1_048_576).await.unwrap();
    drop(survivor);drop(worker);domain.retire();next.validate_live().unwrap();
    assert!((volume(&next.completion().tessellation)-1.).abs()<1e-6);
}

#[wasm_bindgen_test(async)]
async fn p3_actual_released_object_is_stale_and_old_drop_cannot_release_reused_slot() {
    let mut worker=BrowserWorker::new_retained_execution().unwrap();
    let old=worker.evaluate(rectangle(&worker),0.001,5.,1_048_576).await.unwrap();
    let sibling=worker.evaluate(rectangle(&worker),0.001,5.,1_048_576).await.unwrap();
    let old_handle=old.handle().clone();
    worker.owner.driver.release_object(&old.object);
    assert!(old.validate_live().is_err());sibling.validate_live().unwrap();
    let next=worker.evaluate(rectangle(&worker),0.001,5.,1_048_576).await.unwrap();
    assert_ne!(*next.handle(),old_handle);
    drop(old);next.validate_live().unwrap();sibling.validate_live().unwrap();
    assert!((volume(&next.completion().tessellation)-1.).abs()<1e-6);
}

#[wasm_bindgen_test(async)]
async fn p3_drop_after_actual_affine_dispatch18_retires_only_original_worker() {
    let mut worker=BrowserWorker::new_retained_execution().unwrap();worker.qualify().await.unwrap();
    let source=worker.evaluate(rectangle(&worker),0.001,5.,1_048_576).await.unwrap();
    let observation=worker.cancellation().observe_dispatch(18);let mut scale=IDENTITY;scale[0]=2.;
    let mut future=Box::pin(worker.copy_retained_affine(BrowserTransformInput::Source(&source),scale));
    assert!(matches!(future.as_mut().poll(&mut Context::from_waker(Waker::noop())),Poll::Pending));
    assert_eq!(JsFuture::from(observation).await.unwrap().as_f64(),Some(18.));
    drop(future);assert_eq!(worker.incarnation(),0);assert!(source.validate_live().is_err());
    let mut replacement=BrowserWorker::new_retained_execution().unwrap();
    let next=replacement.evaluate(rectangle(&replacement),0.001,5.,1_048_576).await.unwrap();
    drop(source);drop(worker);next.validate_live().unwrap();
    assert!((volume(&next.completion().tessellation)-1.).abs()<1e-6);
}
