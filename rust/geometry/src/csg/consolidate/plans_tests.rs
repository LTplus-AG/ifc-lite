// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
use super::*;
use super::super::{plane_merge::PlaneTri, tri_is_needle};
use super::super::supported_cells::healthy_fold_boundary;
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
fn issue_7292_unsupported_open_fold_keeps_ordinary_cleanup() {
    let height = 1.0 / 65_536.0;
    let tris = folded_quad_7292(2.0, height);
    let mut input = tris_to_mesh(&tris);
    input.plane_tags = None; // Same untagged source as the actual binary cut.
    let buckets = super::super::buckets::build(&input);
    assert_eq!(buckets.len(), 1, "both planes occupy the existing coarse bucket");
    let output = ClippingProcessor::consolidate_coplanar(input);
    assert_eq!(height_7292(&output, 0.5, 0.5), vec![0.0]);
    assert_eq!(height_7292(&output, 0.5, -0.5), vec![0.0],
        "an isolated fold lacks four unique opposed healthy supports");
}

#[test]
fn issue_7292_exact_coplanar_pair_keeps_ordinary_union_eligibility() {
    let tris = folded_quad_7292(2.0, 0.0);
    assert!(healthy_fold_boundary(&faces_7292(tris).each_ref()).is_none());
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
    assert!(healthy_fold_boundary(&faces.each_ref()).is_none(), "new fold eligibility cannot bypass needle cleanup");
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
    assert!(healthy_fold_boundary(&faces.each_ref()).is_none(), "source-plane certificates retain their established projection path");
}

#[test]
fn issue_7292_nonfinite_fold_cannot_enter_raw_retention() {
    let mut faces = faces_7292(folded_quad_7292(2.0, 1.0 / 65_536.0));
    faces[1].v[2].z = f64::NAN;
    assert!(healthy_fold_boundary(&faces.each_ref()).is_none(), "invalid fourth vertex must not reach the exact orientation predicate");
}

// Closed source star: the fold's four outside edges have healthy opposed
// supports. A disjoint supported tetrahedron seeds the upper plane bucket,
// which already keeps the P-Q-R chain under existing thin-cell policy.
fn supported_fold_star_7292() -> Vec<Tri> {
    let (gap, height) = (1.0 / 65_536.0, 1.0 / 4096.0);
    let (p, q, r, o, s) = ([0.0, 100.0, 0.0], [1.0, 100.0 + gap, 0.0],
        [4.0, 100.0, 0.0], [0.0, 104.0, 0.0], [2.0, 98.0, height]);
    let mut faces = vec![[o, r, q], [o, q, p], [p, q, s], [s, q, r], [o, p, s], [o, s, r]];
    let (a, b, c, d) = ([10.0, 100.0, 0.0], [10.0 + 1.0 / 8192.0, 100.0, 0.0],
        [14.0, 104.0, 0.0], [10.0, 100.0 - 1.0 / 1024.0, 1.0 / 1024.0]);
    faces.extend([[b, a, c], [a, b, d], [b, c, d], [c, a, d]]);
    faces
}

#[test]
fn issue_7292_supported_source_star_retains_the_actual_shared_fold_chain() {
    let mut faces = supported_fold_star_7292();
    faces.truncate(6); // The closed healthy star needs no thin-cell seed.
    let mut input = tris_to_mesh(&faces);
    input.plane_tags = None;
    let buckets = super::super::buckets::build(&input);
    let supported = supported_cells::find(&buckets);
    assert!(supported.cells.is_empty(), "this source star contains no retained thin cells");
    assert_eq!(supported.folded_buckets.len(), 1, "only the fully supported finite fold opts in");
    let output = ClippingProcessor::consolidate_coplanar(input);
    // The query has exact barycentrics (1/2,1/4,1/4) on the second folded
    // triangle S-Q-R; its analytic height is half S.z, irrespective of Q.y.
    let hits = height_7292(&output, 2.25, 99.0 + 1.0 / 262_144.0);
    assert_eq!(hits.iter().filter(|&&z| z == 1.0 / 8192.0).count(), 1,
        "the source-supported fold keeps its nonflat analytic boundary");
}

#[test]
fn issue_7292_fold_star_requires_complete_unique_opposed_source_support() {
    for mutation in 0..4 {
        let mut faces = supported_fold_star_7292();
        match mutation {
            0 => { faces.remove(4); } // Open outer edge.
            1 => { faces[4].swap(0, 1); } // Same-directed support.
            2 => { faces.push(faces[4]); } // Third/nonmanifold edge use.
            _ => { // Unrelated positive-area overlap in an external support bucket.
                faces.push([[1.0,102.0,0.0],[2.0,102.0,0.0],[1.5,101.0,0.0]]);
            }
        }
        let target = supported_cells::cell_key(&faces[2].map(Point3::from));
        let mut input = tris_to_mesh(&faces);
        input.plane_tags = None;
        let buckets = super::super::buckets::build(&input);
        let key = buckets.iter().find(|(_, ts)| ts.iter()
            .any(|t| supported_cells::cell_key(&t.v) == target)).map(|(key, _)| key).unwrap();
        let supported = supported_cells::find(&buckets);
        assert!(!supported.buckets.contains(key),
            "an open, reversed, nonmanifold or overlapping support must not opt in");
    }
}

#[test]
fn issue_7292_unrelated_nonmanifold_source_refuses_fold_but_keeps_thin_certificate() {
    let mut faces = supported_fold_star_7292();
    let mut input = tris_to_mesh(&faces);
    input.plane_tags = None;
    let closed = supported_cells::find(&super::super::buckets::build(&input));
    assert_eq!(closed.folded_buckets.len(), 1, "the closed source star is eligible");
    assert!(!closed.cells.is_empty(), "the disjoint thin cell has its own local support");
    // Three uses of each remote edge, with both directions present. The local
    // fold and all four opposite supports are unchanged; the whole source is
    // nevertheless nonmanifold and cannot justify preserving healthy buckets.
    let stray = [[32.0,0.0,0.0],[32.0,2.0,0.0],[32.0,0.0,2.0]];
    faces.extend([stray,[stray[0],stray[2],stray[1]],stray]);
    let mut input = tris_to_mesh(&faces);
    input.plane_tags = None;
    let nonmanifold = supported_cells::find(&super::super::buckets::build(&input));
    assert!(nonmanifold.folded_buckets.is_empty(),
        "a closed local star cannot authorize fold retention in an unpaired source");
    assert!(nonmanifold.fold_support_buckets.is_empty());
    assert_eq!(nonmanifold.cells, closed.cells,
        "the existing local thin-cell certificate does not require global closure");
}
