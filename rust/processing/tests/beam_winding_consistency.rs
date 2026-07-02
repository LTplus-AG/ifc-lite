// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Regression: assembled element bodies must be consistently outward-wound.
//!
//! `IfcBeam` bodies in this model are hollow tubes built from booleans /
//! faceted breps, which arrived with MIXED per-triangle winding (some faces
//! inward) — corrupting signed volume and the smooth normals used for lighting.
//! `produce_element_meshes` now runs `orient_mesh_outward` on the assembled body,
//! so every beam mesh comes out winding-consistent. A consistently-oriented mesh
//! never has a DIRECTED welded edge traversed twice (the opposite direction
//! carries the shared edge for the neighbour); two same-direction traversals mean
//! two triangles cross that edge with the same winding.

use ifc_lite_core::EntityScanner;
use ifc_lite_processing::process_geometry;
use std::collections::{HashMap, HashSet};

const FIXTURE: &str = "../../tests/models/ara3d/ISSUE_021_Mini Project.ifc";

fn read_fixture() -> Option<String> {
    match std::fs::read_to_string(FIXTURE) {
        Ok(s) => Some(s),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            eprintln!(
                "skipping beam-winding regression: fixture missing at {FIXTURE} — \
                 run `pnpm fixtures` (sha256 in tests/models/manifest.json)"
            );
            None
        }
        Err(e) => panic!("failed to read fixture {FIXTURE}: {e}"),
    }
}

/// Directed welded edges seen >= 2 times (winding-inconsistent edges).
// The quantized directed-edge key type is explicit by design in this test helper.
#[allow(clippy::type_complexity)]
fn inconsistent_edges(positions: &[f32], origin: [f64; 3], indices: &[u32]) -> usize {
    let q = |v: f32, o: f64| ((v as f64 + o) * 1.0e5).round() as i64;
    let key = |i: u32| {
        let b = i as usize * 3;
        (q(positions[b], origin[0]), q(positions[b + 1], origin[1]), q(positions[b + 2], origin[2]))
    };
    let mut dir: HashMap<((i64, i64, i64), (i64, i64, i64)), u32> = HashMap::new();
    for t in indices.chunks_exact(3) {
        let (a, b, c) = (key(t[0]), key(t[1]), key(t[2]));
        for e in [(a, b), (b, c), (c, a)] {
            *dir.entry(e).or_insert(0) += 1;
        }
    }
    dir.values().filter(|&&c| c >= 2).count()
}

#[test]
fn beam_meshes_are_winding_consistent() {
    let Some(content) = read_fixture() else { return };

    let mut beam_ids: HashSet<u32> = HashSet::new();
    let mut scanner = EntityScanner::new(&content);
    while let Some((id, t, _, _)) = scanner.next_entity() {
        if t == "IFCBEAM" {
            beam_ids.insert(id);
        }
    }
    assert!(!beam_ids.is_empty(), "fixture must contain IfcBeam entities");

    let result = process_geometry(&content);

    let mut beams = 0usize;
    let mut bad_beams = 0usize;
    let mut bad_edges_total = 0usize;
    let mut per_beam: HashMap<u32, usize> = HashMap::new();
    for m in result.meshes.iter().filter(|m| beam_ids.contains(&m.express_id)) {
        *per_beam.entry(m.express_id).or_insert(0) +=
            inconsistent_edges(&m.positions, m.origin, &m.indices);
    }
    for (_, bad) in per_beam {
        beams += 1;
        if bad > 0 {
            bad_beams += 1;
            bad_edges_total += bad;
        }
    }

    assert!(beams > 100, "expected the model's many beams, got {beams}");
    assert_eq!(
        bad_beams, 0,
        "{bad_beams}/{beams} beam meshes are winding-inconsistent ({bad_edges_total} bad edges) — \
         orient_mesh_outward should make every assembled body outward-consistent"
    );
}
