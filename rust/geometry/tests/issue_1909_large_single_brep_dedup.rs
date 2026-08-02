// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Regression for #1909: content-dedup's structural signature walk
//! (`item_dedup_key` -> `content_hash::item_signature` ->
//! `try_faceted_brep_signature`) mirrors the mesher's own face/bound/loop/point
//! traversal of an `IfcFacetedBrep`. On a model consisting of ONE large faceted
//! BREP (reported: ~2.5M triangles, no curved surfaces, no booleans) that hash
//! has no possible payback -- there is no sibling item to match -- so computing
//! it doubles the traversal cost of an already-expensive mesh. The reporter
//! measured `GeometryProcessor.processStreaming` at ~30s where web-ifc's
//! `StreamAllMeshes` (open + geometry) took ~2.85s on the same file.
//!
//! `EntityDecoder::point_cache_stats()` (hits, misses) is a pre-existing,
//! always-on counter fed by `get_polyloop_coords_cached` -- the SAME cache both
//! the signature walk and the faceted mesher read through. It gives a
//! deterministic, non-timing proxy for "how many times was every point of this
//! BREP visited": one full traversal (dedup off, or dedup on but skipped for
//! size) touches every point once (all misses); two traversals (the pre-fix
//! bug) touch every point twice -- once to build the signature (misses, since
//! nothing is cached yet) and once to mesh (hits, since the signature walk
//! already warmed the cache).
//!
//! Synthesizes a large single-instance faceted BREP procedurally (no fixture
//! file: a `nx` x `ny` grid of shared `IfcCartesianPoint`s triangulated into
//! `2*nx*ny` `IfcFace`s in one `IfcClosedShell`/`IfcFacetedBrep`, mirroring the
//! shared-point structure of `tests/fixtures/shared_point_faceted_brep.ifc`)
//! rather than requiring the reporter's un-shippable `BigModel.ifc`.

use ifc_lite_core::{build_entity_index, EntityDecoder};
use ifc_lite_geometry::GeometryRouter;
use std::fmt::Write as _;
use std::time::Instant;

/// Build a STEP `DATA` body containing a single `IfcFacetedBrep` shaped as an
/// `nx` x `ny` grid of unit quads, each split into 2 triangles (`IfcFace` with
/// one `IfcFaceOuterBound`/`IfcPolyLoop` of 3 points), all faces sharing the
/// `(nx+1)*(ny+1)` `IfcCartesianPoint` grid (so point re-visits inside ONE
/// traversal are real, matching a real mesh, not an artifact of the test).
/// Returns `(entities_text, brep_entity_id, face_count)`.
fn build_grid_faceted_brep(nx: usize, ny: usize) -> (String, u32, usize) {
    let mut out = String::with_capacity((nx + 1) * (ny + 1) * 40 + nx * ny * 200);
    let mut next_id: u32 = 1;

    // Point grid: point_id(i, j) = base + j * (nx + 1) + i.
    let point_base = next_id;
    for j in 0..=ny {
        for i in 0..=nx {
            let x = i as f64;
            let y = j as f64;
            // A little vertical relief so this isn't a degenerate flat plane.
            let z = ((i + j) % 5) as f64 * 0.1;
            let _ = writeln!(out, "#{next_id}=IFCCARTESIANPOINT(({x:.4},{y:.4},{z:.4}));");
            next_id += 1;
        }
    }
    let point_id = |i: usize, j: usize| -> u32 { point_base + (j * (nx + 1) + i) as u32 };

    let mut face_ids: Vec<u32> = Vec::with_capacity(2 * nx * ny);
    for j in 0..ny {
        for i in 0..nx {
            let p00 = point_id(i, j);
            let p10 = point_id(i + 1, j);
            let p11 = point_id(i + 1, j + 1);
            let p01 = point_id(i, j + 1);
            for tri in [[p00, p10, p11], [p00, p11, p01]] {
                let loop_id = next_id;
                let _ = writeln!(
                    out,
                    "#{loop_id}=IFCPOLYLOOP((#{},#{},#{}));",
                    tri[0], tri[1], tri[2]
                );
                next_id += 1;
                let bound_id = next_id;
                let _ = writeln!(out, "#{bound_id}=IFCFACEOUTERBOUND(#{loop_id},.T.);");
                next_id += 1;
                let face_id = next_id;
                let _ = writeln!(out, "#{face_id}=IFCFACE((#{bound_id}));");
                next_id += 1;
                face_ids.push(face_id);
            }
        }
    }

    let shell_id = next_id;
    next_id += 1;
    let refs: Vec<String> = face_ids.iter().map(|id| format!("#{id}")).collect();
    let _ = writeln!(out, "#{shell_id}=IFCCLOSEDSHELL(({}));", refs.join(","));

    let brep_id = next_id;
    let _ = writeln!(out, "#{brep_id}=IFCFACETEDBREP(#{shell_id});");

    (out, brep_id, face_ids.len())
}

/// Wrap a `DATA` body in the minimal ISO-10303-21 envelope the scanner/decoder
/// need. No `IfcProject`/units on purpose (`GeometryRouter::with_units` falls
/// back to scale 1.0 when none is found) -- this test is about the item-level
/// dedup hash, not unit handling.
fn wrap_step(body: &str) -> String {
    format!(
        "ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION((''),'2;1');\nFILE_NAME('','',(''),(''),'','','' );\nFILE_SCHEMA(('IFC4'));\nENDSEC;\nDATA;\n{body}ENDSEC;\nEND-ISO-10303-21;\n"
    )
}

/// Total point-cache traffic (hits + misses) `process_representation_item`
/// generates for one `IfcFacetedBrep`, plus wall time, plus the resulting mesh
/// (for byte-identical comparison) and rep_identity (for instancing).
struct RunResult {
    accesses: u64,
    elapsed: std::time::Duration,
    positions: Vec<f32>,
    indices: Vec<u32>,
}

fn run_once(content: &str, brep_id: u32, dedup_on: bool) -> RunResult {
    let mut decoder = EntityDecoder::with_index(content, build_entity_index(content));
    let mut router = GeometryRouter::with_units(content, &mut decoder);
    if !dedup_on {
        router.disable_content_dedup();
    }
    let item = decoder.decode_by_id(brep_id).expect("decode brep item");

    let t0 = Instant::now();
    let mesh = router
        .process_representation_item(&item, &mut decoder)
        .expect("mesh the synthetic brep");
    let elapsed = t0.elapsed();

    let (hits, misses) = decoder.point_cache_stats();
    RunResult {
        accesses: hits + misses,
        elapsed,
        positions: mesh.positions.clone(),
        indices: mesh.indices.clone(),
    }
}

/// Baseline + regression guard: a single large (above the #1909 face-count
/// threshold) `IfcFacetedBrep` with content-dedup ON must NOT touch the point
/// cache measurably more than the same item with dedup OFF. Pre-fix, dedup ON
/// did a full extra pass (the signature walk) BEFORE meshing, roughly
/// doubling point-cache traffic; this is the deterministic (non-timing) proof
/// that the duplicate traversal is gone.
///
/// Also asserts byte-identical mesh output between dedup on/off (hard
/// constraint: skipping the hash must never change vertices/indices) and
/// prints wall-clock timing for both as a secondary, illustrative signal.
#[test]
#[ignore = "manual perf check: cargo test -p ifc-lite-geometry --release --test issue_1909_large_single_brep_dedup -- --ignored --nocapture large_scale"]
fn large_scale_wall_clock() {
    // ~700x700 grid -> 980,000 faces / 490,000 quads worth of triangles,
    // approaching the reported model's order of magnitude (~2.5M triangles),
    // while still fitting in a few seconds of test time.
    let (body, brep_id, face_count) = build_grid_faceted_brep(700, 700);
    let content = wrap_step(&body);
    println!("issue_1909 large_scale: faces={face_count}");

    let off = run_once(&content, brep_id, false);
    let on = run_once(&content, brep_id, true);
    println!(
        "dedup_off: {} point-cache accesses, {:?} wall",
        off.accesses, off.elapsed
    );
    println!(
        "dedup_on:  {} point-cache accesses, {:?} wall",
        on.accesses, on.elapsed
    );
    assert_eq!(off.positions, on.positions);
    assert_eq!(off.indices, on.indices);
}

#[test]
fn large_single_instance_brep_skips_duplicate_traversal() {
    // 120 x 120 grid -> 28,800 faces, well above FACETED_BREP_DEDUP_FACE_LIMIT
    // (20,000) so this item is squarely in the "cannot benefit from dedup"
    // regime the fix targets, while still finishing in well under a second per
    // run for a default (non-ignored, non-release) `cargo test`.
    let (body, brep_id, face_count) = build_grid_faceted_brep(120, 120);
    assert!(face_count > 20_000, "fixture must exceed the dedup threshold");
    let content = wrap_step(&body);

    let off = run_once(&content, brep_id, false);
    let on = run_once(&content, brep_id, true);

    println!(
        "issue_1909: faces={face_count} dedup_off: {} point-cache accesses in {:?} | dedup_on: {} point-cache accesses in {:?}",
        off.accesses, off.elapsed, on.accesses, on.elapsed
    );

    assert_eq!(
        off.positions, on.positions,
        "content-dedup must not change mesh positions (hard constraint)"
    );
    assert_eq!(
        off.indices, on.indices,
        "content-dedup must not change mesh indices (hard constraint)"
    );

    // Pre-fix this ratio was ~2.0 (signature walk = all misses, then the mesh
    // pass on the same item = all hits, so total accesses roughly doubled).
    // Post-fix both runs do exactly one traversal, so the ratio should be ~1.0;
    // allow slack for the shell/face list reads that aren't point-cache
    // traffic and aren't identical in count between the two code paths.
    let ratio = on.accesses as f64 / off.accesses as f64;
    assert!(
        ratio < 1.2,
        "content-dedup ON did {} point-cache accesses vs {} with dedup OFF (ratio {:.2}) -- \
         the structural signature walk is re-traversing a large single-instance BREP \
         that can never benefit from dedup (#1909)",
        on.accesses,
        off.accesses,
        ratio
    );
}

/// Genuinely repeated large geometry must still collapse to one instanced
/// template even though the item-level pre-mesh cache is skipped above the
/// face-count threshold: two textually distinct `IfcFacetedBrep` entities with
/// IDENTICAL structure (same grid, different entity ids) must mesh to
/// byte-identical geometry AND get the SAME `rep_identity`, because
/// `direct_rep_identity` (fed by the post-mesh, sampled `compute_mesh_hash_full`)
/// runs unconditionally after meshing regardless of whether the pre-mesh
/// structural-hash cache fired.
#[test]
fn repeated_large_brep_still_shares_rep_identity() {
    let (body_a, brep_a, face_count) = build_grid_faceted_brep(120, 120);
    assert!(face_count > 20_000, "fixture must exceed the dedup threshold");
    // Second, textually independent copy of the SAME shape at different entity
    // ids (simulating an exporter that duplicated a representation item
    // instead of sharing it via IfcMappedItem).
    let (body_b, brep_b_local, _) = build_grid_faceted_brep(120, 120);
    // Renumber body_b's ids to start after body_a's so both coexist in one file.
    let offset: u32 = 10_000_000;
    let body_b_shifted = renumber_step_ids(&body_b, offset);
    let brep_b = brep_b_local + offset;

    let content = wrap_step(&format!("{body_a}{body_b_shifted}"));

    let mut decoder = EntityDecoder::with_index(&content, build_entity_index(&content));
    let router = GeometryRouter::with_units(&content, &mut decoder);

    let item_a = decoder.decode_by_id(brep_a).expect("decode brep A");
    let mesh_a = router
        .process_representation_item(&item_a, &mut decoder)
        .expect("mesh brep A");
    let item_b = decoder.decode_by_id(brep_b).expect("decode brep B");
    let mesh_b = router
        .process_representation_item(&item_b, &mut decoder)
        .expect("mesh brep B");

    assert_eq!(
        mesh_a.positions, mesh_b.positions,
        "two structurally identical large BREPs must mesh to identical positions"
    );
    assert_eq!(
        mesh_a.indices, mesh_b.indices,
        "two structurally identical large BREPs must mesh to identical indices"
    );

    let rep_a = mesh_a
        .instance_meta
        .as_ref()
        .map(|m| m.rep_identity)
        .expect("mesh A should be instance-tagged (instancing default on)");
    let rep_b = mesh_b
        .instance_meta
        .as_ref()
        .map(|m| m.rep_identity)
        .expect("mesh B should be instance-tagged (instancing default on)");
    assert_eq!(
        rep_a, rep_b,
        "repeated large geometry must still share one rep_identity for GPU instancing \
         even though the item-level content-dedup cache is skipped above the size threshold"
    );
}

/// Shift every `#<id>` reference and every `#<id>=` definition in a STEP body
/// by `offset`, so two independently generated bodies can be concatenated into
/// one file without id collisions.
fn renumber_step_ids(body: &str, offset: u32) -> String {
    let bytes = body.as_bytes();
    let mut out = String::with_capacity(body.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'#' && i + 1 < bytes.len() && bytes[i + 1].is_ascii_digit() {
            out.push('#');
            let mut j = i + 1;
            let mut id: u32 = 0;
            while j < bytes.len() && bytes[j].is_ascii_digit() {
                id = id * 10 + (bytes[j] - b'0') as u32;
                j += 1;
            }
            let _ = write!(out, "{}", id + offset);
            i = j;
        } else {
            out.push(bytes[i] as char);
            i += 1;
        }
    }
    out
}
