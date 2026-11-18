// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Issue #10590: B-spline faces of a Revit/ODA-style slab.
//!
//! `tests/fixtures/issue_10590_bspline_slab.ifc` is a hand-written 4 m x 2 m
//! slab, an `IfcAdvancedBrep` with:
//! - a flat B-spline bottom whose 2 x 2 control net is 6 m x 4 m, larger than
//!   the face, as Revit writes flat faces. On `main` the whole net was drawn,
//!   1 m past the slab on every side;
//! - a curved (twisted bilinear) B-spline top whose Su x Sv points down, with
//!   `SameSense = .F.`. On `main` its grid wound against Su x Sv, so after the
//!   SameSense reversal it faced into the slab;
//! - four `IfcPlane` sides.
//!
//! Closed and facing out, the mesh encloses 4 x 2 x 0.375 (mean height) =
//! 3 m3 and stays within the footprint.

use ifc_lite_processing::{process_geometry, MeshData};

const SLAB: u32 = 30;

fn slab() -> MeshData {
    let path = format!(
        "{}/tests/fixtures/issue_10590_bspline_slab.ifc",
        env!("CARGO_MANIFEST_DIR")
    );
    let bytes = std::fs::read(&path).unwrap_or_else(|e| panic!("read {path}: {e}"));
    let mut meshes: Vec<MeshData> = process_geometry(&bytes)
        .meshes
        .into_iter()
        .filter(|m| m.express_id == SLAB)
        .collect();
    assert_eq!(meshes.len(), 1, "slab #{SLAB} is one mesh");
    meshes.pop().expect("one mesh")
}

fn triangles(mesh: &MeshData) -> Vec<[[f64; 3]; 3]> {
    let world = |i: u32| {
        let b = i as usize * 3;
        [0, 1, 2].map(|k| mesh.positions[b + k] as f64 + mesh.origin[k])
    };
    mesh.indices
        .chunks_exact(3)
        .map(|t| [world(t[0]), world(t[1]), world(t[2])])
        .collect()
}

fn cross(u: [f64; 3], v: [f64; 3]) -> [f64; 3] {
    [
        u[1] * v[2] - u[2] * v[1],
        u[2] * v[0] - u[0] * v[2],
        u[0] * v[1] - u[1] * v[0],
    ]
}

fn sub(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

/// Signed volume by the divergence theorem: positive when closed and facing out.
fn signed_volume(tris: &[[[f64; 3]; 3]]) -> f64 {
    tris.iter()
        .map(|[a, b, c]| {
            let n = cross(*b, *c);
            (a[0] * n[0] + a[1] * n[1] + a[2] * n[2]) / 6.0
        })
        .sum()
}

#[test]
fn issue_10590_flat_bspline_bottom_is_trimmed_to_the_slab() {
    let tris = triangles(&slab());
    for p in tris.iter().flatten() {
        assert!(
            (-1e-4..=4.0001).contains(&p[0]) && (-1e-4..=2.0001).contains(&p[1]),
            "vertex {p:?} lies outside the 4 m x 2 m footprint"
        );
    }
    // A missing or reversed z=0 face contributes nothing to signed volume.
    // Observe the bottom itself so neither defect can satisfy this test.
    let bottom: Vec<_> = tris
        .iter()
        .filter(|t| t.iter().all(|p| p[2].abs() < 1e-4))
        .collect();
    assert!(!bottom.is_empty(), "trimmed bottom must be present");
    let mut projected_area = 0.0;
    for [a, b, c] in bottom {
        let normal = cross(sub(*b, *a), sub(*c, *a));
        assert!(normal[2] < 0.0, "bottom triangle {a:?} {b:?} {c:?} faces up");
        projected_area -= normal[2] * 0.5;
    }
    assert!(
        (projected_area - 8.0).abs() < 1e-4,
        "trimmed bottom projected area is {projected_area} m2, not 8 m2"
    );
}

#[test]
fn issue_10590_curved_bspline_top_faces_out_of_the_slab() {
    let tris = triangles(&slab());
    let top: Vec<_> = tris
        .iter()
        .filter(|t| t.iter().all(|p| p[2] > 0.29))
        .collect();
    assert!(!top.is_empty(), "the slab has a top");
    for [a, b, c] in &top {
        let n = cross(sub(*b, *a), sub(*c, *a));
        assert!(
            n[2] > 0.0,
            "top triangle {a:?} {b:?} {c:?} faces down, into the slab"
        );
    }
    let volume = signed_volume(&tris);
    // The twisted top is tessellated, so allow a few litres of chord error.
    assert!(
        (volume - 3.0).abs() < 0.01,
        "encloses {volume} m3, not 3 m3"
    );
}
