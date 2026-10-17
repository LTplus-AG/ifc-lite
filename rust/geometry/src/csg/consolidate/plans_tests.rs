// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
use super::*;
use nalgebra::Point3;
use crate::csg::ClippingProcessor;
use crate::kernel::{arrangement::Tri, mesh_bridge::tris_to_mesh};

fn folded_quad_7292(depth: f64, height: f64) -> [Tri; 2] {
    [
        [[0.0, 0.0, 0.0], [2.0, 0.0, 0.0], [0.0, 2.0, 0.0]],
        [[2.0, 0.0, 0.0], [0.0, 0.0, 0.0], [0.0, -depth, height]],
    ]
}

fn faces_7292(tris: [Tri; 2]) -> [PlaneTri; 2] {
    tris.map(|t| {
        let v = t.map(Point3::from);
        let normal = (v[1] - v[0]).cross(&(v[2] - v[0])).normalize();
        PlaneTri { v, normal, tag: None }
    })
}

// Independent vertical-line intersection through strict triangle interiors.
// Dyadic coordinates below make both interpolation and expected heights exact.
fn height_7292(mesh: &Mesh, x: f64, y: f64) -> Vec<f64> {
    let mut hits = Vec::new();
    for tri in mesh.indices.chunks_exact(3) {
        let t = [tri[0], tri[1], tri[2]].map(|i| {
            [0, 1, 2].map(|k| f64::from(mesh.positions[i as usize * 3 + k]))
        });
        let u = [0, 1, 2].map(|k| t[1][k] - t[0][k]);
        let v = [0, 1, 2].map(|k| t[2][k] - t[0][k]);
        let det = u[0] * v[1] - u[1] * v[0];
        if det == 0.0 { continue; }
        let alpha = ((x - t[0][0]) * v[1] - (y - t[0][1]) * v[0]) / det;
        let beta = (u[0] * (y - t[0][1]) - u[1] * (x - t[0][0])) / det;
        if alpha > 0.0 && beta > 0.0 && alpha + beta < 1.0 {
            hits.push(t[0][2] + alpha * u[2] + beta * v[2]);
        }
    }
    hits
}

#[test]
fn issue_7292_consolidation_preserves_a_healthy_two_cell_fold() {
    let height = 1.0 / 65_536.0;
    let tris = folded_quad_7292(2.0, height);
    let mut input = tris_to_mesh(&tris);
    input.plane_tags = None; // Same untagged source as the actual binary cut.
    let buckets = super::super::buckets::build(&input);
    assert_eq!(buckets.len(), 1, "both planes occupy the existing coarse bucket");
    let output = ClippingProcessor::consolidate_coplanar(input);
    assert_eq!(height_7292(&output, 0.5, 0.5), vec![0.0]);
    assert_eq!(height_7292(&output, 0.5, -0.5), vec![height / 4.0],
        "the second finite cell has analytic nonzero height; flattening loses it");
}

#[test]
fn issue_7292_exact_coplanar_pair_keeps_ordinary_union_eligibility() {
    let tris = folded_quad_7292(2.0, 0.0);
    assert!(!keep_healthy_folded_pair(&faces_7292(tris)));
    let mut input = tris_to_mesh(&tris);
    input.plane_tags = None;
    let output = ClippingProcessor::consolidate_coplanar(input);
    assert_eq!(height_7292(&output, 0.5, -0.5), vec![0.0]);
}

#[test]
fn issue_7292_two_cell_fold_cannot_restore_an_unsupported_needle() {
    let gap = 1.0 / 65_536.0;
    let tris = folded_quad_7292(gap, gap);
    let faces = faces_7292(tris);
    assert!(tri_is_needle(&faces[1].v), "the second cell meets the existing needle rule");
    assert!(!keep_healthy_folded_pair(&faces), "new fold eligibility cannot bypass needle cleanup");
    let mut input = tris_to_mesh(&tris);
    input.plane_tags = None;
    let output = ClippingProcessor::consolidate_coplanar(input);
    assert!(output.indices.iter().all(|&i| output.positions[i as usize * 3 + 2] == 0.0),
        "the unsupported folded needle is not retained through the new raw path");
}

#[test]
fn issue_7292_tagged_fold_keeps_existing_source_plane_reconstruction() {
    let mut faces = faces_7292(folded_quad_7292(2.0, 1.0 / 65_536.0));
    faces[0].tag = Some((faces[0].normal, 0.0));
    assert!(!keep_healthy_folded_pair(&faces), "source-plane certificates retain their established projection path");
}

#[test]
fn issue_7292_nonfinite_fold_cannot_enter_raw_retention() {
    let mut faces = faces_7292(folded_quad_7292(2.0, 1.0 / 65_536.0));
    faces[1].v[2].z = f64::NAN;
    assert!(!keep_healthy_folded_pair(&faces), "invalid fourth vertex must not reach the exact orientation predicate");
}
