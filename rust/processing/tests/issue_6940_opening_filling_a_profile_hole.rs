// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Issue #6940 through the shared producer: floor slabs whose profile already
//! carries its holes (`IfcArbitraryProfileDefWithVoids`) and whose
//! `IfcOpeningElement`s fill those holes exactly, footprint and depth. The
//! openings remove nothing, so each slab must come back closed.
//!
//! They tore where a second hole had a wall a few micrometres off collinear
//! with a wall of a filled one: the router extends the opening cutter through
//! the slab, and the subtract weld then moved the extended corner off its own
//! hole wall onto the other hole's wall plane. The kernel-level reproduction
//! is `rust/geometry/tests/issue_6940_hole_wall_cutter_weld.rs` and needs no
//! fixture. This one enters through `process_geometry`, the native
//! orchestrator over `produce_element_meshes`, so it covers the path every
//! consumer shares rather than the kernel entry point alone.
//!
//! It needs the fixture because a hand-written slab of this shape does not
//! tear here: measured with the guard switched off, a two-hole slab with one
//! or both holes filled has its cutter welded 18 vertices off its walls and
//! still comes back closed through the router. The seven slabs below do tear
//! without the guard (39 open edges each on `main`).

use ifc_lite_processing::process_geometry;
use std::collections::HashMap;

const FIXTURE: &str = "tests/models/georeferencer/MiniBIM-3.1-DO_01_VORM.ifc";

/// The slabs every one of whose openings fills a hole of its own profile.
const SLABS: [u32; 7] = [137627, 139545, 141434, 143323, 145212, 151760, 154626];

/// `IFC_LITE_REQUIRE_FIXTURES`, read as `rust/export/src/test_support.rs`
/// documents it: unset, empty or `"0"` skips a missing fixture, `"1"` (CI)
/// makes it a failure, anything else panics.
fn require_fixtures() -> bool {
    match std::env::var("IFC_LITE_REQUIRE_FIXTURES") {
        Err(std::env::VarError::NotPresent) => false,
        Ok(v) if v.is_empty() || v == "0" => false,
        Ok(v) if v == "1" => true,
        other => panic!(
            "IFC_LITE_REQUIRE_FIXTURES must be unset, \"\", \"0\" or \"1\"; got {other:?}"
        ),
    }
}

/// Undirected edges not used exactly once in each direction, vertices welded
/// at 1 mm: 0 iff the triangles close consistently wound. Collapsed triangles
/// are skipped, as the watertightness census skips them.
fn open_edges(triangles: &[[[i64; 3]; 3]]) -> usize {
    let mut edges: HashMap<([i64; 3], [i64; 3]), (u32, u32)> = HashMap::new();
    for [a, b, c] in triangles {
        if a == b || b == c || c == a {
            continue;
        }
        for (x, y) in [(a, b), (b, c), (c, a)] {
            let uses = edges.entry((*x.min(y), *x.max(y))).or_insert((0, 0));
            if x < y {
                uses.0 += 1;
            } else {
                uses.1 += 1;
            }
        }
    }
    edges.values().filter(|&&(f, r)| f != 1 || r != 1).count()
}

#[test]
fn issue_6940_openings_filling_profile_holes_leave_the_slabs_closed() {
    let path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join(FIXTURE);
    let bytes = match std::fs::read(&path) {
        Ok(bytes) => bytes,
        Err(e) => {
            assert!(
                !require_fixtures(),
                "{FIXTURE} is missing ({e}) and IFC_LITE_REQUIRE_FIXTURES=1"
            );
            eprintln!("{FIXTURE} missing, skipping; fetch it with `pnpm fixtures`");
            return;
        }
    };
    let result = process_geometry(&bytes);
    for id in SLABS {
        let mut triangles = Vec::new();
        for mesh in result.meshes.iter().filter(|m| m.express_id == id) {
            let key = |i: u32| {
                let b = i as usize * 3;
                [0, 1, 2].map(|k| {
                    ((mesh.positions[b + k] as f64 + mesh.origin[k]) * 1e3).round() as i64
                })
            };
            triangles.extend(mesh.indices.chunks_exact(3).map(|t| [key(t[0]), key(t[1]), key(t[2])]));
        }
        assert!(!triangles.is_empty(), "slab {id}: no mesh was produced");
        assert_eq!(
            open_edges(&triangles),
            0,
            "slab {id}: openings that fill its profile holes tore it ({} triangles)",
            triangles.len()
        );
    }
}
