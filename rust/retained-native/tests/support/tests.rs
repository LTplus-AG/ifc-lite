// SPDX-License-Identifier: MPL-2.0
#![cfg(feature = "retained-runtime")]
//! #7955: native stack construction witness adapted to whole-model publication.
use super::{metrics::Metrics, support::*};

// #8183: the corpus API keeps the qualified preflight worker across models.
#[test]
fn native_model_driver_reuses_preflight_worker_across_models() {
    let Some(path) = worker_path() else { return };
    let qualified =
        ifc_lite_retained_native::NativeWorker::spawn(std::path::Path::new(&path)).unwrap();
    let mut driver = ifc_lite_retained_native::NativeModelDriver::with_worker(
        std::path::Path::new(&path),
        qualified,
    );
    for _ in 0..2 {
        let mut outcomes = Vec::new();
        let (summary, timings) = driver
            .run_model(
                ifc_lite_core::SourceBundle::new(BOX.as_bytes().to_vec()),
                &ifc_lite_retained_native::ModelOptions::default(),
                |outcome, _| outcomes.push(outcome),
            )
            .unwrap();
        assert_eq!(summary.published, 1);
        assert_eq!(summary.restarts, 0);
        assert_eq!(summary.acquire_ms, 0.);
        assert_eq!(timings.startup_and_qualification_ms, 0.);
        assert_eq!(shape(&outcomes, 27).parts.len(), 1);
    }
}

#[test]
fn common_retained_actual_construction_resumes_and_publishes_shape_only() {
    let Some(outcomes) = native(BOX) else { return };
    let product = shape(&outcomes, 27);
    assert_eq!(product.parts.len(), 1);
    use ifc_lite_geometry::program::transactions::Requirement;
    assert_eq!(
        product.obligations.0,
        vec![
            Requirement::OpeningClosure,
            Requirement::MaterialLayers,
            Requirement::IfcAppearance,
            Requirement::PersistentFaces,
        ]
    );
    let part = &product.parts[0];
    let mut metrics = Metrics::default();
    metrics
        .add_mesh(
            &part
                .positions
                .chunks_exact(3)
                .map(|p| [p[0], p[1], p[2]])
                .collect::<Vec<_>>(),
            &part.indices,
        )
        .unwrap();
    assert!((metrics.volume - 6.).abs() <= 6e-6);
    assert_eq!(metrics.defects, 0);
    assert!(!part.curved);
}
#[test]
fn retained_constructor_refuses_original_zero_work_before_source_root_is_planned() {
    let mut options = ifc_lite_retained_native::ModelOptions::default();
    options.product_budget.work = 0;
    let (_, outcomes) = inert(BOX, &options);
    assert_eq!(refusal(&outcomes, 27).code(), "resource_exhausted");
}
