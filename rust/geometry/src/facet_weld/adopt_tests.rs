// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use super::*;
use crate::mesh::Mesh;

/// A closed box of `size` with one corner at the origin: 12 triangles.
fn box_mesh(size: [f32; 3]) -> Mesh {
    let [x, y, z] = size;
    let corners = [
        [0.0, 0.0, 0.0], [x, 0.0, 0.0], [x, y, 0.0], [0.0, y, 0.0],
        [0.0, 0.0, z], [x, 0.0, z], [x, y, z], [0.0, y, z],
    ];
    let quads = [[0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7]];
    let mut mesh = Mesh::new();
    for quad in quads {
        let base = (mesh.positions.len() / 3) as u32;
        for corner in quad {
            mesh.positions.extend_from_slice(&corners[corner]);
            mesh.normals.extend_from_slice(&[0.0, 0.0, 1.0]);
        }
        mesh.indices.extend_from_slice(&[base, base + 1, base + 2, base, base + 2, base + 3]);
    }
    mesh
}

fn quality(slivers: usize, max_aspect: f64, unpaired_edges: usize) -> Quality {
    Quality { shape: TriangleShape { slivers, max_aspect }, unpaired_edges }
}

/// A 12 mm sheet: its four narrow faces are 250:1 by any triangulation.
const SHEET: [f32; 3] = [3.0, 0.012, 3.0];

#[test]
fn the_raw_pass_multiplies_the_needles_of_a_thin_sheet() {
    let sheet = box_mesh(SHEET);
    let before = Quality::of(&sheet);
    assert_eq!((sheet.indices.len() / 3, before.shape.slivers), (12, 8));

    let refined = refine_high_aspect_slivers_impl(&sheet, None, true).expect("the sheet's needles fire the pass");
    let after = Quality::of(&refined);
    assert!(after.shape.slivers > before.shape.slivers, "{} -> {} slivers", before.shape.slivers, after.shape.slivers);
    assert_eq!(after.unpaired_edges, 0, "the split itself stays closed");
}

#[test]
fn a_refinement_that_adds_slivers_is_not_kept() {
    let sheet = box_mesh(SHEET);
    let kept = refine_slivers_if_better(sheet.clone());
    let after = Quality::of(&kept);
    assert_eq!((kept.indices.len() / 3, after.shape.slivers, after.unpaired_edges), (12, 8, 0));
    assert!((after.shape.max_aspect - 250.0).abs() < 0.5, "worst aspect {}", after.shape.max_aspect);
}

/// Canonicalising alone drops a triangle two of whose corners share a 100 um
/// cell. With more of those than the bisection adds slivers, the refined mesh
/// has fewer slivers than the raw one and more than the canonicalised one. It
/// is judged against the canonicalised one.
#[test]
fn a_refinement_takes_no_credit_for_what_canonicalising_drops() {
    let sheet = box_mesh(SHEET);
    let bisected = refine_high_aspect_slivers_impl(&sheet, None, true).expect("the sheet fires the pass");
    let added = Quality::of(&bisected).shape.slivers - 8;
    let mut mesh = sheet;
    for i in 0..=added {
        let base = (mesh.positions.len() / 3) as u32;
        let x = 10.0 + i as f32;
        mesh.positions.extend_from_slice(&[x, 0.0, 0.0, x, 3.0e-5, 0.0, x, 0.0, 1.0]);
        mesh.normals.extend_from_slice(&[1.0, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 0.0, 0.0]);
        mesh.indices.extend_from_slice(&[base, base + 1, base + 2]);
    }
    let raw = Quality::of(&mesh);
    assert_eq!(raw.shape.slivers, 8 + added + 1);

    let refined = refine_high_aspect_slivers_impl(&mesh, None, true).expect("the needles fire the pass");
    assert!(Quality::of(&refined).improves_on(&raw), "against the raw mesh the refinement reads as better");
    let kept = keep_if_better(&mesh, refined);
    assert_eq!((kept.indices.len() / 3, Quality::of(&kept).shape.slivers), (12, 8));
}

#[test]
fn a_mesh_without_slivers_comes_back_untouched() {
    let cube = box_mesh([1.0, 1.0, 1.0]);
    let kept = refine_slivers_if_better(cube.clone());
    assert_eq!((kept.positions, kept.indices), (cube.positions, cube.indices));
}

/// The verdict is the one `scripts/mesh-census-compare.mjs` gives a branch
/// mesh against its base: no sliver gained, worst aspect within 1.5x, and
/// better on one of the two.
#[test]
fn the_rule_is_the_census_comparison() {
    let before = quality(10, 400.0, 0);
    assert!(quality(9, 400.0, 0).improves_on(&before), "a sliver fewer");
    assert!(quality(10, 300.0, 0).improves_on(&before), "a lower worst aspect");
    assert!(quality(9, 590.0, 0).improves_on(&before), "fewer slivers, aspect inside 1.5x");
    assert!(!quality(10, 400.0, 0).improves_on(&before), "nothing gained");
    assert!(!quality(11, 100.0, 0).improves_on(&before), "a sliver more");
    assert!(!quality(9, 601.0, 0).improves_on(&before), "aspect past 1.5x");
    assert!(!quality(5, 100.0, 1).improves_on(&before), "an edge left unpaired");
}
