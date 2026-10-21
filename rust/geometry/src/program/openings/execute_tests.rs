// SPDX-License-Identifier: MPL-2.0
//! Owned numerical cut outcomes over real capped kernel work: reached failures
//! publish exactly once on normal exit, stop and unwind; every other effect
//! and all route telemetry publish only with accepted geometry.
use super::{execute, Execution, NumericalOutcome};
use crate::kernel::budget;
use crate::resource::{self, ExecutionAccount, ExecutionPolicy, ProgramStop, ResourceLimits};
use crate::router::voids::{OpeningType, ParamRectCut, RectParam, VoidContext};
use crate::{Error, GeometryRouter, Mesh, Point3, TessellationQuality, Vector3};
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::{Arc, PoisonError};

const ID: u32 = 91_109;

/// A closed axis-aligned box centred at `x` on X.
fn box_mesh(x: f64, half: [f64; 3]) -> Mesh {
    let corner =
        |sx: f64, sy: f64, sz: f64| Point3::new(x + sx * half[0], sy * half[1], sz * half[2]);
    let c = [
        corner(-1., -1., -1.),
        corner(1., -1., -1.),
        corner(1., 1., -1.),
        corner(-1., 1., -1.),
        corner(-1., -1., 1.),
        corner(1., -1., 1.),
        corner(1., 1., 1.),
        corner(-1., 1., 1.),
    ];
    let mut mesh = Mesh::new();
    for face in [
        [0, 3, 2, 1],
        [4, 5, 6, 7],
        [0, 1, 5, 4],
        [2, 3, 7, 6],
        [0, 4, 7, 3],
        [1, 2, 6, 5],
    ] {
        let normal = (c[face[1]] - c[face[0]])
            .cross(&(c[face[2]] - c[face[0]]))
            .normalize();
        let base = mesh.vertex_count() as u32;
        for index in face {
            mesh.add_vertex(c[index], normal);
        }
        mesh.add_triangle(base, base + 1, base + 2);
        mesh.add_triangle(base, base + 2, base + 3);
    }
    mesh
}

/// Two closed boxes flank the host centre a hair off its faces: their AABB
/// engulfs the host, their solid does not, and the near-coplanar overlaps
/// exhaust an element cap of 1 inside the real exact subtraction.
fn capped_fixture() -> (Mesh, VoidContext) {
    let mut cutter = box_mesh(-0.8, [0.5, 0.15 + 1.3e-4, 1.0 + 1.7e-4]);
    cutter.merge(&box_mesh(0.8, [0.5, 0.15 + 1.3e-4, 1.0 + 1.7e-4]));
    let (lo, hi) = cutter.bounds();
    let opening = OpeningType::NonRectangular(cutter, lo.cast(), hi.cast(), None);
    let context = VoidContext {
        openings: vec![opening.clone()],
        merged_openings: vec![opening],
        param: None,
        bool2d: None,
    };
    (box_mesh(0., [1., 0.15, 1.]), context)
}

/// Run `cut` under an element cap of 1, serialised with the other cap users.
fn capped<T>(cut: impl FnOnce() -> T) -> T {
    let _lock = budget::GLOBAL_CAP_LOCK
        .lock()
        .unwrap_or_else(PoisonError::into_inner);
    let profile = budget::TestProfile::new();
    profile.set_element_cap(Some(1));
    budget::begin_element();
    let value = cut();
    assert!(
        budget::tripped(),
        "the real exact subtraction exhausts the element cap"
    );
    value
}

fn account() -> ExecutionAccount {
    ExecutionAccount::new(ExecutionPolicy::Bounded(ResourceLimits::default()))
}

/// The one reached failure is published, attributed, summarised, and only once.
fn assert_failure_once(router: &GeometryRouter) -> crate::router::HostOpeningDiagnostic {
    let failures = router.take_csg_failures();
    assert_eq!(failures.len(), 1);
    assert_eq!(failures[&ID].len(), 1);
    assert_eq!(failures[&ID][0].product_id, Some(ID));
    assert!(matches!(
        failures[&ID][0].reason,
        crate::diagnostics::BoolFailureReason::OperandTooLarge { .. }
    ));
    assert!(
        router.take_csg_failures().is_empty(),
        "the failure publishes once"
    );
    let mut diagnostics = router.take_host_opening_diagnostics();
    let host = diagnostics.remove(&ID).expect("the failure summary bucket");
    assert!(diagnostics.is_empty());
    assert_eq!(host.csg_failure_count, 1, "the summary publishes once");
    assert!(host.first_failure_label.is_some());
    host
}

#[test]
fn root_capped_failure_publishes_once_with_accepted_geometry() {
    let router = GeometryRouter::new();
    let (host, context) = capped_fixture();
    let host_tris = host.triangle_count();
    let outcome = capped(|| execute(host, &context, ID, TessellationQuality::default()));
    assert!(
        router.take_csg_failures().is_empty(),
        "nothing publishes before acceptance"
    );
    let (mesh, telemetry) = crate::telemetry_transaction::capture(|| outcome.publish(&router));
    let mesh = mesh.unwrap();
    assert_eq!(
        mesh.triangle_count(),
        host_tris,
        "the engulfing box-cut stays suppressed"
    );
    assert_eq!(
        telemetry.len(),
        0,
        "the exact route records no fast-path telemetry"
    );
    let diagnostic = assert_failure_once(&router);
    assert_eq!(
        diagnostic.tris_after,
        Some(host_tris),
        "accepted geometry keeps its cut effect"
    );
}

#[test]
fn root_capped_failure_survives_a_stop_that_rejects_the_geometry() {
    let router = GeometryRouter::new();
    account().scope(|| {
        let (host, context) = capped_fixture();
        let outcome = capped(|| execute(host, &context, ID, TessellationQuality::default()));
        resource::stop(ProgramStop::Cancelled);
        let (result, telemetry) =
            crate::telemetry_transaction::capture(|| outcome.publish(&router));
        assert!(matches!(
            result,
            Err(Error::ProgramStopped(ProgramStop::Cancelled))
        ));
        assert_eq!(telemetry.len(), 0);
    });
    let diagnostic = assert_failure_once(&router);
    assert_eq!(
        diagnostic.tris_after, None,
        "rejected geometry publishes no cut effect"
    );
    assert!(!router.host_consumed_by_void(ID));
    assert_eq!(
        router.take_rect_fast_stats(),
        crate::rect_fast::RectFastStats::default()
    );
}

#[test]
fn root_capped_failure_drains_on_unwind_and_resumes_the_original_payload() {
    let router = GeometryRouter::new();
    let (host, context) = capped_fixture();
    let OpeningType::NonRectangular(cutter, ..) = &context.openings[0] else {
        unreachable!()
    };
    let execution = Execution::new(TessellationQuality::default());
    let clipper = crate::csg::ClippingProcessor::new();
    let payload = Arc::new(String::from("original opening numerical panic"));
    let (result, telemetry) = capped(|| {
        crate::telemetry_transaction::capture(|| {
            catch_unwind(AssertUnwindSafe(|| -> Mesh {
                let _failures = execution.capture_failures(&clipper, ID);
                let cut = clipper.subtract_mesh(&host, cutter);
                assert!(matches!(cut, crate::csg::GroupCut::Rejected(_)));
                assert_eq!(
                    clipper.failure_count(),
                    1,
                    "the real kernel recorded one failure"
                );
                // Unwind after real work, before the ordinary drain point.
                std::panic::panic_any(Arc::clone(&payload));
            }))
        })
    });
    assert!(
        clipper.take_failures().is_empty(),
        "the guard drained the clipper"
    );
    assert!(
        router.take_csg_failures().is_empty(),
        "owned evidence is not yet published"
    );
    let outcome = NumericalOutcome {
        result,
        effects: execution.finish(),
        telemetry,
    };
    let resumed = catch_unwind(AssertUnwindSafe(|| outcome.publish(&router)))
        .expect_err("publication resumes the original panic");
    let resumed = resumed
        .downcast::<Arc<String>>()
        .expect("the original payload type");
    assert!(
        Arc::ptr_eq(&payload, &resumed),
        "panic payload identity is preserved"
    );
    let diagnostic = assert_failure_once(&router);
    assert_eq!(diagnostic.tris_after, None);
    assert!(!router.host_consumed_by_void(ID));
}

/// A 10×10×1 slab with one exact parametric 2×2 through-box.
fn parametric_fixture() -> (Mesh, VoidContext) {
    let square = |h: f64| {
        crate::profile::Profile2D::new(vec![
            nalgebra::Point2::new(-h, -h),
            nalgebra::Point2::new(h, -h),
            nalgebra::Point2::new(h, h),
            nalgebra::Point2::new(-h, h),
        ])
    };
    let placement = nalgebra::Matrix4::new_translation(&Vector3::new(0., 0., -0.5));
    let host =
        crate::extrusion::extrude_profile_watertight(&square(5.), 1., Some(placement)).unwrap();
    let rect = |half| RectParam {
        r: nalgebra::Matrix3::identity(),
        center: Point3::origin(),
        half,
    };
    let opening = OpeningType::Rectangular(
        Point3::new(-1., -1., -1.),
        Point3::new(1., 1., 1.),
        Some(Vector3::z()),
    );
    let context = VoidContext {
        openings: vec![opening.clone()],
        merged_openings: vec![opening],
        param: Some(ParamRectCut {
            host: rect([5., 5., 0.5]),
            openings: vec![rect([1., 1., 1.])],
        }),
        bool2d: None,
    };
    (host, context)
}

#[test]
fn a_fast_path_cut_without_failures_opens_no_failure_bucket() {
    for stopped in [false, true] {
        let router = GeometryRouter::new();
        account().scope(|| {
            let (host, context) = parametric_fixture();
            let outcome = execute(host, &context, ID, TessellationQuality::default());
            if stopped {
                resource::stop(ProgramStop::Cancelled);
            }
            let (result, telemetry) =
                crate::telemetry_transaction::capture(|| outcome.publish(&router));
            if stopped {
                assert!(matches!(
                    result,
                    Err(Error::ProgramStopped(ProgramStop::Cancelled))
                ));
                assert_eq!(
                    telemetry.len(),
                    0,
                    "rejected geometry commits no route telemetry"
                );
            } else {
                let mesh = result.unwrap();
                assert!((crate::mesh_check::signed_volume(&mesh).abs() - 96.).abs() < 1e-5);
                assert_eq!(
                    telemetry.len(),
                    1,
                    "the accepted parametric fire commits once"
                );
            }
        });
        let rect = router.take_rect_fast_stats();
        assert_eq!(
            rect.fired > 0,
            !stopped,
            "router-local rect counters follow acceptance"
        );
        assert!(
            router.take_csg_failures().is_empty(),
            "no failure means no failure bucket"
        );
        assert!(
            router.take_host_opening_diagnostics().is_empty(),
            "no empty host bucket"
        );
        assert!(!router.host_consumed_by_void(ID));
    }
}

#[test]
fn an_accepted_child_appends_in_order_and_a_rejected_child_leaks_nothing() {
    let bounds = ((0., 0., 0.), (1., 1., 1.));
    let parent = Execution::new(TessellationQuality::default());
    parent.record_host_cut_effect(1, 4, 4, 0, bounds);
    let rejected = Execution::new(TessellationQuality::default());
    rejected.record_void_consumed_host(1);
    rejected.record_host_cut_effect(1, 4, 0, 0, bounds);
    drop(rejected);
    let accepted = Execution::new(TessellationQuality::default());
    accepted.record_host_cut_effect(1, 4, 8, 1, bounds);
    parent.accept(accepted);
    let router = GeometryRouter::new();
    parent.finish().publish(&router);
    assert!(!router.host_consumed_by_void(1));
    let diagnostic = &router.take_host_opening_diagnostics()[&1];
    assert_eq!(
        (diagnostic.tris_after, diagnostic.rect_boxes_processed),
        (Some(8), 1)
    );
}
