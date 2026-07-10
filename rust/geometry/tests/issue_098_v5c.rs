// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Issue #098: a DENSER instance of the same Poroton wall type as the sibling
//! `issue_098_reveal_wall` test — `IfcWallStandardCase` #1512699,
//! `3FceP9AqX1_92g5eDdrV5C` — whose 7 `IfcFacetedBrep` stepped-reveal window
//! openings batch onto ONE wall face. The dense near-collinear reveal cluster
//! defeats the incremental constraint recovery (earcut can only fan it into
//! sliver tips); the Sloan traversal fallback + volume-safe batched difference
//! bring it from ~2072 open edges (badly torn) to ~108 with the removed volume
//! unchanged. This fixture is the wall isolated WITH its voids by
//! `ifc-lite extract-entities`.

use ifc_lite_core::{build_entity_index, EntityDecoder, EntityScanner};
use ifc_lite_geometry::{
    local_frame_set_enabled_override, propagate_voids_to_parts, GeometryRouter, Mesh,
};
use rustc_hash::FxHashMap;

const WALL_ID: u32 = 1512699;
const IFC: &str = include_str!("fixtures/issue_098_wall_V5C.ifc");

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

// A SECOND, denser instance of the same Poroton Ventilata wall type as
// `issue_098_reveal_wall` (wall W): #1512699 / `3FceP9AqX1_92g5eDdrV5C`, 7 faceted-
// BREP splayed-reveal windows batched onto ONE face. Its dense CDT leaves a few
// constraints the boundary-walk recovery can't force; the Sloan ordered-traversal
// fallback recovers most, and the volume-safe batched-difference accept keeps the
// exact (cleaner) batched cut instead of the sequential re-jitter. Together with
// the off-plane fix this brings the wall from ~2072 open edges (badly torn) to
// ~108 with the removed volume unchanged. Guard against regression past that.
#[test]
fn v5c_dense_reveal_wall_not_torn() {
    let voided = voided_wall();
    let open = open_edges(&voided);
    let vol = mesh_volume(&voided);
    println!("[V5C] tris={} vol={vol:.3} openEdges={open}", voided.triangle_count());
    assert!(open < 160, "V5C re-fragmented: {open} unpaired edges (was ~108)");
    assert!(vol > 30.0, "V5C under-cut: volume {vol:.3} m³ collapsed (was ~33.4)");
}
