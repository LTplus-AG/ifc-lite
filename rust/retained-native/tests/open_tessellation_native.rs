// SPDX-License-Identifier: MPL-2.0
#![cfg(feature = "retained-runtime")]
//! #7955: a Boolean result whose BRep is non-manifold (SMLib reports
//! `inputManifold=false`) must come back from the adapter as a typed kernel
//! refusal, never as a tessellation "success" carrying spine/lamina edges that
//! the Rust and browser readers then retire as a malformed reply.
use ifc_lite_core::SourceBundle;
use ifc_lite_geometry_runtime::{protocol::BooleanOperation, MeshLimits, SmlibWorker, WorkerError};
use ifc_lite_processing::element::retained_runtime::{
    ModelOptions, ProductOutcome, RetainedProductRefusal, ShapeOnlyProduct,
};
use ifc_lite_retained_native::run_model_native;

const STRAIGHT: &str = include_str!("../../../tests/fixtures/cli-retained/layered-wall.ifc");

/// The worker under test. With `IFCLITE_SMLIB_NATIVE_BUILD` (a CMake build
/// configured from THIS checkout, as the revert-oracle job provisions), the
/// worker is first rebuilt so a reverted `mesh.cpp` is what runs. Otherwise
/// `IFCLITE_SMLIB_WORKER` (geometry-platform's prebuilt worker, where the
/// witnesses are enforced). With neither, every test here returns early and
/// cargo counts it as passed: that is NOT real-kernel evidence. A failed
/// rebuild also returns early (never a red assertion the revert oracle could
/// score as observed) unless IFCLITE_REQUIRE_SMLIB demands the kernel.
fn worker_path() -> Option<std::ffi::OsString> {
    static REBUILT: std::sync::OnceLock<Result<std::ffi::OsString, String>> = std::sync::OnceLock::new();
    let required = std::env::var_os("IFCLITE_REQUIRE_SMLIB").is_some();
    if let Some(build) = std::env::var_os("IFCLITE_SMLIB_NATIVE_BUILD") {
        return match REBUILT.get_or_init(|| rebuild(std::path::Path::new(&build))) {
            Ok(path) => Some(path.clone()),
            Err(error) if required => panic!("native worker rebuild failed: {error}"),
            Err(error) => {
                eprintln!("SKIP open tessellation: native rebuild failed ({error}); not evidence");
                None
            }
        };
    }
    let path = std::env::var_os("IFCLITE_SMLIB_WORKER");
    if path.is_none() {
        assert!(!required, "real SDK worker required");
        eprintln!("SKIP open tessellation: set IFCLITE_SMLIB_WORKER; not acceptance evidence");
    }
    path
}

fn rebuild(build: &std::path::Path) -> Result<std::ffi::OsString, String> {
    let cache = std::fs::read_to_string(build.join("CMakeCache.txt")).map_err(|e| e.to_string())?;
    let home = cache.lines().find_map(|l| l.strip_prefix("CMAKE_HOME_DIRECTORY:INTERNAL=")).ok_or("no CMake home")?;
    let adapter = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../native/smlib-adapter");
    let canonical = |p: &std::path::Path| std::fs::canonicalize(p).map_err(|e| e.to_string());
    if canonical(home.as_ref())? != canonical(&adapter)? {
        return Err(format!("native build is configured from {home}, not this checkout"));
    }
    let cmake = std::env::var_os("CMAKE").unwrap_or_else(|| "cmake".into());
    let status = std::process::Command::new(cmake)
        .args(["--build".as_ref(), build.as_os_str(), "--target".as_ref(), "ifclite_smlib_worker".as_ref()])
        .status().map_err(|e| e.to_string())?;
    if !status.success() {
        return Err(format!("cmake --build exited {status}"));
    }
    Ok(build.join("ifclite_smlib_worker").into_os_string())
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

/// `count` copies of the layered wall whose profile has a bottom V-notch with
/// its apex exactly on the first band boundary (y = 0.1), then the original
/// healthy wall. The notched host is a manifold prism, but its 0..0.1 band is
/// two pieces meeting along the vertical edge x=1, y=0.1: a band-phase
/// Intersection whose result is non-manifold. Returns (text, notched ids, healthy id).
fn notched_walls_then_healthy(count: u32) -> (String, Vec<u32>, u32) {
    let (head, rest) = STRAIGHT.split_once("#16=").unwrap();
    let (walls, tail) = rest.split_once("ENDSEC;").unwrap();
    let walls = format!("#16={walls}");
    let notch = "#18=IFCARBITRARYCLOSEDPROFILEDEF(.AREA.,$,#90);\
        #90=IFCPOLYLINE((#91,#92,#93,#94,#95,#96,#97,#91));\
        #91=IFCCARTESIANPOINT((0.,0.));#92=IFCCARTESIANPOINT((0.5,0.));#93=IFCCARTESIANPOINT((1.,0.1));\
        #94=IFCCARTESIANPOINT((1.5,0.));#95=IFCCARTESIANPOINT((2.,0.));#96=IFCCARTESIANPOINT((2.,1.));\
        #97=IFCCARTESIANPOINT((0.,1.));";
    let mut text = head.to_owned();
    for k in 0..=count {
        let offset = 1000 * (k + 1);
        let mut copy = walls.replace("3RB3De501V1R1AmlBDyHxh", &format!("3RB3De501V1R1AmlBDy{k:03}"))
            .replace("02bmVNXt5MJ9KbV_gDWZoh", &format!("02bmVNXt5MJ9KbV_gDW{k:03}"));
        if k < count {
            copy = copy.replace("#18=IFCRECTANGLEPROFILEDEF(.AREA.,$,#17,2.,1.);", notch);
        }
        // Shared header entities #1..#15 keep their ids; every wall entity moves.
        let mut moved = String::new();
        let mut rest = copy.as_str();
        while let Some(at) = rest.find('#') {
            moved.push_str(&rest[..=at]);
            rest = &rest[at + 1..];
            let digits = rest.bytes().take_while(u8::is_ascii_digit).count();
            let id: u32 = rest[..digits].parse().unwrap();
            moved.push_str(&(if id >= 16 { id + offset } else { id }).to_string());
            rest = &rest[digits..];
        }
        moved.push_str(rest);
        text.push_str(&moved);
    }
    text.push_str("ENDSEC;");
    text.push_str(tail);
    let ids = (0..count).map(|k| 27 + 1000 * (k + 1)).collect();
    (text, ids, 27 + 1000 * (count + 1))
}

fn shape(outcomes: &[ProductOutcome], id: u32) -> &ShapeOnlyProduct {
    outcomes.iter().find_map(|o| match o {
        ProductOutcome::Published(p) if p.product_id == id => Some(p),
        _ => None,
    }).unwrap_or_else(|| panic!("#{id} not published: {outcomes:?}"))
}

#[test]
fn issue_7955_band_phase_open_tessellations_do_not_spend_the_layer_allowance() {
    let Some(path) = worker_path() else { return };
    // One more than LAYER_RETIREMENTS (4): before the fix every notched wall
    // poisoned the worker and spent one band-phase allowance, so the fifth
    // notched wall and the healthy wall were refused LayerRetirementsExhausted.
    let (text, notched, healthy) = notched_walls_then_healthy(5);
    let ids: std::collections::BTreeSet<u32> = notched.iter().copied().chain([healthy]).collect();
    let mut results = Vec::new();
    let summary = run_model_native(SourceBundle::new(text.into_bytes()), &path,
        &ModelOptions { ids: Some(ids.clone()), ..Default::default() }, |o| results.push(o)).unwrap();
    assert_eq!(results.len(), ids.len(), "{results:?}");
    for id in &notched {
        let refused = results.iter().find_map(|o| match o {
            ProductOutcome::Refused { product_id, refusal, message, .. } if product_id == id => Some((*refusal, message)),
            _ => None,
        });
        let Some((refusal, message)) = refused else { panic!("#{id} must be refused: {results:?}") };
        assert_eq!(refusal, RetainedProductRefusal::KernelFailure { status: 4 }, "#{id}: {message}");
        assert!(message.contains("boundary or spine edges"), "#{id}: {message}");
    }
    // The healthy layered wall is attempted on the kept worker and publishes
    // exactly what it publishes alone: same bands, same buffers.
    let mut control = Vec::new();
    run_model_native(SourceBundle::new(STRAIGHT.as_bytes().to_vec()), &path,
        &ModelOptions { ids: Some([27].into_iter().collect()), ..Default::default() }, |o| control.push(o)).unwrap();
    let (product, alone) = (shape(&results, healthy), shape(&control, 27));
    assert_eq!(product.parts.iter().filter(|p| p.layer.is_some()).count(), 2);
    assert_eq!(product.parts.len(), alone.parts.len());
    for (a, b) in product.parts.iter().zip(&alone.parts) {
        assert_eq!((&a.positions, &a.indices, &a.layer, &a.capped_volume_m3),
            (&b.positions, &b.indices, &b.layer, &b.capped_volume_m3));
    }
    assert_eq!((summary.restarts, summary.published, summary.by_code.get("kernel_failure")), (0, 1, Some(&5)));
    println!("sdk witness executed: open_tessellation_layer_allowance");
}
