// SPDX-License-Identifier: MPL-2.0
#![cfg(feature = "retained-runtime")]
//! #7955: SMLib lists a tessellated solid's vertices and triangles in
//! heap-address order. The adapter must emit one canonical form instead:
//! vertices in (x, y, z) order, each triangle starting at its smallest vertex,
//! triangles sorted by (source face, v0, v1, v2), coincident vertices in
//! incident-corner order, and a planar, strictly convex two-triangle face split
//! along its canonical diagonal (canonical_planar_faces: the shorter one, on a
//! tie the lexicographically lower vertex pair, unless that is already an edge
//! of another face).
//!
//! Observed on published parts that are the adapter's mesh unchanged. Positions,
//! indices and source-face IDs are copied verbatim from the worker reply
//! (geometry-runtime worker_mesh.rs read_u32(SourceFaces) -> worker_sweep.rs
//! revision_local_faces -> processing publication_mesh.rs copy_part); only the
//! material-layer steps (layer_caps.rs, layer_rims.rs) rewrite them, so the
//! test requires parts without a layer or halfspace clip.
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
/// mesh_canonical.cpp canonical_grid: a power of two, at least 2^16 ULP of
/// the largest |coordinate|, otherwise 2^-30 of the bounding-box extent.
fn grid(part: &ShapePart) -> f64 {
    let (mut low, mut high, mut largest) = ([0f64; 3], [0f64; 3], 0f64);
    for (i, v) in part.positions.chunks_exact(3).enumerate() {
        for axis in 0..3 {
            if i == 0 || v[axis] < low[axis] { low[axis] = v[axis]; }
            if i == 0 || v[axis] > high[axis] { high[axis] = v[axis]; }
            largest = largest.max(v[axis].abs());
        }
    }
    let extent = (0..3).map(|a| high[a] - low[a]).fold(0f64, f64::max);
    let base = (extent * 2f64.powi(-30)).max(largest * 2f64.powi(-36));
    if !(base > 0. && base.is_finite()) { return 1.; }
    // ilogb for a normal f64: its unbiased binary exponent.
    let exponent = ((base.to_bits() >> 52) & 0x7ff) as i32 - 1023;
    2f64.powi(exponent + 1)
}
/// The adapter's sort key: nearest grid point (llround) per coordinate.
fn key(p: Point, h: f64) -> [i64; 3] { p.map(|v| (v / h).round() as i64) }
/// Exact order, the last tie-break: coordinates, -0 before +0.
fn exact(p: Point) -> [(f64, bool); 3] { p.map(|v| (v, !v.is_sign_negative())) }

type Corner = (u32, [i64; 3], [i64; 3]);
/// A vertex's incident corners as order_mesh compares them: (source face, next
/// corner key, previous corner key), sorted.
fn corners(part: &ShapePart, h: f64) -> Vec<Vec<Corner>> {
    let mut result = vec![Vec::new(); part.positions.len() / 3];
    for (t, &face) in part.indices.chunks_exact(3).zip(&part.revision_local_faces) {
        for k in 0..3 {
            result[t[k] as usize].push((face, key(point(part, t[(k + 1) % 3]), h), key(point(part, t[(k + 2) % 3]), h)));
        }
    }
    for c in &mut result { c.sort(); }
    result
}

fn check(model: &str, id: u32, part: &ShapePart) -> Result<(), String> {
    let vertices = (part.positions.len() / 3) as u32;
    // Grid keys non-decreasing; equal keys (coincident vertices) ordered by
    // their incident corners, then exactly (mesh_canonical.cpp order_mesh).
    let h = grid(part);
    let incident = corners(part, h);
    for v in 1..vertices {
        let (a, b) = (point(part, v - 1), point(part, v));
        let (ka, kb) = (key(a, h), key(b, h));
        if kb < ka {
            return Err(format!("{model}#{id}: vertex {v} is before vertex {} in grid (x, y, z) order", v - 1));
        }
        if ka == kb {
            let (ca, cb) = (&incident[v as usize - 1], &incident[v as usize]);
            if cb < ca || (cb == ca && exact(b).partial_cmp(&exact(a)) == Some(std::cmp::Ordering::Less)) {
                return Err(format!("{model}#{id}: coincident vertices {} and {v} are not in incident-corner order", v - 1));
            }
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
    // A planar, strictly convex two-triangle face takes the diagonal first in
    // (grid length, lower vertex, upper vertex) order, unless another face
    // already has that edge (canonical_planar_faces' existing-edge exception).
    let mut faces: BTreeMap<u32, Vec<[u32; 3]>> = BTreeMap::new();
    for (face, t) in &triangles { faces.entry(*face).or_default().push(*t); }
    let edges_of = |face: u32| -> std::collections::BTreeSet<(u32, u32)> {
        triangles.iter().filter(|(f, _)| *f != face)
            .flat_map(|(_, t)| (0..3).map(move |k| (t[k].min(t[(k + 1) % 3]), t[k].max(t[(k + 1) % 3])))).collect()
    };
    for (face, pair) in faces.iter().filter(|(_, t)| t.len() == 2) {
        let Some([u, q, v, p]) = quad_loop(pair) else { continue; };
        if !planar_strictly_convex(part, [u, q, v, p]) { continue; }
        let rank = |a: u32, b: u32| {
            let d = sub(point(part, a), point(part, b));
            ((dot(d, d).sqrt() / h).round() as i64, a.min(b), a.max(b))
        };
        let (current, other) = (rank(u, v), rank(p, q));
        let (first, second) = if current < other { (current, other) } else { (other, current) };
        let expected = if edges_of(*face).contains(&(first.1, first.2)) { second } else { first };
        if current != expected {
            return Err(format!("{model}#{id}: quad face {face} uses diagonal {:?}, canonical is {:?}", (current.1, current.2), (expected.1, expected.2)));
        }
    }
    Ok(())
}

/// The boundary loop (u, q, v, p) of a = (u, v, p) and b = (v, u, q), which
/// share the directed edge u->v / v->u.
fn quad_loop(pair: &[[u32; 3]]) -> Option<[u32; 4]> {
    let (a, b) = (pair[0], pair[1]);
    for i in 0..3 {
        let (u, v, p) = (a[i], a[(i + 1) % 3], a[(i + 2) % 3]);
        for j in 0..3 {
            if b[j] == v && b[(j + 1) % 3] == u && b[(j + 2) % 3] != p {
                return Some([u, b[(j + 2) % 3], v, p]);
            }
        }
    }
    None
}
fn sub(a: Point, b: Point) -> Point { [a[0] - b[0], a[1] - b[1], a[2] - b[2]] }
fn cross(a: Point, b: Point) -> Point { [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]] }
fn dot(a: Point, b: Point) -> f64 { a[0] * b[0] + a[1] * b[1] + a[2] * b[2] }
/// Exactly coplanar (zero triple product) with every boundary turn along the
/// area normal. These fixtures' quads are axis-aligned, so exact is exact.
fn planar_strictly_convex(part: &ShapePart, quad: [u32; 4]) -> bool {
    let p = quad.map(|v| point(part, v));
    if dot(sub(p[1], p[0]), cross(sub(p[2], p[0]), sub(p[3], p[0]))) != 0. { return false; }
    let mut n = [0.; 3];
    for k in 0..4 { let c = cross(p[k], p[(k + 1) % 4]); for i in 0..3 { n[i] += c[i]; } }
    (0..4).all(|k| dot(cross(sub(p[(k + 1) % 4], p[k]), sub(p[(k + 2) % 4], p[(k + 1) % 4])), n) > 0.)
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
                    assert!(part.layer.is_none() && !part.halfspace_clipped,
                        "{model}#{}: witness parts must be the adapter mesh unchanged", product.product_id);
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
