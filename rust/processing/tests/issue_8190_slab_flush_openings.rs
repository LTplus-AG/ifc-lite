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

/// Triangles lying on the plane y = `y` over the seam's extent in x: faces of a
/// strip of host between the openings. The band is 100 um because the mesh
/// carries the file's plane about 33 um off after placement and the f32 cast.
/// The real jamb on that plane, #12659's head past #13497, starts at x = 25.23,
/// outside the range.
fn seam_faces(mesh: &MeshData, y: f64, x: [f64; 2]) -> usize {
    mesh.indices
        .chunks_exact(3)
        .filter(|t| {
            t.iter().all(|&i| {
                let p = world(mesh, i);
                (p[1] - y).abs() < 1e-4 && p[0] > x[0] + 1e-3 && p[0] < x[1] - 1e-3
            })
        })
        .count()
}

/// Area of the triangles lying on the plane y = `y` (same 100 um band as
/// [`seam_faces`]) within `x`.
fn plane_area(mesh: &MeshData, y: f64, x: [f64; 2]) -> f64 {
    mesh.indices
        .chunks_exact(3)
        .map(|t| [t[0], t[1], t[2]].map(|i| world(mesh, i)))
        .filter(|p| p.iter().all(|q| (q[1] - y).abs() < 1e-4 && q[0] > x[0] && q[0] < x[1]))
        .map(|[a, b, c]| {
            let (u, v) = ([b[0] - a[0], b[1] - a[1], b[2] - a[2]], [c[0] - a[0], c[1] - a[1], c[2] - a[2]]);
            let n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
            (n[0] * n[0] + n[1] * n[1] + n[2] * n[2]).sqrt() / 2.0
        })
        .sum()
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

/// Rectangle #12681 (x 6.825 to 8.825) and pentagon #13475 (top edge x 5.384
/// to 8.144) share y = 16.570046 in the file, overlapping for 1.32 m, and the
/// seam runs at 23 degrees in the frame the cut happens in. Their footprints
/// met at a T-junction the snap alone left open, so they were cut as two
/// prisms with 1.32 m by 1.2 m of host standing between them (#8190).
#[test]
fn issue_8190_partly_overlapping_flush_openings_fuse_in_slab_12381() {
    let mesh = slab();
    // What the plane may carry: the two jambs past the overlap, the
    // pentagon's from x = 5.384 to 6.825 and the rectangle's from 8.144 to
    // 8.825, each 1.2 m deep. Both faces of the strip would add 3.16 m2.
    let jambs = (6.8250055 - 5.3835656 + 8.8250055 - 8.1435656) * 1.2;
    let on_plane = plane_area(&mesh, 16.570046, [5.3, 8.9]);
    assert!((on_plane - jambs).abs() < 5e-3, "y = 16.570046 carries {on_plane} m2, the jambs {jambs} m2");
}
