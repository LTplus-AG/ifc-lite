// SPDX-License-Identifier: MPL-2.0
#![cfg(feature = "retained-runtime")]
//! #7955: SMLib lists a tessellated solid's vertices and triangles in
//! heap-address order. The adapter must emit one canonical form instead:
//! vertices in (x, y, z) order, each triangle starting at its smallest vertex,
//! triangles sorted by (source face, v0, v1, v2), and a planar quad face split
//! through its lowest vertex. Observed on published parts that are the
//! adapter's mesh unchanged (no layers, clips or welds).
use ifc_lite_processing::element::retained_runtime::{ModelOptions, ProductOutcome, ShapePart};
use ifc_lite_retained_native::run_model_native;
use std::collections::BTreeMap;

const OPENINGS: &str = include_str!("../../processing/tests/fixtures/issue_2019_wall_two_overlapping_openings.ifc");
const BOX: &str = include_str!("../../../tests/fixtures/synthetic-retained/f-c-extrusion.ifc");

/// As open_tessellation_native.rs: with `IFCLITE_SMLIB_NATIVE_BUILD` (a CMake
/// build configured from THIS checkout, as the revert-oracle job provisions)
/// the worker is rebuilt first, so the adapter under test is this checkout's.
/// Otherwise `IFCLITE_SMLIB_WORKER`. With neither, or a failed rebuild, the
/// test returns early (not evidence) unless IFCLITE_REQUIRE_SMLIB is set.
fn worker_path() -> Option<std::ffi::OsString> {
    let required = std::env::var_os("IFCLITE_REQUIRE_SMLIB").is_some();
    if let Some(build) = std::env::var_os("IFCLITE_SMLIB_NATIVE_BUILD") {
        return match rebuild(std::path::Path::new(&build)) {
            Ok(path) => Some(path),
            Err(error) if required => panic!("native worker rebuild failed: {error}"),
            Err(error) => {
                eprintln!("SKIP canonical mesh: native rebuild failed ({error}); not evidence");
                None
            }
        };
    }
    let path = std::env::var_os("IFCLITE_SMLIB_WORKER");
    if path.is_none() {
        assert!(!required, "real SDK worker required");
        eprintln!("SKIP canonical mesh: set IFCLITE_SMLIB_WORKER; not acceptance evidence");
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

type Point = [f64; 3];
fn point(part: &ShapePart, index: u32) -> Point {
    let i = 3 * index as usize;
    [part.positions[i], part.positions[i + 1], part.positions[i + 2]]
}
/// The adapter's total order: coordinates lexicographically, -0 before +0.
fn key(p: Point) -> [(f64, bool); 3] { p.map(|v| (v, !v.is_sign_negative())) }
fn less(a: Point, b: Point) -> bool {
    key(a).partial_cmp(&key(b)) == Some(std::cmp::Ordering::Less)
}

fn check(model: &str, id: u32, part: &ShapePart) -> Result<(), String> {
    let vertices = (part.positions.len() / 3) as u32;
    for v in 1..vertices {
        if !less(point(part, v - 1), point(part, v)) {
            return Err(format!("{model}#{id}: vertex {v} is not after vertex {} in (x, y, z) order", v - 1));
        }
    }
    let triangles: Vec<_> = part.indices.chunks_exact(3).zip(&part.revision_local_faces)
        .map(|(t, &face)| (face, [t[0], t[1], t[2]])).collect();
    for (i, (face, t)) in triangles.iter().enumerate() {
        if !(t[0] < t[1] && t[0] < t[2]) {
            return Err(format!("{model}#{id}: triangle {i} {t:?} does not start at its smallest vertex"));
        }
        if i > 0 && triangles[i - 1] >= (*face, *t) {
            return Err(format!("{model}#{id}: triangle {i} is not sorted by (face, v0, v1, v2)"));
        }
    }
    // A quad face (exactly two triangles) is split through its lowest vertex.
    let mut faces: BTreeMap<u32, Vec<[u32; 3]>> = BTreeMap::new();
    for (face, t) in &triangles { faces.entry(*face).or_default().push(*t); }
    for (face, pair) in faces.iter().filter(|(_, t)| t.len() == 2) {
        let shared: Vec<_> = pair[0].iter().filter(|v| pair[1].contains(v)).collect();
        let lowest = pair.iter().flatten().min().unwrap();
        if shared.len() == 2 && !shared.contains(&lowest) {
            return Err(format!("{model}#{id}: quad face {face} is not split through its lowest vertex {lowest}"));
        }
    }
    Ok(())
}

#[test]
fn issue_7955_adapter_meshes_are_canonical() {
    let Some(worker) = worker_path() else { return; };
    let mut parts = 0;
    let mut errors = Vec::new();
    for (model, source) in [("issue_2019_wall_two_overlapping_openings.ifc", OPENINGS), ("f-c-extrusion.ifc", BOX)] {
        run_model_native(ifc_lite_core::SourceBundle::new(source.as_bytes().to_vec()), &worker, &ModelOptions::default(), |outcome| {
            if let ProductOutcome::Published(product) = outcome {
                for part in &product.parts {
                    parts += 1;
                    if let Err(error) = check(model, product.product_id, part) { errors.push(error); }
                }
            }
        }).unwrap();
    }
    assert!(parts >= 5, "both models must publish their Boolean and extrusion parts, got {parts}");
    assert!(errors.is_empty(), "adapter meshes are not canonical:\n{}", errors.join("\n"));
    println!("canonical adapter meshes: {parts} parts");
    println!("sdk witness executed: canonical_adapter_mesh");
}
