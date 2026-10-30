// SPDX-License-Identifier: MPL-2.0
#![cfg(feature = "retained-runtime")]
//! #7955: a Boolean result whose BRep is non-manifold (SMLib reports
//! `inputManifold=false`) must come back from the adapter as a typed kernel
//! refusal, never as a tessellation "success" carrying spine/lamina edges that
//! the Rust and browser readers then retire as a malformed reply.
use ifc_lite_core::SourceBundle;
use ifc_lite_geometry_runtime::{protocol::BooleanOperation, MeshLimits, SmlibWorker, WorkerError};
use ifc_lite_processing::element::retained_runtime::{
    ModelOptions, ProductOutcome, RetainedProductRefusal,
};
use ifc_lite_retained_native::run_model_native;

const STRAIGHT: &str = include_str!("../../../tests/fixtures/cli-retained/layered-wall.ifc");

fn worker_path() -> Option<std::ffi::OsString> {
    let path = std::env::var_os("IFCLITE_SMLIB_WORKER");
    if path.is_none() {
        assert!(std::env::var_os("IFCLITE_REQUIRE_SMLIB").is_none(), "real SDK worker required");
        eprintln!("SKIP open tessellation: set IFCLITE_SMLIB_WORKER; not acceptance evidence");
    }
    path
}

/// Unit cubes [0,1]^3 and [1,2]x[1,2]x[0,1] share only the edge x=y=1. Their
/// union is a valid point set but not a 2-manifold solid: that edge has four
/// incident faces, so SMLib reports the BRep non-manifold and its strict
/// tessellation carries spine edges.
fn edge_touching_union() -> String {
    STRAIGHT
        .replace(
            "#19=IFCEXTRUDEDAREASOLID(#18,#2,#3,3.);",
            "#19=IFCBOOLEANRESULT(.UNION.,#90,#91);\
             #90=IFCEXTRUDEDAREASOLID(#92,#2,#3,1.);#91=IFCEXTRUDEDAREASOLID(#94,#2,#3,1.);\
             #92=IFCRECTANGLEPROFILEDEF(.AREA.,$,#93,1.,1.);#93=IFCAXIS2PLACEMENT2D(#95,$);\
             #94=IFCRECTANGLEPROFILEDEF(.AREA.,$,#96,1.,1.);#96=IFCAXIS2PLACEMENT2D(#97,$);\
             #95=IFCCARTESIANPOINT((0.5,0.5));#97=IFCCARTESIANPOINT((1.5,1.5));",
        )
        .replace("'Body','SweptSolid'", "'Body','CSG'")
        // A plain (non-layer) Boolean product: drop the material layer usage.
        .replace("#84=IFCRELASSOCIATESMATERIAL('m',$,$,$,(#27),#83);\n", "")
}

#[test]
fn issue_7955_open_boolean_tessellation_is_a_kernel_refusal_not_a_worker_fault() {
    let Some(path) = worker_path() else { return };
    let text = edge_touching_union();
    assert!(text.contains("IFCBOOLEANRESULT(.UNION.") && !text.contains("IFCRELASSOCIATESMATERIAL"));
    let mut results = Vec::new();
    let summary = run_model_native(
        SourceBundle::new(text.into_bytes()),
        path,
        &ModelOptions { ids: Some([27].into_iter().collect()), ..Default::default() },
        |outcome| results.push(outcome),
    )
    .unwrap();
    let [ProductOutcome::Refused { product_id: 27, refusal, message, .. }] = results.as_slice() else {
        panic!("expected one refusal for #27: {results:?}");
    };
    // Before the fix the adapter returned SM_SUCCESS with spine edges and the
    // reader retired the worker: WorkerFault, "partial tessellation returned
    // as success". The typed status takes the ordinary kernel-refusal path.
    assert_eq!(*refusal, RetainedProductRefusal::KernelFailure { status: 4 }, "{message}");
    assert!(message.contains("boundary or spine edges"), "{message}");
    assert_eq!((summary.published, summary.by_code.get("kernel_failure")), (0, Some(&1)));
    println!("sdk witness executed: open_tessellation_product_refusal");
}

#[test]
fn issue_7955_open_boolean_tessellation_keeps_the_worker_session_live() {
    let Some(path) = worker_path() else { return };
    let mut worker = SmlibWorker::spawn(path).unwrap();
    let incarnation = worker.incarnation();
    let a = worker.create_box([0.; 3], [1.; 3]).unwrap();
    let b = worker.create_box([1., 1., 0.], [1.; 3]).unwrap();
    let union = worker.boolean(a, b, BooleanOperation::Union).unwrap();
    // This is what SMLib's tessellation report calls inputManifold=false.
    assert!(!worker.is_manifold(union).unwrap());
    match worker.tessellate(union, 0.001, 5., MeshLimits::default()) {
        Err(WorkerError::Kernel { status: 4, message }) => {
            assert!(message.contains("boundary or spine edges"), "{message}");
        }
        other => panic!("open tessellation must be a typed kernel refusal: {other:?}"),
    }
    // The refusal left the session usable: the same process still tessellates
    // a closed operand, which a poisoned (terminated) worker cannot.
    let closed = worker.tessellate(a, 0.001, 5., MeshLimits::default()).unwrap();
    assert_eq!((closed.boundary_edges, closed.spine_edges), (0, 0));
    assert!(!closed.indices.is_empty());
    assert_eq!(worker.incarnation(), incarnation);
    println!("sdk witness executed: open_tessellation_worker_live");
}
