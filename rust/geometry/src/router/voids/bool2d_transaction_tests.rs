// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! #4617: rejected mixed routes neither spend known-useless exact work nor
//! publish diagnostics for discarded geometry. Each mode has its own process
//! because route flags are read once and public counters are process-global.

use crate::program::openings::execute::GatePolicy;
use super::{tests::mixed_overlap_fixture, GeometryRouter, Mesh, VoidContext};
use crate::kernel::budget;

#[derive(Debug, PartialEq)]
struct Telemetry {
    bool2d: (u64, u64),
    prism: (u64, u64, u64),
    defers: Vec<(&'static str, u64)>,
    rect: crate::rect_fast::RectFastStats,
    param: u64,
    failures: String,
    host: String,
}

fn take(router: &GeometryRouter) -> Telemetry {
    Telemetry {
        bool2d: super::take_bool2d_stats(),
        prism: super::super::take_prism_stats(),
        defers: super::super::take_prism_defers(),
        rect: router.take_rect_fast_stats(),
        param: crate::rect_fast::take_param_fires(),
        failures: format!("{:?}", router.take_csg_failures()),
        host: format!("{:?}", router.take_host_opening_diagnostics()),
    }
}

#[derive(Debug, PartialEq)]
struct Work {
    csg: Vec<(u8, u32, u32)>,
    weld: [(u64, u64, u64); 2],
    escalations: u64,
}

fn take_work() -> Work {
    Work {
        csg: crate::csg::take_csg_census()
            .iter()
            .map(|r| (r.op, r.a_tris, r.b_tris))
            .collect(),
        weld: crate::kernel::plane_weld::take_plane_weld_stats(),
        escalations: budget::element_peak(),
    }
}

fn run(host: Mesh, context: &VoidContext) -> (Mesh, Telemetry, Work) {
    let router = GeometryRouter::new();
    take(&router);
    take_work();
    budget::begin_element();
    budget::reset_peak();
    let result = router.apply_void_context_borrowed(host, context, 4617).unwrap();
    (result, take(&router), take_work())
}

fn mesh_box(x0: f64, y0: f64, x1: f64, y1: f64, z0: f32, z1: f32) -> Mesh {
    let profile = crate::profile::Profile2D::new(vec![
        nalgebra::Point2::new(x0, y0),
        nalgebra::Point2::new(x1, y0),
        nalgebra::Point2::new(x1, y1),
        nalgebra::Point2::new(x0, y1),
    ]);
    let mut mesh =
        crate::extrusion::extrude_profile_watertight(&profile, (z1 - z0) as f64, None).unwrap();
    for p in mesh.positions.chunks_exact_mut(3) {
        p[2] += z0;
    }
    mesh
}

fn mesh_opening(mesh: Mesh) -> super::super::OpeningType {
    let (lo, hi) = mesh.bounds();
    super::super::OpeningType::NonRectangular(mesh, lo.cast(), hi.cast(), None)
}

/// An earlier real host must stay outside the mixed attempt's rollback domain.
fn prior_host(router: &GeometryRouter) {
    let mut decoder = ifc_lite_core::EntityDecoder::new(
        "#1=IFCBLOCK($,2.,3.,4.);
         #2=IFCSHAPEREPRESENTATION($,'Body','CSG',(#1));
         #3=IFCPRODUCTDEFINITIONSHAPE($,$,(#2));
         #7=IFCWALL('earlier',$,$,$,$,$,#3,$);
         #8=IFCOPENINGELEMENT('void',$,$,$,$,$,#3,$);",
    );
    let host = decoder.decode_by_id(7).unwrap();
    let voids = [(7, vec![8])].into_iter().collect();
    let cut = router.process_element_with_voids(&host, &mut decoder, &voids).unwrap();
    assert!(cut.is_empty(), "prior containing opening consumes its actual host");
    assert!(router.host_consumed_by_void(7));
}

#[test]
fn mixed_route_telemetry_is_atomic_4617() {
    const CHILD: &str = "IFC_LITE_4617_TELEMETRY_CHILD";
    let Ok(mode) = std::env::var(CHILD) else {
        for mode in ["disabled", "rejected", "accepted"] {
            let output = std::process::Command::new(std::env::current_exe().unwrap())
                .args(["--exact", "router::voids::bool2d_path::transaction_tests::mixed_route_telemetry_is_atomic_4617", "--nocapture"])
                .env(CHILD, mode)
                .env("IFC_LITE_PRISM_CUT", if mode == "disabled" { "0" } else { "1" })
                .env("IFC_LITE_VOID_2D", "1")
                .env("IFC_LITE_CSG_BUDGET", "0")
                .output().expect("isolated route regression");
            assert!(
                output.status.success(),
                "{mode}: {}\n{}",
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            );
        }
        return;
    };
    let (host, mut context) = mixed_overlap_fixture();
    if mode == "accepted" {
        let (result, telemetry, _) = run(host, &context);
        assert!((super::mesh_signed_volume(&result).abs() - 90.5).abs() < 1e-5);
        assert_eq!(telemetry.bool2d, (1, 3), "accepted prefix publishes once");
        return;
    }
    if mode == "disabled" {
        // Mesh-authored recess forces the exact kernel when prism support is
        // disabled; an AABB-authored recess can take the cheap triangle clip.
        let profile = crate::profile::Profile2D::new(vec![
            nalgebra::Point2::new(1.0, 1.0),
            nalgebra::Point2::new(3.0, 1.0),
            nalgebra::Point2::new(3.0, 3.0),
            nalgebra::Point2::new(1.0, 3.0),
        ]);
        let mut cutter = crate::extrusion::extrude_profile_watertight(&profile, 1.5, None).unwrap();
        for position in cutter.positions.chunks_exact_mut(3) {
            position[2] -= 1.0;
        }
        let (lo, hi) = cutter.bounds();
        let opening = super::super::OpeningType::NonRectangular(cutter, lo.cast(), hi.cast(), None);
        *context.openings.last_mut().unwrap() = opening.clone();
        context.merged_openings = GeometryRouter::merge_rectangular_openings(&context.openings);
        let residual = context.bool2d.as_mut().unwrap().residual.as_mut().unwrap();
        residual.openings = vec![opening.clone()];
        residual.merged_openings = vec![opening];
    }
    if mode == "rejected" {
        // The tapered recess requires exact CSG; a following engulf consumes
        // the precursor, so correction rejects the candidate AFTER real work.
        let mut recess = mesh_box(1.0, 1.0, 3.0, 3.0, -1.0, 0.5);
        for p in recess.positions.chunks_exact_mut(3) {
            if p[2] > 0.0 {
                p[0] = 2.0 + (p[0] - 2.0) * 0.5;
                p[1] = 2.0 + (p[1] - 2.0) * 0.5;
            }
        }
        let recess = mesh_opening(recess);
        let engulf = mesh_opening(mesh_box(-1.0, -1.0, 11.0, 11.0, -1.0, 2.0));
        *context.openings.last_mut().unwrap() = recess.clone();
        context.openings.push(engulf.clone());
        context.merged_openings = GeometryRouter::merge_rectangular_openings(&context.openings);
        let residual = context.bool2d.as_mut().unwrap().residual.as_mut().unwrap();
        residual.openings = vec![recess, engulf];
        residual.merged_openings = residual.openings.clone();
        let router = GeometryRouter::new();
        prior_host(&router);
        let mut before = take(&router);
        // Re-admit the earlier host's source diagnostic after the baseline
        // drain: the mixed attempt must preserve this existing entry.
        prior_host(&router);
        before.host = format!("{:?}", router.host_opening_diagnostics.borrow());
        before.failures = format!("{:?}", router.csg_failures.borrow());
        // The prior consumed flag is deliberately not drained by `take`.
        take_work();
        #[cfg(feature = "opening-perf-trace")]
        crate::opening_perf_trace::take();
        assert!(router
            .try_staged_bool2d(&host, context.bool2d.as_ref().unwrap(), 4617)
            .is_none());
        assert!(
            !router.host_consumed_by_void(4617),
            "rejected residual must undo its consumed marker"
        );
        assert!(router.host_consumed_by_void(7), "earlier host consumption survives rejection");
        assert_eq!(
            take(&router),
            before,
            "rejected residual must undo all route diagnostics"
        );
        let spent = take_work();
        // #6516: rejected work survives the route's atomic telemetry rollback.
        #[cfg(feature = "opening-perf-trace")]
        {
            let attempted = crate::opening_perf_trace::take();
            assert_eq!(attempted.staged_mixed_attempts, 1);
            assert_eq!(attempted.staged_residual_calls, 1);
            assert_eq!(attempted.staged_correction_refusals, 1);
            assert_eq!(attempted.staged_commits, 0);
            assert!(attempted.single_subtract_calls + attempted.group_subtract_calls > 0);
        }
        assert!(
            !spent.csg.is_empty(),
            "rejected candidate must retain its actual CSG invocations"
        );
        assert!(
            spent
                .csg
                .iter()
                .any(|&(op, a, b)| op == 0 && a > 0 && b > 0),
            "rejected subtraction must retain both operand triangle counts"
        );
        #[cfg(any(feature = "observability", feature = "csg_capture", feature = "debug_geometry"))]
        assert!(spent.weld[0].0 > 0, "rejected exact work must retain its weld calls");
    }
    let (staged, telemetry, work) = run(host.clone(), &context);
    context.bool2d = None;
    let (direct, expected, direct_work) = run(host, &context);
    assert_eq!(staged.positions, direct.positions);
    assert_eq!(staged.indices, direct.indices);
    assert_eq!(
        telemetry, expected,
        "only the committed full route is observable"
    );
    assert_eq!(telemetry.bool2d, (0, 0));
    if mode == "disabled" {
        // Budget escalation totals measure actual kernel work, independently
        // of transactional telemetry. Equal census alone could hide wasted CSG.
        assert!(
            direct_work.escalations > 0,
            "fixture must exercise the exact kernel"
        );
        assert_eq!(
            work, direct_work,
            "disabled correction must preflight before residual CSG"
        );
    }
}

thread_local! {
    static TERMINAL_GATE_READS: std::cell::Cell<(u32, u32)> = const { std::cell::Cell::new((0, 0)) };
    static STOP_IN_RESIDUAL: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}
fn no_gate() -> bool { false }
fn residual_stop_gate() -> bool {
    TERMINAL_GATE_READS.with(|reads| {
        let (parametric, prism) = reads.get();
        reads.set((parametric + 1, prism));
        if parametric == 1 && STOP_IN_RESIDUAL.with(std::cell::Cell::get) {
            crate::resource::stop(crate::resource::ProgramStop::Cancelled);
        }
    });
    false
}
fn correction_stop_gate() -> bool {
    TERMINAL_GATE_READS.with(|reads| {
        let (parametric, prism) = reads.get();
        reads.set((parametric, prism + 1));
        if prism == 2 { crate::resource::stop(crate::resource::ProgramStop::Cancelled); }
        // Preflight permits mandatory correction; the residual takes actual exact
        // CSG instead of the prism route, then the final correction gate stops.
        prism != 1
    })
}

#[test]
fn opening_terminal_port_staged_residual_and_correction_stop_do_not_replay() {
    const CHILD: &str = "IFC_LITE_OPENING_TERMINAL_STAGE_CHILD";
    let Ok(mode) = std::env::var(CHILD) else {
        for mode in ["residual", "correction"] {
            let output = std::process::Command::new(std::env::current_exe().unwrap())
                .args(["--exact", "router::voids::bool2d_path::transaction_tests::opening_terminal_port_staged_residual_and_correction_stop_do_not_replay", "--nocapture"])
                .env(CHILD, mode).env("IFC_LITE_VOID_2D", "1")
                .env("IFC_LITE_CSG_BUDGET", "0").output().unwrap();
            assert!(String::from_utf8_lossy(&output.stdout).contains("1 passed"));
            assert!(output.status.success(), "{mode}: {}\n{}",
                String::from_utf8_lossy(&output.stdout), String::from_utf8_lossy(&output.stderr));
        }
        return;
    };
    let router = GeometryRouter::new();
    prior_host(&router);
    take(&router);
    prior_host(&router);
    let prior = format!("{:?}", router.host_opening_diagnostics.borrow());
    let failures = format!("{:?}", router.csg_failures.borrow());
    take_work();
    let (host, context) = mixed_overlap_fixture();
    let account = crate::resource::ExecutionAccount::new(crate::resource::ExecutionPolicy::Bounded(crate::resource::ResourceLimits::default()));
    STOP_IN_RESIDUAL.with(|stop| stop.set(mode == "residual"));
    TERMINAL_GATE_READS.with(|reads| reads.set((0, 0)));
    account.scope(|| {
        let outcome = crate::program::openings::execute::ReadyOperation::new(
            host, std::sync::Arc::new(context), 4617, crate::TessellationQuality::default(),
            crate::program::openings::execute::Configuration {
                parametric: GatePolicy::Test(residual_stop_gate), prism: GatePolicy::Test(correction_stop_gate),
                rectangular: GatePolicy::Test(no_gate), coaxial_union: GatePolicy::Test(no_gate),
            }).execute();
        assert!(matches!(outcome.publish(&router),
            Err(crate::Error::ProgramStopped(crate::resource::ProgramStop::Cancelled))));
    });
    let reads = TERMINAL_GATE_READS.with(std::cell::Cell::get);
    assert_eq!(reads, if mode == "residual" { (2, 1) } else { (2, 3) },
        "a stopped prefix must never retry the full original opening set");
    assert!(router.host_consumed_by_void(7));
    assert!(!router.host_consumed_by_void(4617));
    assert_eq!(format!("{:?}", router.host_opening_diagnostics.borrow()), prior);
    assert_eq!(format!("{:?}", router.csg_failures.borrow()), failures);
    assert_eq!(super::take_bool2d_stats(), (0, 0), "abandoned prefix telemetry drops");
    assert_eq!(account.check(), Err(crate::resource::ProgramStop::Cancelled));
    if mode == "correction" {
        assert!(!take_work().csg.is_empty(), "completed residual exact work remains spent");
    }
}

fn residual_only_prism_gate() -> bool {
    TERMINAL_GATE_READS.with(|reads| {
        let (parametric, prism) = reads.get();
        assert_eq!(prism, 0, "empty correction must not re-read the prism gate");
        reads.set((parametric, prism + 1));
    });
    false
}
#[test]
fn opening_terminal_port_empty_correction_preserves_lazy_prism() {
    let (host, mut context) = mixed_overlap_fixture();
    // Distinct disjoint footprints require no mandatory overlap corrections.
    context.bool2d.as_mut().unwrap().footprints.remove(0);
    TERMINAL_GATE_READS.with(|reads| reads.set((0, 0)));
    STOP_IN_RESIDUAL.with(|stop| stop.set(false));
    let router = GeometryRouter::new();
    let result = crate::program::openings::execute::ReadyOperation::new(
        host, std::sync::Arc::new(context), 4617, crate::TessellationQuality::default(),
        crate::program::openings::execute::Configuration {
            parametric: GatePolicy::Test(residual_stop_gate), prism: GatePolicy::Test(residual_only_prism_gate),
            rectangular: GatePolicy::Test(no_gate), coaxial_union: GatePolicy::Test(no_gate),
        }).execute().publish(&router).unwrap();
    assert!((crate::mesh_check::signed_volume(&result).abs() - 90.5).abs() < 1e-5);
    assert_eq!(TERMINAL_GATE_READS.with(std::cell::Cell::get), (2, 1));
}
