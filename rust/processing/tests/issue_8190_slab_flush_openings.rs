// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Issue #8190: openings authored flush leave a strip of host standing when
//! the coaxial footprint union keeps their f32 disagreement.
//!
//! Slab #12381 of the ISSUE_129 model has 47 vertical through-openings.
//! Openings #12659 (y up to 3.100046) and #13497 (y from 3.100046) share that
//! plane in the file. Each footprint is projected from its own cutter's f32
//! caps, so the shared edges came back 1 to 7 um apart, and the exact i_overlay
//! union kept the strip: on `main` the slab had 15 open edges, a nonmanifold
//! edge and 12 m2 of strip faces under 200 um thick. The footprints are now
//! reconciled before the union (`router::voids::coaxial_union::snap`).
//!
//! `tests/fixtures/issue_8190_slab_12381.ifc` is the slab, its 47 openings,
//! the project and the site (whose placement sets the RTC offset), cut out of
//! `tests/models/ara3d/ISSUE_129_N1540_17_EXE_MOD_448200_02_09_11SMC_IGC_V17.ifc`
//! by `scripts/ifc-extract-hosts.py --anonymise`: names, contacts and the
//! site's latitude, longitude and elevation are blanked. The site placement is
//! kept because it sets the RTC offset, and with it every f32 rounding this
//! test is about; the source model is public in the fixture release. Through
//! `process_geometry` it gives the same slab mesh as the full model, before
//! the fix and after.

use ifc_lite_processing::{process_geometry, MeshData};
use std::collections::HashMap;

const SLAB: u32 = 12381;

fn slab() -> MeshData {
    let path = format!("{}/tests/fixtures/issue_8190_slab_12381.ifc", env!("CARGO_MANIFEST_DIR"));
    let bytes = std::fs::read(&path).unwrap_or_else(|e| panic!("read {path}: {e}"));
    let mut meshes: Vec<MeshData> = process_geometry(&bytes)
        .meshes
        .into_iter()
        .filter(|m| m.express_id == SLAB)
        .collect();
    assert_eq!(meshes.len(), 1, "slab #{SLAB} is one mesh");
    meshes.pop().expect("one mesh")
}

fn world(mesh: &MeshData, i: u32) -> [f64; 3] {
    let b = i as usize * 3;
    [0, 1, 2].map(|k| mesh.positions[b + k] as f64 + mesh.origin[k])
}

/// Undirected edges not used exactly twice, vertices welded at `quantum` m.
fn open_edges(mesh: &MeshData, quantum: f64) -> usize {
    let mut uses: HashMap<([i64; 3], [i64; 3]), u32> = HashMap::new();
    for t in mesh.indices.chunks_exact(3) {
        let [a, b, c] = [t[0], t[1], t[2]].map(|i| world(mesh, i).map(|v| (v / quantum).round() as i64));
        if a == b || b == c || c == a {
            continue;
        }
        for (x, y) in [(a, b), (b, c), (c, a)] {
            *uses.entry((x.min(y), x.max(y))).or_insert(0) += 1;
        }
    }
    uses.values().filter(|&&n| n != 2).count()
}

/// Triangles lying on the plane y = `y` (all three vertices within 100 um of
/// it) whose centroid falls inside the seam's extent in x: faces of a strip of
/// host between the openings. The centroid, not every vertex, decides, so a
/// strip whose triangles reach the seam's ends is still counted. The band is
/// 100 um because the mesh carries the file's plane about 33 um off after
/// placement and the f32 cast. The real jamb on that plane, #12659's head past
/// #13497, starts at x = 25.23, so its centroids fall outside the range.
fn seam_faces(mesh: &MeshData, y: f64, x: [f64; 2]) -> usize {
    mesh.indices
        .chunks_exact(3)
        .filter(|t| {
            let p = [t[0], t[1], t[2]].map(|i| world(mesh, i));
            let cx = (p[0][0] + p[1][0] + p[2][0]) / 3.0;
            p.iter().all(|v| (v[1] - y).abs() < 1e-4) && cx > x[0] && cx < x[1]
        })
        .count()
}

#[test]
fn issue_8190_flush_openings_leave_no_strip_in_slab_12381() {
    let mesh = slab();
    for quantum in [1.0e-5, 1.0e-7] {
        assert_eq!(open_edges(&mesh, quantum), 0, "open edges at a {quantum} m weld");
    }
    // #12659 against #13497: 4 strip faces here on `main`.
    assert_eq!(seam_faces(&mesh, 3.100046, [21.23, 25.23]), 0, "strip faces at y = 3.100046");
}
