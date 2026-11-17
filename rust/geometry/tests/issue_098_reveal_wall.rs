// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Issue #098: a plan-rotated Poroton wall (`IfcWallStandardCase` #928204,
//! `2A8m$1B8T2VuclBPhPDl_W`) whose 7 window openings are `IfcFacetedBrep`
//! stepped-reveal prisms carrying NO authored extrusion direction. Because the
//! openings arrive with `depth = None`, `cut_in_wall_frame` (#1167)
//! bails and the wall is cut in world space at ~1.5 Mm, fragmenting into flap
//! triangles that bridge the openings (a 23 m edge spanning the whole wall
//! face). This fixture is the wall isolated WITH its voids by
//! `ifc-lite extract-entities`.

use ifc_lite_core::{build_entity_index, EntityDecoder, EntityScanner};
use ifc_lite_geometry::{
    local_frame_set_enabled_override, propagate_voids_to_parts, GeometryRouter, Mesh,
};
use rustc_hash::FxHashMap;

const WALL_ID: u32 = 928204;
const IFC: &str = include_str!("fixtures/issue_098_wall_W.ifc");

/// Unpaired directed edges on a 0.1 mm grid — a low count means the cut stayed
/// essentially watertight.
fn open_edges(m: &Mesh) -> i64 {
    use std::collections::HashMap;
    let q = |i: u32| {
        let b = i as usize * 3;
        (
            (m.positions[b] * 1.0e4).round() as i64,
            (m.positions[b + 1] * 1.0e4).round() as i64,
            (m.positions[b + 2] * 1.0e4).round() as i64,
        )
    };
    let mut edges: HashMap<((i64, i64, i64), (i64, i64, i64)), i64> = HashMap::new();
    for t in m.indices.chunks_exact(3) {
        let k = [q(t[0]), q(t[1]), q(t[2])];
        for (u, v) in [(0, 1), (1, 2), (2, 0)] {
            *edges.entry((k[u], k[v])).or_insert(0) += 1;
            *edges.entry((k[v], k[u])).or_insert(0) -= 1;
        }
    }
    edges.values().map(|c| c.abs()).sum()
}

fn max_edge(m: &Mesh) -> f32 {
    let v = |i: u32| {
        let b = i as usize * 3;
        [m.positions[b], m.positions[b + 1], m.positions[b + 2]]
    };
    let mut mx = 0.0f32;
    for t in m.indices.chunks_exact(3) {
        let (a, b, c) = (v(t[0]), v(t[1]), v(t[2]));
        for (p, q) in [(a, b), (b, c), (c, a)] {
            let d = ((p[0] - q[0]).powi(2) + (p[1] - q[1]).powi(2) + (p[2] - q[2]).powi(2)).sqrt();
            mx = mx.max(d);
        }
    }
    mx
}

fn mesh_volume(m: &Mesh) -> f64 {
    let v = |i: u32| {
        let b = i as usize * 3;
        [m.positions[b] as f64, m.positions[b + 1] as f64, m.positions[b + 2] as f64]
    };
    (m.indices
        .chunks_exact(3)
        .map(|t| {
            let (a, b, c) = (v(t[0]), v(t[1]), v(t[2]));
            a[0] * (b[1] * c[2] - b[2] * c[1]) + a[1] * (b[2] * c[0] - b[0] * c[2])
                + a[2] * (b[0] * c[1] - b[1] * c[0])
        })
        .sum::<f64>()
        / 6.0)
        .abs()
}

fn build_void_index(content: &str) -> FxHashMap<u32, Vec<u32>> {
    let mut void_index: FxHashMap<u32, Vec<u32>> = FxHashMap::default();
    let mut scanner = EntityScanner::new(content);
    let mut decoder = EntityDecoder::new(content);
    while let Some((id, type_name, start, end)) = scanner.next_entity() {
        if type_name == "IFCRELVOIDSELEMENT" {
            if let Ok(entity) = decoder.decode_at_with_id(id, start, end) {
                if let (Some(h), Some(o)) = (entity.get_ref(4), entity.get_ref(5)) {
                    void_index.entry(h).or_default().push(o);
                }
            }
        }
    }
    let _ = propagate_voids_to_parts(&mut void_index, content, &mut decoder);
    void_index
}

fn voided_wall() -> Mesh {
    // Match the wasm/viewer default (per-element local frame ON, #1114).
    local_frame_set_enabled_override(Some(true));
    let entity_index = build_entity_index(IFC);
    let mut decoder = EntityDecoder::with_index(IFC, entity_index);
    let router = GeometryRouter::with_units(IFC, &mut decoder);
    let void_index = build_void_index(IFC);
    assert_eq!(void_index.get(&WALL_ID).map(|v| v.len()), Some(7), "expected 7 voids");
    let wall = decoder.decode_by_id(WALL_ID).expect("decode wall");
    router
        .process_element_with_voids(&wall, &mut decoder, &void_index)
        .expect("process wall with voids")
}

#[test]
fn dump_wall_mesh() {
    let voided = voided_wall();
    // Fold origin to world, emit a tiny JSON for offline rendering.
    let o = voided.origin;
    let mut s = String::from("{\"positions\":[");
    for (i, c) in voided.positions.chunks_exact(3).enumerate() {
        if i > 0 {
            s.push(',');
        }
        s.push_str(&format!(
            "{},{},{}",
            c[0] as f64 + o[0],
            c[1] as f64 + o[1],
            c[2] as f64 + o[2]
        ));
    }
    s.push_str("],\"indices\":[");
    for (i, x) in voided.indices.iter().enumerate() {
        if i > 0 {
            s.push(',');
        }
        s.push_str(&x.to_string());
    }
    s.push_str("]}");
    let path = std::env::var("WALL_DUMP").unwrap_or_default();
    if !path.is_empty() {
        std::fs::write(&path, s).unwrap();
        println!("[#098 dump] wrote {path}");
    }
}

// #3440/#3871: the accept gates (`csg_manifold_gate`, `csg_topology_gate`)
// used to reject this wall's exact cut and fall back to a worse result, so
// the gated builds carried measured pins instead of the bar (166 and 436
// unpaired edges at their last reading). Cut in the frame of its site
// placement, the kernel results pass both checks at the accept paths (no
// torn result, no over-used edge), so no fallback runs: 12 unpaired edges,
// which arise after those paths as in the default build, and IfcOpenShell
// 0.8.2's volume (32.419 m3) in every build, so the bar below applies to
// all of them.

#[test]
fn reveal_wall_openings_do_not_leave_flaps() {
    let voided = voided_wall();
    let open = open_edges(&voided);
    let mx = max_edge(&voided);
    let vol = mesh_volume(&voided);
    println!(
        "[#098 wall] tris={} vol={:.3} openEdges={} maxEdge={:.3}",
        voided.triangle_count(),
        vol,
        open,
        mx
    );

    // NOTE: maxEdge ~23 m is the LEGIT uncut top/bottom-face diagonal of a 23 m
    // wall, not a defect — the real metric is unpaired (open) edges. Pre-fix the
    // exact-arrangement kernel left ~2534 (badly torn); the off-plane-constraint
    // + weld-for-batching fixes brought it to ~42 (5 of 7 windows fully
    // watertight, the reveals preserved); the site-frame cut (#10435) to 12.
    // Guard against regression past that.
    assert!(open <= 12, "cut re-fragmented: {open} unpaired edges (was 12)");
    // IfcOpenShell 0.8.2 reads 32.419 m3 for this cut wall (42.371 uncut).
    assert!((vol - 32.419).abs() < 32.419 * 5.0e-4, "wall volume {vol:.3} m³, IfcOpenShell 32.419");
}
