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
async fn abandoned_rust_future_retires_actual_worker_without_killing_replacement() {
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
    let mut future = Box::pin(worker.evaluate(request, 0.001, 5., 1024 * 1024));
    let mut context = Context::from_waker(Waker::noop());
    assert!(matches!(future.as_mut().poll(&mut context), Poll::Pending));
    drop(future);
    assert_eq!(worker.incarnation(), 0);
    let replacement = BrowserWorker::new().unwrap();
    assert_ne!(replacement.incarnation(), 0);
    worker.retire();
    assert_ne!(replacement.incarnation(), 0);
}
