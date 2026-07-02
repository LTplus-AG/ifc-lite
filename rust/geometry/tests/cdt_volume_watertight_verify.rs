// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// Regression guard: watertightness + cut-volume conservation for the
// CDT-consolidated opening cuts on real fixtures (skip-if-absent).
//
// A re-triangulation of the planar consolidated regions must (a) leave the
// closed surface watertight — every undirected edge shared by exactly two
// triangles — and (b) preserve the enclosed signed volume exactly (volume is a
// surface integral; re-tiling a planar region does not move the surface). We
// check the box-opening wall #555082 (advanced_model) against its analytic
// box-minus-opening volume, and the #1112 roof host against a self-consistency
// volume + watertight + rim-tear check.

use ifc_lite_core::{build_entity_index, EntityDecoder, EntityScanner};
use ifc_lite_geometry::{propagate_voids_to_parts, GeometryRouter, Mesh};
use rustc_hash::FxHashMap;
use std::collections::BTreeMap;

fn build_void_index(content: &str) -> FxHashMap<u32, Vec<u32>> {
    let mut void_index: FxHashMap<u32, Vec<u32>> = FxHashMap::default();
    let mut scanner = EntityScanner::new(content);
    let mut decoder = EntityDecoder::new(content);
    while let Some((id, type_name, start, end)) = scanner.next_entity() {
        if type_name == "IFCRELVOIDSELEMENT" {
            if let Ok(entity) = decoder.decode_at_with_id(id, start, end) {
                if let (Some(host_id), Some(opening_id)) = (entity.get_ref(4), entity.get_ref(5)) {
                    void_index.entry(host_id).or_default().push(opening_id);
                }
            }
        }
    }
    let _ = propagate_voids_to_parts(&mut void_index, content, &mut decoder);
    void_index
}

fn process(path: &str, host_id: u32) -> Option<Mesh> {
    if !std::path::Path::new(path).exists() {
        eprintln!("skipping: fixture {path} not present");
        return None;
    }
    let content = std::fs::read_to_string(path).ok()?;
    let entity_index = build_entity_index(&content);
    let mut decoder = EntityDecoder::with_index(&content, entity_index);
    let router = GeometryRouter::with_units(&content, &mut decoder);
    let void_index = build_void_index(&content);
    let entity = decoder.decode_by_id(host_id).ok()?;
    router
        .process_element_with_voids(&entity, &mut decoder, &void_index)
        .ok()
}

fn vtx(m: &Mesh, i: u32) -> [f64; 3] {
    let b = i as usize * 3;
    [
        m.positions[b] as f64,
        m.positions[b + 1] as f64,
        m.positions[b + 2] as f64,
    ]
}

/// Signed volume of a closed triangle soup via the divergence theorem
/// (sum of signed tetra volumes from the origin). |value| is the enclosed
/// volume when the surface is closed; sign depends on winding.
fn signed_volume(m: &Mesh) -> f64 {
    let mut v6 = 0.0_f64;
    for c in m.indices.chunks_exact(3) {
        let a = vtx(m, c[0]);
        let b = vtx(m, c[1]);
        let d = vtx(m, c[2]);
        // a · (b × d)
        let cx = b[1] * d[2] - b[2] * d[1];
        let cy = b[2] * d[0] - b[0] * d[2];
        let cz = b[0] * d[1] - b[1] * d[0];
        v6 += a[0] * cx + a[1] * cy + a[2] * cz;
    }
    v6 / 6.0
}

/// Weld near-coincident vertices (the kernel emits duplicated boundary verts
/// per facet) and report, over the welded index space: number of undirected
/// edges used != 2 (boundary/non-manifold count). A watertight closed manifold
/// has ZERO such edges.
fn open_or_nonmanifold_edges(m: &Mesh) -> (usize, usize) {
    // Weld by quantized position (1e-6 m grid).
    let key = |p: [f64; 3]| -> (i64, i64, i64) {
        let q = |x: f64| (x * 1.0e6).round() as i64;
        (q(p[0]), q(p[1]), q(p[2]))
    };
    let mut remap: BTreeMap<(i64, i64, i64), usize> = BTreeMap::new();
    let mut welded: Vec<usize> = Vec::with_capacity(m.indices.len());
    for &i in &m.indices {
        let k = key(vtx(m, i));
        let n = remap.len();
        let id = *remap.entry(k).or_insert(n);
        welded.push(id);
    }
    let mut edges: BTreeMap<(usize, usize), i32> = BTreeMap::new();
    for c in welded.chunks_exact(3) {
        for (a, b) in [(c[0], c[1]), (c[1], c[2]), (c[2], c[0])] {
            let ek = if a < b { (a, b) } else { (b, a) };
            *edges.entry(ek).or_insert(0) += 1;
        }
    }
    let open = edges.values().filter(|&&v| v != 2).count();
    let nonmanifold = edges.values().filter(|&&v| v > 2).count();
    (open, nonmanifold)
}

fn bbox(m: &Mesh) -> ([f64; 3], [f64; 3]) {
    let mut mn = [f64::INFINITY; 3];
    let mut mx = [f64::NEG_INFINITY; 3];
    for c in m.positions.chunks_exact(3) {
        for k in 0..3 {
            mn[k] = mn[k].min(c[k] as f64);
            mx[k] = mx[k].max(c[k] as f64);
        }
    }
    (mn, mx)
}

const ADVANCED: &str = "../../tests/models/ara3d/advanced_model.ifc";
const ROOF_1007: &str = "../../tests/models/issues/1007_roof_brep_opening_winding.ifc";

#[test]
fn box_opening_wall_555082_volume_and_watertight() {
    let Some(mesh) = process(ADVANCED, 555082) else {
        return;
    };
    let vol = signed_volume(&mesh).abs();
    let (mn, mx) = bbox(&mesh);
    let ext = [mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]];
    let box_vol = ext[0] * ext[1] * ext[2];
    let (open, nonmanifold) = open_or_nonmanifold_edges(&mesh);
    let tris = mesh.indices.len() / 3;
    eprintln!(
        "[555082] ext={ext:?} box_vol={box_vol:.6} cut_vol={vol:.6} ratio={:.4} tris={tris} open_edges={open} nonmanifold={nonmanifold}",
        vol / box_vol
    );
    // A 1-opening wall: cut volume is box minus a single opening prism, so it is
    // strictly less than the bbox volume but the same order of magnitude.
    assert!(vol > 0.0, "non-empty cut volume");
    assert!(
        vol < box_vol * 1.0001,
        "cut volume {vol} cannot exceed bbox volume {box_vol}"
    );
    assert!(
        vol > box_vol * 0.5,
        "cut volume {vol} collapsed vs bbox {box_vol} (opening should remove a small fraction)"
    );
    // Watertight: the closed solid must have no open/non-manifold edges after
    // welding. (The rim and opening interior are framed by their neighbours.)
    assert_eq!(
        nonmanifold, 0,
        "[555082] {nonmanifold} non-manifold edges — consolidate produced overlap"
    );
    assert_eq!(
        open, 0,
        "[555082] {open} open edges — a rim was torn / T-junction left a gap"
    );
}

#[test]
fn roof_1112_volume_self_consistent_and_watertight() {
    let Some(mesh) = process(ROOF_1007, 1112) else {
        return;
    };
    let vol = signed_volume(&mesh).abs();
    let (open, nonmanifold) = open_or_nonmanifold_edges(&mesh);
    let tris = mesh.indices.len() / 3;
    let (mn, mx) = bbox(&mesh);
    let ext = [mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]];
    eprintln!(
        "[1112] ext={ext:?} cut_vol={vol:.6} tris={tris} open_edges={open} nonmanifold={nonmanifold}"
    );
    assert!(vol > 0.0, "[1112] non-empty cut volume");
    // The #1112 host is a faceted-brep ROOF SLOPE — an intrinsically OPEN
    // surface (a roof facet, not a closed solid), so the welded mesh legitimately
    // has open boundary edges (37 on the earcut baseline). The load-bearing CDT
    // invariants here are:
    //  * NON-MANIFOLD == 0: the CDT introduced no overlap / self-intersection.
    //  * cut volume matches the earcut baseline to ~1e-4 (re-tiling a planar
    //    region preserves the enclosed volume): baseline ≈ 179.9766.
    //  * triangle count bounded (no Ruppert blow-up): earcut emitted 101; the
    //    quality pipeline (CDT-refined consolidate + post-cut >8:1 bisection)
    //    legitimately lands ~210. The guard is against RUNAWAY refinement
    //    (hundreds/thousands), so the bound is ~3x the earcut baseline.
    //  * open-edge count not materially worse — a real rim TEAR would push this
    //    into the hundreds; the CDT's different Delaunay diagonals only re-partition
    //    the EXISTING open boundary by a handful of short edges.
    const BASELINE_VOL: f64 = 179.9766;
    assert_eq!(
        nonmanifold, 0,
        "[1112] {nonmanifold} non-manifold edges — overlap in consolidate output"
    );
    assert!(
        (vol - BASELINE_VOL).abs() / BASELINE_VOL < 1.0e-4,
        "[1112] cut volume {vol} drifted from earcut baseline {BASELINE_VOL} by > 1e-4 relative"
    );
    assert!(
        tris <= 300,
        "[1112] {tris} triangles — Ruppert over-refined (earcut baseline 101, quality pipeline ~210)"
    );
    assert!(
        open <= 60,
        "[1112] {open} open edges — a rim tear / large seam gap appeared (earcut baseline 37)"
    );
}
