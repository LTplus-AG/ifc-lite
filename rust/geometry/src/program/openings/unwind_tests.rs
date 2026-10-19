// SPDX-License-Identifier: MPL-2.0
//! Opening extraction invariant: reached root kernel evidence survives unwind.
use super::{Configuration, Execution, GatePolicy, NumericalOutcome};
use crate::{kernel::budget, GeometryRouter, Mesh, Point3, TessellationQuality};
use std::{panic::{catch_unwind, AssertUnwindSafe}, sync::Arc};

fn disabled() -> bool { false }
fn configuration() -> Configuration {
    Configuration { parametric: GatePolicy::Test(disabled), rectangular: GatePolicy::Test(disabled),
        prism: GatePolicy::Test(disabled), coaxial_union: GatePolicy::Test(disabled) }
}

// The same closed off-grid flanking solids as the existing capped-cut witness.
// Their combined AABB engulfs the host while their solid leaves its centre free.
fn box_mesh(center_x: f64, half: [f64; 3]) -> Mesh {
    let corner = |x: f64, y: f64, z: f64| Point3::new(
        center_x + x * half[0], y * half[1], z * half[2]);
    let corners = [corner(-1., -1., -1.), corner(1., -1., -1.),
        corner(1., 1., -1.), corner(-1., 1., -1.), corner(-1., -1., 1.),
        corner(1., -1., 1.), corner(1., 1., 1.), corner(-1., 1., 1.)];
    let mut mesh = Mesh::new();
    for face in [[0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4],
        [2, 3, 7, 6], [0, 4, 7, 3], [1, 2, 6, 5]] {
        let normal = (corners[face[1]] - corners[face[0]])
            .cross(&(corners[face[2]] - corners[face[0]])).normalize();
        let base = mesh.vertex_count() as u32;
        for index in face { mesh.add_vertex(corners[index], normal); }
        mesh.add_triangle(base, base + 1, base + 2);
        mesh.add_triangle(base, base + 2, base + 3);
    }
    mesh
}
struct RestoreBudget { cap: Option<u64>, element: Option<u64> }
impl Drop for RestoreBudget {
    fn drop(&mut self) {
        budget::test_caps::set_element_cap(None);
        budget::begin_element();
        budget::test_caps::set_cap(self.cap);
        budget::test_caps::set_element_cap(self.element);
    }
}

#[test]
fn opening_root_unwind_drains_real_capped_failure_and_preserves_payload_once() {
    const CHILD: &str = "IFC_LITE_OPENING_ROOT_FAILURE_UNWIND_CHILD";
    if std::env::var_os(CHILD).is_none() {
        let name = "program::openings::execute::unwind_tests::opening_root_unwind_drains_real_capped_failure_and_preserves_payload_once";
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", name, "--nocapture"]).env(CHILD, "1")
            .env_remove("IFC_LITE_CSG_BUDGET").env_remove("IFC_LITE_CSG_ELEMENT_BUDGET")
            .output().unwrap();
        assert!(output.status.success(), "{}\n{}", String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr));
        assert!(String::from_utf8_lossy(&output.stdout).contains("1 passed; 0 failed"));
        return;
    }
    let _lock = budget::GLOBAL_CAP_LOCK.lock().unwrap();
    let _test_caps = budget::test_caps::scope();
    let _restore = RestoreBudget { cap: budget::cap(), element: budget::element_cap() };
    // An unbounded per-boolean profile also disables the element cap.
    budget::test_caps::set_cap(Some(budget::DEFAULT_CAP));
    budget::test_caps::set_element_cap(Some(1));
    budget::begin_element();
    crate::csg::take_csg_census();
    let host = box_mesh(0., [1., 0.15, 1.]);
    let mut cutter = box_mesh(-0.8, [0.5, 0.15 + 1.3e-4, 1.0 + 1.7e-4]);
    cutter.merge(&box_mesh(0.8, [0.5, 0.15 + 1.3e-4, 1.0 + 1.7e-4]));
    assert!(crate::mesh_check::closed_enough_to_emit(&host));
    assert!(crate::mesh_check::closed_enough_to_emit(&cutter));
    let router = GeometryRouter::new();
    let execution = Execution::new(TessellationQuality::default(), configuration());
    let clipper = crate::csg::ClippingProcessor::new();
    let payload = Arc::new(String::from("original opening numerical panic"));
    let (result, telemetry) = crate::telemetry_transaction::capture(|| {
        catch_unwind(AssertUnwindSafe(|| -> crate::Result<Mesh> {
            let _failures = execution.capture_failures(&clipper, 91111);
            let cut = clipper.subtract_mesh(&host, &cutter);
            assert!(matches!(cut, crate::csg::GroupCut::Rejected(_)));
            assert!(budget::tripped(), "real exact-predicate cap must trip");
            assert_eq!(clipper.failure_count(), 1, "real kernel recorded one failure");
            // Deliberately unwind after real work, before the ordinary finalizer.
            std::panic::panic_any(Arc::clone(&payload));
        }))
    });
    assert!(clipper.take_failures().is_empty(), "unwind guard drained the processor");
    assert!(router.take_csg_failures().is_empty(), "owned evidence is not yet published");
    let outcome = NumericalOutcome { result, effects: execution.finish(), telemetry };
    let resumed = catch_unwind(AssertUnwindSafe(|| outcome.publish(&router)))
        .expect_err("publication must resume the original panic");
    let resumed = resumed.downcast::<Arc<String>>().expect("original payload type");
    assert!(Arc::ptr_eq(&payload, &resumed), "panic payload identity is preserved");
    let failures = router.take_csg_failures();
    assert_eq!(failures.len(), 1);
    assert_eq!(failures[&91111].len(), 1);
    assert_eq!(failures[&91111][0].product_id, Some(91111));
    assert!(matches!(failures[&91111][0].reason,
        crate::diagnostics::BoolFailureReason::OperandTooLarge { .. }));
    let diagnostics = router.take_host_opening_diagnostics();
    assert_eq!(diagnostics.len(), 1);
    assert_eq!(diagnostics[&91111].csg_failure_count, 1);
    assert!(diagnostics[&91111].first_failure_label.is_some());
    assert!(diagnostics[&91111].tris_after.is_none());
    assert!(!router.host_consumed_by_void(91111));
    assert!(router.take_csg_failures().is_empty(), "no duplicate failure publication");
    assert!(router.take_host_opening_diagnostics().is_empty(), "no duplicate summary");
    assert_eq!(crate::csg::take_csg_census().len(), 1, "only the real subtraction ran");
}
