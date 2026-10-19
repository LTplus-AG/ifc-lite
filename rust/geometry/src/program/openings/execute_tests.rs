// SPDX-License-Identifier: MPL-2.0
//! Opening terminal-port invariants use real numerical cuts, with lazy policy probes.
use super::{Configuration, GatePolicy, ReadyOperation};
use crate::router::voids::{OpeningType, ParamRectCut, RectParam, VoidContext};
use crate::{resource, GeometryRouter, Mesh, Point3, TessellationQuality, Vector3};
use std::cell::Cell;

thread_local! {
    static LATE_READS: Cell<u32> = const { Cell::new(0) };
}
fn enabled() -> bool { true }
fn forbidden_late_gate() -> bool {
    LATE_READS.with(|n| n.set(n.get() + 1));
    panic!("a successful parametric cut must never reach a later gate")
}
fn policy() -> Configuration {
    Configuration { parametric: GatePolicy::Test(enabled), rectangular: GatePolicy::Test(forbidden_late_gate),
        prism: GatePolicy::Test(forbidden_late_gate), coaxial_union: GatePolicy::Test(forbidden_late_gate) }
}
fn parametric_fixture() -> (Mesh, VoidContext) {
    let profile = crate::profile::Profile2D::new(vec![
        nalgebra::Point2::new(-5., -5.), nalgebra::Point2::new(5., -5.),
        nalgebra::Point2::new(5., 5.), nalgebra::Point2::new(-5., 5.),
    ]);
    let host = crate::extrusion::extrude_profile_watertight(&profile, 1.,
        Some(nalgebra::Matrix4::new_translation(&Vector3::new(0., 0., -0.5)))).unwrap();
    let rectangle = |half| RectParam {
        r: nalgebra::Matrix3::identity(), center: Point3::origin(), half,
    };
    let opening = OpeningType::Rectangular(Point3::new(-1., -1., -1.),
        Point3::new(1., 1., 1.), Some(Vector3::z()));
    let context = VoidContext {
        openings: vec![opening.clone()], merged_openings: vec![opening],
        param: Some(ParamRectCut { host: rectangle([5., 5., 0.5]),
            openings: vec![rectangle([1., 1., 1.])] }), bool2d: None,
    };
    (host, context)
}
#[test]
fn opening_terminal_port_parametric_success_preserves_lazy_gate_order() {
    LATE_READS.with(|n| n.set(0));
    let (host, context) = parametric_fixture();
    let router = GeometryRouter::new();
    let result = ReadyOperation::new(host, std::sync::Arc::new(context), 910, TessellationQuality::default(), policy())
        .execute().publish(&router).unwrap();
    assert!((crate::mesh_check::signed_volume(&result).abs() - 96.).abs() < 1e-5);
    assert_eq!(LATE_READS.with(Cell::get), 0);
}
#[test]
fn opening_terminal_port_late_publish_stop_discards_current_host_effects() {
    let router = GeometryRouter::new();
    let account = resource::ExecutionAccount::default();
    account.scope(|| {
        let mut decoder = ifc_lite_core::EntityDecoder::new(
            "#1=IFCBLOCK($,2.,3.,4.);\n#2=IFCSHAPEREPRESENTATION($,'Body','CSG',(#1));\n#3=IFCPRODUCTDEFINITIONSHAPE($,$,(#2));\n#7=IFCWALL('host',$,$,$,$,$,#3,$);\n#8=IFCOPENINGELEMENT('void',$,$,$,$,$,#3,$);");
        let host = decoder.decode_by_id(7).unwrap();
        let mesh = router.process_element(&host, &mut decoder).unwrap();
        let context = crate::program::ProductProgram::host_openings(&host, &[8])
            .run(&router, &mut decoder).unwrap();
        let outcome = ReadyOperation::new(mesh, std::sync::Arc::new(context), 7, TessellationQuality::default(),
            crate::router::voids::numerical_configuration()).execute();
        resource::stop(resource::ProgramStop::Cancelled);
        assert!(matches!(outcome.publish(&router), Err(crate::Error::ProgramStopped(resource::ProgramStop::Cancelled))));
        assert!(!router.host_consumed_by_void(7));
        assert!(router.take_host_opening_diagnostics()[&7].tris_after.is_none());
    });
}

struct GateMutatingBlock(std::rc::Rc<Cell<u32>>);
impl crate::GeometryProcessor for GateMutatingBlock {
    fn supported_types(&self) -> Vec<ifc_lite_core::IfcType> { vec![ifc_lite_core::IfcType::IfcBlock] }
    fn process(&self, entity: &ifc_lite_core::DecodedEntity, decoder: &mut ifc_lite_core::EntityDecoder,
        schema: &ifc_lite_core::IfcSchema, quality: TessellationQuality) -> crate::Result<Mesh> {
        self.0.set(self.0.get() + 1);
        std::env::set_var("IFC_LITE_PRISM_CUT", "0");
        std::env::set_var("IFC_LITE_VOID_UNION", "0");
        crate::GeometryProcessor::process(&crate::processors::BlockProcessor::new(), entity, decoder, schema, quality)
    }
}
#[test]
fn opening_terminal_port_late_selected_callback_mutates_unreached_env_gates() {
    const CHILD: &str = "IFC_LITE_LAZY_OPENING_GATE_CHILD";
    if std::env::var_os(CHILD).is_none() {
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "program::openings::execute::tests::opening_terminal_port_late_selected_callback_mutates_unreached_env_gates", "--nocapture"])
            .env(CHILD, "1").env("IFC_LITE_RECT_PARAM", "1")
            .env("IFC_LITE_RECT_FAST", "1").env("IFC_LITE_PRISM_CUT", "1")
            .env("IFC_LITE_VOID_UNION", "1").output().unwrap();
        assert!(output.status.success(), "{}\n{}", String::from_utf8_lossy(&output.stdout), String::from_utf8_lossy(&output.stderr));
        assert!(String::from_utf8_lossy(&output.stdout).contains("1 passed"));
        return;
    }
    let (host, context) = parametric_fixture();
    let router = GeometryRouter::new();
    let first = ReadyOperation::new(host, std::sync::Arc::new(context), 910, TessellationQuality::default(),
        crate::router::voids::numerical_configuration()).execute().publish(&router).unwrap();
    assert!((crate::mesh_check::signed_volume(&first).abs() - 96.).abs() < 1e-5);
    let configuration = crate::router::voids::numerical_configuration();
    let calls = std::rc::Rc::new(Cell::new(0));
    let mut later = GeometryRouter::new();
    later.register(Box::new(GateMutatingBlock(calls.clone())));
    let mut decoder = ifc_lite_core::EntityDecoder::new(
        "#1=IFCBLOCK($,2.,3.,4.);#2=IFCSHAPEREPRESENTATION($,'Body','CSG',(#1));#3=IFCPRODUCTDEFINITIONSHAPE($,$,(#2));#7=IFCWALL('late',$,$,$,$,$,#3,$);");
    let element = decoder.decode_by_id(7).unwrap();
    let real = later.process_element(&element, &mut decoder).unwrap();
    assert!((crate::mesh_check::signed_volume(&real).abs() - 24.).abs() < 1e-5);
    assert_eq!(calls.get(), 1);
    assert!(!configuration.prism.read(), "earlier success must not initialize the prism OnceLock");
    assert!(!configuration.coaxial_union.read(), "earlier success must not initialize the union OnceLock");
}


// Same real capped-kernel geometry as the engulf-suppression invariant: two
// closed boxes flank the host centre, so their AABB engulfs but their solid does
// not consume it. Preserve the canonical face/corner order of that fixture.
fn capped_box(center_x: f64, half: [f64; 3]) -> Mesh {
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
fn disabled() -> bool { false }

#[test]
fn opening_terminal_port_late_stop_retains_completed_root_kernel_failure() {
    const CHILD: &str = "IFC_LITE_OPENING_FAILURE_ACCEPTANCE_CHILD";
    if std::env::var_os(CHILD).is_none() {
        let name = "program::openings::execute::tests::opening_terminal_port_late_stop_retains_completed_root_kernel_failure";
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", name, "--nocapture"]).env(CHILD, "1")
            .env_remove("IFC_LITE_CSG_BUDGET").env_remove("IFC_LITE_CSG_ELEMENT_BUDGET")
            .output().unwrap();
        assert!(output.status.success(), "{}\n{}", String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr));
        assert!(String::from_utf8_lossy(&output.stdout).contains("1 passed; 0 failed"));
        return;
    }
    use crate::kernel::budget;
    let _cap_guard = budget::GLOBAL_CAP_LOCK.lock().unwrap();
    struct RestoreBudget { cap: Option<u64>, element: Option<u64> }
    impl Drop for RestoreBudget {
        fn drop(&mut self) {
            budget::set_element_cap(None);
            budget::begin_element();
            budget::set_cap(self.cap);
            budget::set_element_cap(self.element);
        }
    }
    let _restore = RestoreBudget { cap: budget::cap(), element: budget::element_cap() };
    budget::set_cap(Some(budget::DEFAULT_CAP));
    let router = GeometryRouter::new();
    // A real successful route creates success telemetry, which must remain
    // unpublished if acceptance is stopped (not merely stay zero on a miss).
    crate::rect_fast::take_param_fires();
    resource::ExecutionAccount::default().scope(|| {
        let (host, context) = parametric_fixture();
        let outcome = ReadyOperation::new(host, std::sync::Arc::new(context), 91108,
            TessellationQuality::default(), policy()).execute();
        let mesh = outcome.result.as_ref().unwrap().as_ref().unwrap();
        assert!((crate::mesh_check::signed_volume(mesh).abs() - 96.).abs() < 1e-5);
        resource::stop(resource::ProgramStop::Cancelled);
        assert!(matches!(outcome.publish(&router),
            Err(crate::Error::ProgramStopped(resource::ProgramStop::Cancelled))));
        assert_eq!(crate::rect_fast::take_param_fires(), 0);
        assert_eq!(router.take_rect_fast_stats(), crate::rect_fast::RectFastStats::default());
    });
    let host = capped_box(0., [1., 0.15, 1.]);
    let mut cutter = capped_box(-0.8, [0.5, 0.15 + 1.3e-4, 1.0 + 1.7e-4]);
    cutter.merge(&capped_box(0.8, [0.5, 0.15 + 1.3e-4, 1.0 + 1.7e-4]));
    let (lo, hi) = cutter.bounds();
    let opening = OpeningType::NonRectangular(cutter, lo.cast(), hi.cast(), None);
    let context = VoidContext { openings: vec![opening.clone()],
        merged_openings: vec![opening], param: None, bool2d: None };
    let configuration = Configuration { parametric: GatePolicy::Test(disabled), rectangular: GatePolicy::Test(disabled),
        prism: GatePolicy::Test(disabled), coaxial_union: GatePolicy::Test(disabled) };
    crate::csg::take_csg_census();
    crate::router::voids::take_bool2d_stats();
    crate::router::voids::take_prism_stats();
    crate::rect_fast::take_param_fires();
    budget::set_element_cap(Some(1));
    budget::begin_element();
    resource::ExecutionAccount::default().scope(|| {
        let outcome = ReadyOperation::new(host, std::sync::Arc::new(context), 91109,
            TessellationQuality::default(), configuration).execute();
        let completed = outcome.result.as_ref().expect("real numerical work did not panic")
            .as_ref().expect("kernel budget fallback completed before cancellation");
        assert!(budget::tripped(), "the real numerical subtraction must exhaust the element cap");
        assert_eq!(completed.triangle_count(), 12);
        assert!((crate::mesh_check::signed_volume(completed).abs() - 1.2).abs() < 1e-6,
            "capped host volume {}, expected 1.2", crate::mesh_check::signed_volume(completed).abs());
        assert!(crate::mesh_check::closed_enough_to_emit(completed));
        assert_eq!(crate::csg::take_csg_census().len(), 1,
            "one actual capped subtraction, with no numerical retry");
        assert!(router.take_csg_failures().is_empty(), "publication is still pending");
        resource::stop(resource::ProgramStop::Cancelled);
        assert!(matches!(outcome.publish(&router),
            Err(crate::Error::ProgramStopped(resource::ProgramStop::Cancelled))));
        assert!(crate::csg::take_csg_census().is_empty(), "acceptance does not retry geometry");
        let failures = router.take_csg_failures();
        assert_eq!(failures.len(), 1);
        assert_eq!(failures[&91109].len(), 1);
        assert_eq!(failures[&91109][0].product_id, Some(91109));
        assert!(matches!(failures[&91109][0].reason,
            crate::diagnostics::BoolFailureReason::OperandTooLarge { .. }));
        let diagnostics = router.take_host_opening_diagnostics();
        assert_eq!(diagnostics[&91109].csg_failure_count, 1);
        assert!(diagnostics[&91109].first_failure_label.is_some());
        assert!(diagnostics[&91109].tris_after.is_none());
        assert!(!router.host_consumed_by_void(91109));
        assert_eq!(router.take_rect_fast_stats(), crate::rect_fast::RectFastStats::default());
        assert_eq!(crate::router::voids::take_bool2d_stats(), (0, 0));
        assert_eq!(crate::router::voids::take_prism_stats(), (0, 0, 0));
        assert_eq!(crate::rect_fast::take_param_fires(), 0);
        assert!(router.take_csg_failures().is_empty(), "reached failure publishes once");
    });

    // The same production guard must also retain a real kernel failure when
    // the terminal barrier exits before finish_void_cut's ordinary drain.
    budget::begin_element();
    resource::ExecutionAccount::default().scope(|| {
        let host = capped_box(0., [1., 0.15, 1.]);
        let mut cutter = capped_box(-0.8, [0.5, 0.15 + 1.3e-4, 1.0 + 1.7e-4]);
        cutter.merge(&capped_box(0.8, [0.5, 0.15 + 1.3e-4, 1.0 + 1.7e-4]));
        assert!(crate::mesh_check::closed_enough_to_emit(&host));
        assert!(crate::mesh_check::closed_enough_to_emit(&cutter));
        let execution = super::Execution::new(TessellationQuality::default(), configuration);
        let clipper = crate::csg::ClippingProcessor::new();
        {
            let _failures = execution.capture_failures(&clipper, 91110);
            let result = clipper.subtract_mesh(&host, &cutter);
            assert!(matches!(result, crate::csg::GroupCut::Rejected(_)));
            assert!(budget::tripped(), "the real exact-predicate allowance was exhausted");
            resource::stop(resource::ProgramStop::Cancelled);
            assert_eq!(resource::check_current(), Err(resource::ProgramStop::Cancelled));
            // Scope exit is the actual production early-return drain, with no
            // call to the ordinary numerical finalizer and no fallback cut.
        }
        assert!(clipper.take_failures().is_empty(), "guard drained exactly once");
        execution.finish().publish_failures(&router);
        let failures = router.take_csg_failures();
        assert_eq!(failures.len(), 1);
        assert_eq!(failures[&91110].len(), 1);
        assert_eq!(failures[&91110][0].product_id, Some(91110));
        assert!(matches!(failures[&91110][0].reason,
            crate::diagnostics::BoolFailureReason::OperandTooLarge { .. }));
        let diagnostics = router.take_host_opening_diagnostics();
        assert_eq!(diagnostics[&91110].csg_failure_count, 1);
        assert!(diagnostics[&91110].tris_after.is_none());
        assert!(!router.host_consumed_by_void(91110));
        assert_eq!(crate::csg::take_csg_census().len(), 1, "no fallback or retry work");
    });
}

#[test]
fn opening_ready_packets_share_one_owned_context_across_independent_host_parts() {
    let (host, context) = parametric_fixture();
    let context = std::sync::Arc::new(context);
    let retained = std::sync::Arc::downgrade(&context);
    let first = ReadyOperation::new(host.clone(), std::sync::Arc::clone(&context), 911,
        TessellationQuality::default(), policy());
    let second = ReadyOperation::new(host, std::sync::Arc::clone(&context), 912,
        TessellationQuality::default(), policy());
    drop(context);
    let router = GeometryRouter::new();
    let first = first.execute().publish(&router).unwrap();
    assert!((crate::mesh_check::signed_volume(&first).abs() - 96.).abs() < 1e-5);
    assert!(retained.upgrade().is_some(), "the pending second real cut retains its immutable context");
    let second = second.execute().publish(&router).unwrap();
    assert!((crate::mesh_check::signed_volume(&second).abs() - 96.).abs() < 1e-5);
    assert!(retained.upgrade().is_none(), "the final execution releases the shared context");
}

#[test]
fn dormant_opening_numerical_packets_are_send() {
    fn assert_send<T: Send>() {}
    assert_send::<ReadyOperation>();
    assert_send::<super::NumericalOutcome>();
}
