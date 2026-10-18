// SPDX-License-Identifier: MPL-2.0
//! Opening extraction invariant: rejected staged work owns its kernel evidence.
use super::{tests::mixed_overlap_fixture, GeometryRouter, Mesh, VoidContext};
use crate::kernel::budget;
use crate::program::openings::execute::{Configuration, Execution};
use crate::{resource, TessellationQuality};
use std::{cell::{Cell, RefCell}, panic::{catch_unwind, AssertUnwindSafe}, sync::Arc};

thread_local! {
    static GATES: Cell<u32> = const { Cell::new(0) };
    static PANIC: RefCell<Option<Arc<String>>> = const { RefCell::new(None) };
}
fn disabled() -> bool { false }
fn correction_gate() -> bool {
    GATES.with(|reads| {
        let n = reads.get() + 1;
        reads.set(n);
        match n {
            1 => true, // mandatory-correction preflight
            2 => false, // actual residual must use the exact kernel
            3 => {
                assert!(budget::tripped(), "real residual exact work must exhaust the cap");
                if let Some(payload) = PANIC.with(|p| p.borrow().clone()) {
                    std::panic::panic_any(payload);
                }
                resource::stop(resource::ProgramStop::Cancelled);
                true
            }
            _ => panic!("rejected staged work must not retry or read another gate"),
        }
    })
}
fn configuration(prism: fn() -> bool) -> Configuration {
    Configuration { parametric: disabled, rectangular: disabled,
        prism, coaxial_union: disabled }
}
fn mesh_box() -> Mesh {
    let profile = crate::profile::Profile2D::new(vec![
        nalgebra::Point2::new(1., 1.), nalgebra::Point2::new(3., 1.),
        nalgebra::Point2::new(3., 3.), nalgebra::Point2::new(1., 3.),
    ]);
    let mut mesh = crate::extrusion::extrude_profile_watertight(&profile, 1.5, None).unwrap();
    for p in mesh.positions.chunks_exact_mut(3) {
        p[2] -= 1.;
        if p[2] > 0. {
            p[0] = 2. + (p[0] - 2.) * 0.5 + 1.3e-4;
            p[1] = 2. + (p[1] - 2.) * 0.5 + 1.7e-4;
        }
    }
    mesh
}
fn fixture() -> (Mesh, VoidContext) {
    let (host, mut context) = mixed_overlap_fixture();
    // A tapered, off-grid, partial-depth residual forces actual exact work.
    // The duplicate through-footprints retain the mandatory correction gate.
    let cutter = mesh_box();
    assert!(crate::mesh_check::closed_enough_to_emit(&cutter));
    let (lo, hi) = cutter.bounds();
    let opening = super::super::OpeningType::NonRectangular(cutter, lo.cast(), hi.cast(), None);
    *context.openings.last_mut().unwrap() = opening.clone();
    context.merged_openings = GeometryRouter::merge_rectangular_openings(&context.openings);
    let residual = context.bool2d.as_mut().unwrap().residual.as_mut().unwrap();
    residual.openings = vec![opening.clone()];
    residual.merged_openings = vec![opening];
    (host, context)
}
struct RestoreBudget { cap: Option<u64>, element: Option<u64> }
impl Drop for RestoreBudget {
    fn drop(&mut self) {
        PANIC.with(|p| *p.borrow_mut() = None);
        budget::set_element_cap(None);
        budget::begin_element();
        budget::set_cap(self.cap);
        budget::set_element_cap(self.element);
    }
}
fn positive_control(host: &Mesh, context: &VoidContext) -> Vec<(u8, u32, u32)> {
    let preparation = Execution::new(TessellationQuality::default(), configuration(disabled));
    let (prepared, telemetry) = crate::telemetry_transaction::capture(||
        preparation.try_bool2d_cut(host, context.bool2d.as_ref().unwrap()).unwrap().unwrap());
    drop(telemetry);
    let (precursor, corrections) = prepared;
    assert!(!corrections.is_empty(), "actual staged prefix requires a later correction");
    assert!(crate::mesh_check::closed_enough_to_emit(&precursor));
    assert!((crate::mesh_check::signed_volume(&precursor).abs() - 96.).abs() < 1e-5);
    let residual = context.bool2d.as_ref().unwrap().residual.as_ref().unwrap();
    budget::set_element_cap(Some(1));
    budget::begin_element();
    crate::csg::take_csg_census();
    let control = Execution::new(TessellationQuality::default(), configuration(disabled));
    let router = GeometryRouter::new();
    let (result, telemetry) = crate::telemetry_transaction::capture(||
        control.apply_void_context(precursor, residual, 4618));
    drop(telemetry);
    let result = result.expect("real capped residual retains its established geometry recovery");
    assert!(!result.is_empty());
    assert!(budget::tripped());
    control.finish().publish(&router);
    let failures = router.take_csg_failures();
    assert!(failures[&4618].iter().any(|failure| matches!(failure.reason,
        crate::diagnostics::BoolFailureReason::OperandTooLarge { .. })),
        "the exact same real precursor/residual must positively record a capped failure");
    let spent = crate::csg::take_csg_census();
    assert!(!spent.is_empty());
    spent.iter().map(|entry| (entry.op, entry.a_tris, entry.b_tris)).collect()
}
fn earlier_host(router: &GeometryRouter) {
    let mut decoder = ifc_lite_core::EntityDecoder::new(
        "#1=IFCBLOCK($,2.,3.,4.);#2=IFCSHAPEREPRESENTATION($,'Body','CSG',(#1));
#3=IFCPRODUCTDEFINITIONSHAPE($,$,(#2));#7=IFCWALL('earlier',$,$,$,$,$,#3,$);
#8=IFCOPENINGELEMENT('void',$,$,$,$,$,#3,$);");
    let host = decoder.decode_by_id(7).unwrap();
    let voids = [(7, vec![8])].into_iter().collect();
    assert!(router.process_element_with_voids(&host, &mut decoder, &voids).unwrap().is_empty());
    assert!(router.host_consumed_by_void(7));
}
fn clear_telemetry(router: &GeometryRouter) {
    super::take_bool2d_stats();
    super::super::take_prism_stats();
    super::super::take_prism_defers();
    crate::rect_fast::take_param_fires();
    router.take_rect_fast_stats();
}
fn assert_no_telemetry(router: &GeometryRouter) {
    assert_eq!(super::take_bool2d_stats(), (0, 0));
    assert_eq!(super::super::take_prism_stats(), (0, 0, 0));
    assert!(super::super::take_prism_defers().iter().all(|(_, count)| *count == 0));
    assert_eq!(crate::rect_fast::take_param_fires(), 0);
    assert_eq!(router.take_rect_fast_stats(), crate::rect_fast::RectFastStats::default());
}

#[test]
fn staged_real_capped_child_failure_drops_on_correction_stop_or_unwind() {
    const CHILD: &str = "IFC_LITE_STAGED_KERNEL_FAILURE_ROLLBACK_CHILD";
    let Ok(mode) = std::env::var(CHILD) else {
        for mode in ["panic", "terminal"] {
            let name = "router::voids::bool2d_path::kernel_rollback_tests::staged_real_capped_child_failure_drops_on_correction_stop_or_unwind";
            let output = std::process::Command::new(std::env::current_exe().unwrap())
                .args(["--exact", name, "--nocapture"]).env(CHILD, mode)
                .env("IFC_LITE_VOID_2D", "1").env("IFC_LITE_CSG_BUDGET", "0")
                .output().unwrap();
            assert!(output.status.success(), "{mode}: {}\n{}",
                String::from_utf8_lossy(&output.stdout), String::from_utf8_lossy(&output.stderr));
            assert!(String::from_utf8_lossy(&output.stdout).contains("1 passed; 0 failed"));
        }
        return;
    };
    let _lock = budget::GLOBAL_CAP_LOCK.lock().unwrap();
    let _restore = RestoreBudget { cap: budget::cap(), element: budget::element_cap() };
    budget::set_cap(None);
    budget::set_element_cap(None);
    budget::begin_element();
    let (host, context) = fixture();
    let expected_work = positive_control(&host, &context);
    budget::set_element_cap(None);
    budget::begin_element();
    let router = GeometryRouter::new();
    earlier_host(&router);
    let prior = format!("{:?}", router.host_opening_diagnostics.borrow());
    let prior_failures = format!("{:?}", router.csg_failures.borrow());
    clear_telemetry(&router);
    crate::csg::take_csg_census();
    budget::set_element_cap(Some(1));
    budget::begin_element();
    GATES.with(|n| n.set(0));
    let payload = Arc::new(String::from("original staged correction panic"));
    PANIC.with(|p| *p.borrow_mut() = (mode == "panic").then(|| payload.clone()));
    let parent = Execution::new(TessellationQuality::default(), configuration(correction_gate));
    resource::ExecutionAccount::default().scope(|| {
        let result = catch_unwind(AssertUnwindSafe(||
            parent.try_staged_bool2d(&host, context.bool2d.as_ref().unwrap(), 4617)));
        if mode == "panic" {
            let panic = result.expect_err("actual correction gate must unwind");
            let panic = panic.downcast::<Arc<String>>().expect("original panic type");
            assert!(Arc::ptr_eq(&payload, &panic));
        } else {
            assert!(matches!(result.unwrap(), Err(crate::Error::ProgramStopped(resource::ProgramStop::Cancelled))));
        }
    });
    assert_eq!(GATES.with(Cell::get), 3, "no retry after the reached correction gate");
    parent.finish().publish(&router);
    assert_eq!(format!("{:?}", router.host_opening_diagnostics.borrow()), prior);
    assert_eq!(format!("{:?}", router.csg_failures.borrow()), prior_failures);
    assert!(router.host_consumed_by_void(7));
    assert!(!router.host_consumed_by_void(4617));
    assert_no_telemetry(&router);
    let spent: Vec<_> = crate::csg::take_csg_census().iter()
        .map(|entry| (entry.op, entry.a_tris, entry.b_tris)).collect();
    assert_eq!(spent, expected_work,
        "the same actual residual work stays spent, with no full-set retry");
}
