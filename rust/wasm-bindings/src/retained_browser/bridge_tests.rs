// SPDX-License-Identifier: MPL-2.0
//! Actual module Workers in a real browser; requires the staged canonical
//! `/smlib/` bundle next to this crate (see native/smlib-adapter/README.md).
//! Run: `wasm-pack test --headless --chrome rust/wasm-bindings --lib --features retained-browser -- retained_browser`.
use super::*;
use ifc_lite_core::{build_entity_index, EntityDecoder};
use ifc_lite_geometry::analytic::{extract_analytic_extrusion, with_source_capture};
use ifc_lite_geometry::document::{GeometryDocument, RetainedExtrusion};
use std::future::Future;
use std::task::{Context, Poll, Waker};
use wasm_bindgen_test::*;
wasm_bindgen_test_configure!(run_in_browser);

const RECTANGLE: &str = "#4=IFCRECTANGLEPROFILEDEF(.AREA.,$,#2,1.,1.);";
const CIRCLE: &str = "#4=IFCCIRCLEPROFILEDEF(.AREA.,$,#2,0.5);";

/// One authored profile extruded 1 m along +Z, as a request for `worker`.
fn request(profile: &str, worker: &BrowserWorker) -> RetainedRequest {
    let data = format!(
        "#1=IFCCARTESIANPOINT((0.,0.));#2=IFCAXIS2PLACEMENT2D(#1,$);{profile}\
#90=IFCCARTESIANPOINT((0.,0.,0.));#91=IFCAXIS2PLACEMENT3D(#90,$,$);\
#92=IFCDIRECTION((0.,0.,1.));#93=IFCEXTRUDEDAREASOLID(#4,#91,#92,1.);"
    );
    let mut decoder = EntityDecoder::with_index(data.as_bytes(), build_entity_index(data.as_bytes()));
    let entity = decoder.decode_by_id(93).unwrap();
    let source = with_source_capture(|| extract_analytic_extrusion(&entity, &mut decoder));
    let mut document = GeometryDocument::new();
    let definition = document
        .add_retained_extrusion(RetainedExtrusion { source, length_unit_scale: 1. })
        .unwrap();
    document.prepare_retained(definition, worker.incarnation()).unwrap()
}

/// Independent triangle volume of the copied f64 mesh.
fn volume(realization: &BrowserRealization) -> f64 {
    let mesh = &realization.completion().tessellation;
    let p = |i: u32| {
        let i = i as usize * 3;
        [mesh.positions[i], mesh.positions[i + 1], mesh.positions[i + 2]]
    };
    mesh.indices
        .chunks_exact(3)
        .map(|t| {
            let [a, b, c] = [p(t[0]), p(t[1]), p(t[2])];
            (a[0] * (b[1] * c[2] - b[2] * c[1]) + a[1] * (b[2] * c[0] - b[0] * c[2])
                + a[2] * (b[0] * c[1] - b[1] * c[0]))
                / 6.
        })
        .sum::<f64>()
        .abs()
}

const BUDGET: u32 = 1 << 20;

#[wasm_bindgen_test(async)]
async fn j4_common_executor_uses_actual_worker_receipts_and_distinct_object_identity() {
    use ifc_lite_processing::element::runtime::{AsyncRetainedExecutor, Invocation, NumericalLimits, NumericalReceipt, ReceiptEvidence};
    use crate::retained_browser::receipt::BrowserReceipt;
    let mut worker = BrowserWorker::new().unwrap();
    let request = request(RECTANGLE, &worker);
    let domain = worker.cancellation();
    let limits = NumericalLimits { chord_metres: 0.001, angle_degrees: 5., max_bytes: BUDGET as usize };
    let first = worker.invoke(Invocation::Construction(&request), limits).await.unwrap();
    let second = worker.invoke(Invocation::Construction(&request), limits).await.unwrap();
    assert!(first.object() != second.object(), "the same source can produce distinct owned objects");
    assert!(first.belongs_to_domain(&domain) && second.belongs_to_domain(&domain));
    let ReceiptEvidence::Construction(completion) = first.evidence() else { panic!("construction evidence") };
    assert!(request.same_admission(completion.request()));
    let BrowserReceipt::Construction(value) = &first else { panic!("construction invocation returned a dependency receipt") };
    assert!((volume(value) - 1.).abs() <= 1e-9, "authored unit cube volume");
    drop(first);
    second.validate_live().unwrap();
    domain.retire();
    assert_eq!(second.validate_live(), Err(BrowserError::WrongWorker));
}

#[wasm_bindgen_test(async)]
async fn retained_browser_abandoned_commit_retires_actual_worker_and_restart_is_independent() {
    let mut worker = BrowserWorker::new().unwrap();
    // A first real construction proves this module Worker exists and has a
    // session before cancellation, rather than cancelling an unstarted import.
    let first = worker.evaluate_retained(request(RECTANGLE, &worker), 0.001, 5., BUDGET).await.unwrap();
    let owner = worker.owner.clone();
    let committed = owner.driver.next_dispatch(15); // the actual staged sweep commit
    let mut future = Box::pin(worker.evaluate_retained(request(RECTANGLE, &worker), 0.001, 5., BUDGET));
    assert!(matches!(future.as_mut().poll(&mut Context::from_waker(Waker::noop())), Poll::Pending));
    // The commit frame was transferred; the Rust future never accepted its result.
    assert_eq!(JsFuture::from(committed).await.unwrap().as_f64(), Some(15.));
    assert!(owner.validate().is_ok());
    drop(future);
    assert_eq!(worker.incarnation(), 0);
    assert!(first.validate_live().is_err(), "retirement invalidates every lease");
    let mut replacement = BrowserWorker::new().unwrap();
    let old = worker.cancellation();
    old.retire(); // a stale cancellation cannot reach the replacement
    worker.retire();
    let next = replacement.evaluate_retained(request(RECTANGLE, &replacement), 0.001, 5., BUDGET).await.unwrap();
    assert!((volume(&next) - 1.).abs() < 1e-9);
    next.validate_live().unwrap();
    assert!(!old.same_worker(&replacement) && next.belongs_to(&replacement));
}

#[wasm_bindgen_test(async)]
async fn retained_browser_request_for_another_actual_worker_is_refused_without_submission() {
    let mut a = BrowserWorker::new().unwrap();
    let mut b = BrowserWorker::new().unwrap();
    let from_a = a.evaluate_retained(request(RECTANGLE, &a), 0.001, 5., BUDGET).await.unwrap();
    let foreign = request(RECTANGLE, &a);
    assert_eq!(b.evaluate_retained(foreign, 0.001, 5., BUDGET).await.err(), Some(BrowserError::WrongWorker));
    assert_ne!(b.incarnation(), 0, "a refused foreign request leaves the Worker live");
    let from_b = b.evaluate_retained(request(RECTANGLE, &b), 0.001, 5., BUDGET).await.unwrap();
    assert!(from_a.belongs_to(&a) && !from_a.belongs_to(&b));
    // #7955 J4: common product acceptance uses the pre-dispatch domain.
    let captured = a.cancellation();
    from_a.validate_in_domain(&captured).unwrap();
    assert_eq!(from_a.validate_in_domain(&b.cancellation()), Err(BrowserError::WrongWorker));
    a.retire();
    assert!(from_a.validate_live().is_err());
    assert_eq!(from_a.validate_in_domain(&captured), Err(BrowserError::WrongWorker));
    // A request prepared for the retired Worker cannot run on it again.
    assert_eq!(
        a.evaluate_retained(request(RECTANGLE, &b), 0.001, 5., BUDGET).await.err(),
        Some(BrowserError::WrongWorker)
    );
    from_b.validate_live().unwrap();
    from_b.validate_in_domain(&b.cancellation()).unwrap();
}

#[wasm_bindgen_test(async)]
async fn retained_browser_dropped_lease_is_released_before_the_next_result_is_accepted() {
    let mut worker = BrowserWorker::new().unwrap();
    let first = worker.evaluate_retained(request(RECTANGLE, &worker), 0.001, 5., BUDGET).await.unwrap();
    let object = first.object.clone();
    let released = worker.owner.driver.next_dispatch(8);
    drop(first);
    // The lease is invalid at once and its release command is already on the
    // actual Worker; the next construction waits for that cleanup to finish.
    assert!(!worker.owner.driver.object_live(&object));
    assert_eq!(JsFuture::from(released).await.unwrap().as_f64(), Some(8.));
    let second = worker.evaluate_retained(request(RECTANGLE, &worker), 0.001, 5., BUDGET).await.unwrap();
    second.validate_live().unwrap();
    assert!((volume(&second) - 1.).abs() < 1e-9);
    // Curved families stay closed until this incarnation's own witnesses ran.
    assert!(matches!(
        worker.evaluate_retained(request(CIRCLE, &worker), 0.001, 5., BUDGET).await,
        Err(BrowserError::Unqualified(_))
    ));
    second.validate_live().unwrap();
    worker.qualify().await.unwrap();
    let circle = worker.evaluate_retained(request(CIRCLE, &worker), 0.0001, 5., 16 * BUDGET).await.unwrap();
    assert!((volume(&circle) - std::f64::consts::PI * 0.25).abs() < 1e-3);
    second.validate_live().unwrap();
}

#[wasm_bindgen_test(async)]
async fn retained_browser_invalid_limits_preserve_actual_worker_and_existing_lease() {
    let mut worker = BrowserWorker::new().unwrap();
    let original = worker.evaluate_retained(request(RECTANGLE, &worker), 0.001, 5., BUDGET).await.unwrap();
    let incarnation = worker.incarnation();
    for (chord, angle, bytes) in [(0., 5., BUDGET), (f64::NAN, 5., BUDGET), (0.001, 181., BUDGET), (0.001, 5., 0)] {
        let refused = worker.evaluate_retained(request(RECTANGLE, &worker), chord, angle, bytes).await;
        assert_eq!(refused.err(), Some(BrowserError::InvalidLimits));
        original.validate_live().unwrap();
        assert_eq!(worker.incarnation(), incarnation);
    }
    // An oversized copy is an SDK-side refusal: unknown state retires the Worker.
    assert!(worker.evaluate_retained(request(RECTANGLE, &worker), 0.001, 5., 64).await.is_err());
    assert_eq!(worker.incarnation(), 0);
    assert!(original.validate_live().is_err());
}

#[wasm_bindgen_test(async)]
async fn retained_browser_affine_requires_own_witness_and_keeps_independent_lease() {
    // #7955: actual module Worker, sealed input and shared certificate decoder.
    use crate::retained_browser::receipt::BrowserReceipt;
    use ifc_lite_processing::element::runtime::NumericalReceipt;
    let mut worker = BrowserWorker::new().unwrap();
    let source = worker.evaluate_retained(request(RECTANGLE, &worker), 0.001, 5., BUDGET).await.unwrap();
    let input = BrowserReceipt::Construction(Box::new(source));
    let matrix = [2., 0., 0., 0., 0.5, 1., 0., 0., 0., 0., 1., 0., 7., -4., 2., 1.];
    assert!(matches!(worker.copy_retained_affine(&input, matrix).await.err(), Some(BrowserError::Unqualified(_))));
    input.validate_live().unwrap();
    worker.qualify_dependencies().await.unwrap();
    let mut singular = matrix;
    singular[8..11].fill(0.);
    assert!(worker.copy_retained_affine(&input, singular).await.is_err());
    input.validate_live().unwrap();
    let copy = worker.copy_retained_affine(&input, matrix).await.unwrap();
    assert!(copy.input == input.object());
    assert_eq!(copy.column_major, matrix);
    assert_eq!(copy.operations, 1);
    drop(input);
    copy.validate_live().unwrap();
    let other = BrowserWorker::new().unwrap();
    assert!(!copy.domain.same_domain(&other.cancellation()));
    worker.retire();
    assert!(copy.validate_live().is_err());
}

#[wasm_bindgen_test(async)]
async fn retained_browser_boolean_uses_shared_survey_frames_and_authenticates_empty_reuse() {
    // #7955: one-metre authored cube; overlapping half-cubes have volume 0.5.
    use crate::retained_browser::receipt::BrowserReceipt;
    use ifc_lite_geometry::BoolOp;
    use ifc_lite_processing::element::runtime::{NumericalLimits, NumericalReceipt, Operand};
    let mut worker = BrowserWorker::new().unwrap();
    worker.qualify_dependencies().await.unwrap();
    let source = worker.evaluate_retained(request(RECTANGLE, &worker), 0.001, 5., BUDGET).await.unwrap();
    let input = BrowserReceipt::Construction(Box::new(source));
    let frame = [1., 0., 0., 0., 0., 1., 0., 0., 0., 0., 1., 0., 1e9, 2e9, 3e9, 1.];
    let mut shifted = frame;
    shifted[12] += 0.5;
    let limits = NumericalLimits { chord_metres: 0.001, angle_degrees: 5., max_bytes: BUDGET as usize };
    let result = worker.evaluate_retained_boolean(
        Operand::Source { receipt: &input, world_from_source: frame },
        Operand::Source { receipt: &input, world_from_source: shifted }, BoolOp::Difference, limits).await.unwrap();
    assert!(!result.mesh.empty);
    assert!((dependency_volume(&result.mesh) - 0.5).abs() < 1e-9);
    // Rectangle evaluation starts at its authored lower-left corner (-0.5,-0.5,0).
    let mut expected = frame;
    expected[12] -= 0.5;
    expected[13] -= 0.5;
    assert_eq!(result.world_from_left, expected);
    expected[12] += 0.5;
    assert_eq!(result.world_from_right, expected);
    assert!(result.left == input.object() && result.right == input.object());
    let empty = worker.evaluate_retained_boolean(
        Operand::Source { receipt: &input, world_from_source: frame },
        Operand::Source { receipt: &input, world_from_source: frame }, BoolOp::Difference, limits).await.unwrap();
    assert!(empty.mesh.empty && empty.mesh.positions.is_empty() && empty.mesh.indices.is_empty());
    let empty = BrowserReceipt::Boolean(Box::new(empty));
    let recovered = worker.evaluate_retained_boolean(
        Operand::Placed { receipt: &empty, world_from_object: frame },
        Operand::Source { receipt: &input, world_from_source: frame }, BoolOp::Union, limits).await.unwrap();
    assert!(!recovered.mesh.empty);
    assert!((dependency_volume(&recovered.mesh) - 1.).abs() < 1e-9);
    drop(empty);
    drop(input);
    recovered.validate_live().unwrap();
    result.validate_live().unwrap();
    worker.retire();
    assert!(recovered.validate_live().is_err() && result.validate_live().is_err());
}

fn dependency_volume(mesh: &super::Mesh) -> f64 {
    let p = |i: u32| { let i = i as usize * 3; [mesh.positions[i], mesh.positions[i + 1], mesh.positions[i + 2]] };
    mesh.indices.chunks_exact(3).map(|t| {
        let [a, b, c] = [p(t[0]), p(t[1]), p(t[2])];
        (a[0] * (b[1] * c[2] - b[2] * c[1]) + a[1] * (b[2] * c[0] - b[0] * c[2])
            + a[2] * (b[0] * c[1] - b[1] * c[0])) / 6.
    }).sum::<f64>().abs()
}
