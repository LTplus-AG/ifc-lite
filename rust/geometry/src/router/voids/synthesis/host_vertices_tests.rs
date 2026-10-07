// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! #6940: the rule of `reconcile_with_host_vertices` clause by clause, then
//! the tear it exists for, through the void router, on a slab made here.

use super::super::super::{world_host_bounds, GeometryRouter, OpeningType, VoidContext};
use super::reconcile_with_host_vertices;
use crate::kernel::mesh_bridge::SNAP_GRID;
use crate::kernel::mesh_volume::mesh_volume;
use crate::{extrude_profile, Mesh, Point2, Point3, Profile2D, Vector3};
use std::collections::HashMap;

/// `n` grid steps, as the f32 a mesh stores (exact below 256 units).
fn g(steps: i32) -> f32 {
    (steps as f64 * SNAP_GRID) as f32
}

/// A mesh of loose vertices; the rule reads positions only.
fn points(p: &[[f32; 3]]) -> Mesh {
    let mut m = Mesh::new();
    m.positions = p.iter().flatten().copied().collect();
    m.normals = vec![0.0; m.positions.len()];
    m
}

fn reconciled(cutter: &[[f32; 3]], host: &[[f32; 3]]) -> Vec<[f32; 3]> {
    reconcile_with_host_vertices(points(cutter), &points(host), Vector3::z())
        .positions
        .chunks_exact(3)
        .map(|p| [p[0], p[1], p[2]])
        .collect()
}

#[test]
fn a_cutter_vertex_one_step_from_a_host_vertex_becomes_it() {
    let host = [[1.0, 2.0, 3.0], [5.0, 5.0, 5.0]];
    for d in [[1, 0, 0], [0, -1, 0], [0, 0, 1], [1, -1, 0], [-1, 1, 1]] {
        let near = [1.0 + g(d[0]), 2.0 + g(d[1]), 3.0 + g(d[2])];
        assert_eq!(
            reconciled(&[near, [9.0, 9.0, 9.0]], &host),
            [[1.0, 2.0, 3.0], [9.0, 9.0, 9.0]],
            "offset {d:?} grid steps: one step on each axis is one rounding apart"
        );
    }
}

#[test]
fn two_steps_on_any_axis_is_a_different_point() {
    let host = [[1.0, 2.0, 3.0]];
    for d in [[2, 0, 0], [0, -2, 0], [1, 1, 2], [-2, 1, 0]] {
        let far = [1.0 + g(d[0]), 2.0 + g(d[1]), 3.0 + g(d[2])];
        assert_eq!(reconciled(&[far], &host), [far], "offset {d:?} grid steps");
    }
}

/// The comparison is made on what the kernel's snap will make of each vertex,
/// not on the stored f32: two values a fraction of a step apart that round to
/// neighbouring grid positions are one step apart, and two values most of a
/// step apart that round to the same position already agree.
#[test]
fn the_step_is_counted_on_snapped_positions() {
    let host = [[1.0 + g(1) * 0.45, 2.0, 3.0]]; // snaps down to 1.0
    let across = [1.0 + g(1) * 0.55, 2.0, 3.0]; // snaps up to one step
    assert_eq!(reconciled(&[across], &host), host);
    let same_cell = [1.0 - g(1) * 0.45, 2.0, 3.0]; // snaps to 1.0 as well
    assert_eq!(
        reconciled(&[same_cell], &host),
        [same_cell],
        "already the host vertex to the kernel: nothing to move"
    );
}

#[test]
fn a_cutter_vertex_that_is_a_host_vertex_stays_on_it() {
    // Two host vertices a step apart (a creased face), the cutter on one.
    let host = [[1.0, 2.0, 3.0], [1.0 + g(1), 2.0, 3.0]];
    assert_eq!(reconciled(&[host[0]], &host), [host[0]]);
    assert_eq!(reconciled(&[host[1]], &host), [host[1]]);
}

#[test]
fn the_nearest_host_vertex_wins_whatever_the_host_order() {
    // One axis off beats two axes off; an exact tie goes to the smaller
    // position. Neither may depend on which host vertex comes first.
    let cutter = [[1.0, 2.0, 3.0]];
    let axis = [1.0 + g(1), 2.0, 3.0];
    let diagonal = [1.0 - g(1), 2.0 - g(1), 3.0];
    assert_eq!(reconciled(&cutter, &[axis, diagonal]), [axis]);
    assert_eq!(reconciled(&cutter, &[diagonal, axis]), [axis]);
    let (below, above) = ([1.0 - g(1), 2.0, 3.0], [1.0 + g(1), 2.0, 3.0]);
    assert_eq!(reconciled(&cutter, &[below, above]), [below]);
    assert_eq!(reconciled(&cutter, &[above, below]), [below]);
    // A tie across two axes: the smaller POSITION is the one lower in x,
    // though a search that walks y first would meet the other one first.
    let (low_x, low_y) = ([1.0 - g(1), 2.0, 3.0], [1.0, 2.0 - g(1), 3.0]);
    assert_eq!(reconciled(&cutter, &[low_x, low_y]), [low_x]);
    assert_eq!(reconciled(&cutter, &[low_y, low_x]), [low_x]);
}

#[test]
fn a_host_vertex_two_cutter_positions_reach_is_given_to_neither() {
    let host = [[1.0, 2.0, 3.0]];
    // Two cutter vertices on either side of it: moving both would collapse
    // the cutter edge between them.
    let (left, right) = ([1.0 - g(1), 2.0, 3.0], [1.0 + g(1), 2.0, 3.0]);
    assert_eq!(reconciled(&[left, right], &host), [left, right]);
    // One already on it, one a step away: the same collapse.
    assert_eq!(reconciled(&[host[0], right], &host), [host[0], right]);
    // Copies of ONE cutter position are one claim, and all of them move.
    assert_eq!(reconciled(&[right, right], &host), [host[0], host[0]]);
}

/// A cutter the grid cannot index is returned as it came. A host vertex it
/// cannot index is simply no candidate; the host's other vertices still are.
#[test]
fn a_coordinate_the_grid_cannot_index_is_never_keyed() {
    let host = [[1.0, 2.0, 3.0]];
    let near = [1.0 + g(1), 2.0, 3.0];
    for bad in [f32::NAN, f32::INFINITY, 4.0e9] {
        let got = reconciled(&[near, [bad, 0.0, 0.0]], &host);
        assert_eq!(got[0], near, "cutter carrying {bad}");
        let got = reconciled(&[near], &[[bad, 2.0, 3.0], host[0], [1.0, bad, 3.0]]);
        assert_eq!(got, host, "host carrying {bad}");
    }
    // A depth axis that is not a direction: no depth edge could be found, so
    // nothing is moved at all.
    for bad in [f64::NAN, f64::INFINITY] {
        let got = reconcile_with_host_vertices(
            points(&[near]),
            &points(&host),
            Vector3::new(0.0, bad, 1.0),
        );
        assert_eq!(got.positions, near, "depth axis carrying {bad}");
    }
}

/// A cutter of real triangles, for the rules that read its edges.
fn triangles(p: &[[f32; 3]], indices: &[u32]) -> Mesh {
    let mut m = points(p);
    m.indices = indices.to_vec();
    m
}

fn reconciled_mesh(cutter: &Mesh, host: &[[f32; 3]]) -> Vec<[f32; 3]> {
    reconcile_with_host_vertices(cutter.clone(), &points(host), Vector3::z())
        .positions
        .chunks_exact(3)
        .map(|p| [p[0], p[1], p[2]])
        .collect()
}

/// One triangle with an edge `a`-`b` along the depth axis (z) and a third
/// vertex well away from any host vertex.
fn depth_edge() -> ([f32; 3], [f32; 3], Mesh) {
    let (a, b) = ([1.0, 2.0, 0.0], [1.0, 2.0, 0.25]);
    (a, b, triangles(&[a, b, [3.0, 2.0, 0.0]], &[0, 1, 2]))
}

fn shifted(p: [f32; 3], dx: i32, dy: i32) -> [f32; 3] {
    [p[0] + g(dx), p[1] + g(dy), p[2]]
}

#[test]
fn a_depth_edge_moves_when_both_ends_take_the_same_offset() {
    let (a, b, cutter) = depth_edge();
    let host = [shifted(a, 1, 0), shifted(b, 1, 0)];
    let got = reconciled_mesh(&cutter, &host);
    assert_eq!([got[0], got[1]], host);
}

/// The creased-arris case: the host's arris leans by a step between the two
/// faces of the wall, so the cutter's edge agrees with it at one end only.
#[test]
fn a_depth_edge_with_one_end_already_on_the_host_is_not_tilted_onto_it() {
    let (a, b, cutter) = depth_edge();
    let got = reconciled_mesh(&cutter, &[a, shifted(b, 0, 1)]);
    assert_eq!([got[0], got[1]], [a, b]);
}

#[test]
fn a_depth_edge_whose_ends_would_take_different_offsets_stays() {
    let (a, b, cutter) = depth_edge();
    let got = reconciled_mesh(&cutter, &[shifted(a, 1, 0), shifted(b, 0, 1)]);
    assert_eq!([got[0], got[1]], [a, b]);
}

/// The opening pokes out of the host: its far ring has no host vertex.
#[test]
fn a_depth_edge_with_no_host_vertex_at_one_end_stays() {
    let (a, b, cutter) = depth_edge();
    let got = reconciled_mesh(&cutter, &[shifted(a, 1, 0)]);
    assert_eq!([got[0], got[1]], [a, b]);
}

/// Two depth edges end to end. The far pair disagrees, which holds the
/// middle vertex, which in turn must hold the near one.
#[test]
fn a_held_vertex_holds_the_rest_of_its_depth_edge_chain() {
    let (a, b, c) = ([1.0, 2.0, 0.0], [1.0, 2.0, 0.25], [1.0, 2.0, 0.5]);
    let away = [3.0, 2.0, 0.0];
    let cutter = triangles(&[a, b, c, away], &[0, 1, 3, 1, 2, 3]);
    let host = [shifted(a, 1, 0), shifted(b, 1, 0), shifted(c, 0, 1)];
    assert_eq!(reconciled_mesh(&cutter, &host)[..3], [a, b, c]);
    // With the far end agreeing too, the whole chain moves.
    let host = [shifted(a, 1, 0), shifted(b, 1, 0), shifted(c, 1, 0)];
    assert_eq!(reconciled_mesh(&cutter, &host)[..3], host);
}

/// The rule is about depth edges only. Along a footprint edge the two ends
/// are different corners and move independently: that is the reconcile.
#[test]
fn an_edge_across_the_depth_axis_does_not_tie_its_ends() {
    let (a, b) = ([1.0, 2.0, 0.0], [2.0, 2.0, 0.0]);
    let cutter = triangles(&[a, b, [1.5, 3.0, 0.0]], &[0, 1, 2]);
    let host = [shifted(a, 1, 0), b];
    assert_eq!(reconciled_mesh(&cutter, &host)[..2], host);
}

/// Edges not used exactly once in each direction, on a 1 mm position snap,
/// collapsed triangles skipped: 0 iff the mesh closes consistently wound.
fn open_edges(m: &Mesh) -> usize {
    let q = |i: u32| {
        let p = &m.positions[i as usize * 3..i as usize * 3 + 3];
        [0, 1, 2].map(|k| (p[k] as f64 * 1.0e3).round() as i64)
    };
    let mut uses: HashMap<([i64; 3], [i64; 3]), (u32, u32)> = HashMap::new();
    for t in m.indices.chunks_exact(3) {
        let v = [q(t[0]), q(t[1]), q(t[2])];
        if v[0] == v[1] || v[1] == v[2] || v[2] == v[0] {
            continue;
        }
        for k in 0..3 {
            let (a, b) = (v[k], v[(k + 1) % 3]);
            let e = uses.entry((a.min(b), a.max(b))).or_insert((0, 0));
            if a < b {
                e.0 += 1;
            } else {
                e.1 += 1;
            }
        }
    }
    uses.values().filter(|&&(f, r)| f != 1 || r != 1).count()
}

/// A closed prism over a convex counter-clockwise footprint.
fn prism(c: &[[f32; 2]; 4], z0: f32, z1: f32) -> Mesh {
    let p = |a: [f32; 2], z: f32| [a[0], a[1], z];
    let mut tris = vec![
        [p(c[0], z1), p(c[1], z1), p(c[2], z1)],
        [p(c[0], z1), p(c[2], z1), p(c[3], z1)],
        [p(c[0], z0), p(c[2], z0), p(c[1], z0)],
        [p(c[0], z0), p(c[3], z0), p(c[2], z0)],
    ];
    for k in 0..4 {
        let n = (k + 1) % 4;
        tris.push([p(c[k], z0), p(c[n], z0), p(c[n], z1)]);
        tris.push([p(c[k], z0), p(c[n], z1), p(c[k], z1)]);
    }
    let mut m = Mesh::new();
    for t in &tris {
        let b = (m.positions.len() / 3) as u32;
        for v in t {
            m.positions.extend_from_slice(v);
            m.normals.extend_from_slice(&[0.0, 0.0, 1.0]);
        }
        m.indices.extend_from_slice(&[b, b + 1, b + 2]);
    }
    m
}

const DEPTH: f32 = 0.25;

/// The four corners of a 1.2 x 0.8 hole turned about 17 degrees in plan, each
/// on the grid. Turned, so that a corner moved along an axis leaves BOTH
/// walls that meet there; axis-aligned walls would each keep one.
fn hole() -> [[f64; 2]; 4] {
    let (c, s) = (0.954_770_9_f64, 0.297_342_5_f64);
    let on_grid = |v: f64| (v / SNAP_GRID).round() * SNAP_GRID;
    [[-0.6, -0.4], [0.6, -0.4], [0.6, 0.4], [-0.6, 0.4]]
        .map(|[x, y]| [on_grid(4.0 + c * x - s * y), on_grid(4.0 + s * x + c * y)])
}

/// An 8 x 8 slab, `DEPTH` thick, whose profile carries that hole.
fn slab() -> Mesh {
    let pt = |p: [f64; 2]| Point2::new(p[0], p[1]);
    let mut profile = Profile2D::new(
        [[0.0, 0.0], [8.0, 0.0], [8.0, 8.0], [0.0, 8.0]]
            .map(pt)
            .to_vec(),
    );
    profile.add_hole(hole().iter().rev().map(|p| pt(*p)).collect()); // holes run clockwise
    extrude_profile(&profile, DEPTH as f64, None).expect("the slab extrudes")
}

/// The opening that fills the hole, footprint and depth, with one corner
/// `(dx, dy)` grid steps from the hole's.
fn opening(corner: usize, dx: i32, dy: i32) -> OpeningType {
    let mut c = hole().map(|p| [p[0] as f32, p[1] as f32]);
    c[corner][0] += g(dx);
    c[corner][1] += g(dy);
    let mesh = prism(&c, 0.0, DEPTH);
    let (mn, mx) = mesh.bounds();
    OpeningType::NonRectangular(
        mesh,
        Point3::new(mn.x as f64, mn.y as f64, mn.z as f64),
        Point3::new(mx.x as f64, mx.y as f64, mx.z as f64),
        Some(Vector3::new(0.0, 0.0, 1.0)),
    )
}

fn cut(host: Mesh, opening: OpeningType) -> Mesh {
    let context = VoidContext {
        merged_openings: vec![opening.clone()],
        openings: vec![opening],
        param: None,
        bool2d: None,
    };
    let bounds = world_host_bounds(&host);
    GeometryRouter::new().apply_void_context_inner(host, &context, 6940, bounds, false)
}

/// The tear: the opening fills a hole the slab's profile already has, and one
/// of its corners reached the cut one grid step from the hole's. It removes
/// nothing, so the slab must come back closed and whole. Measured with the
/// reconcile switched off: 27 of these 32 offsets tear the slab (3 to 8 open
/// edges), and the agreeing opening does not.
#[test]
fn issue_6940_an_opening_one_step_off_a_hole_corner_leaves_the_slab_closed() {
    let host = slab();
    assert_eq!(open_edges(&host), 0, "the slab arrives closed");
    let volume = mesh_volume(&host);
    let offsets = [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
        [1, 1],
        [1, -1],
        [-1, 1],
        [-1, -1],
    ];
    for corner in 0..4 {
        for [dx, dy] in std::iter::once([0, 0]).chain(offsets) {
            let result = cut(host.clone(), opening(corner, dx, dy));
            assert_eq!(
                open_edges(&result),
                0,
                "corner {corner} moved ({dx}, {dy}) steps: the slab came back torn ({} triangles)",
                result.triangle_count()
            );
            let moved = (mesh_volume(&result) - volume).abs();
            assert!(
                moved < 1.0e-6,
                "corner {corner} moved ({dx}, {dy}) steps: the opening fills a hole, yet the \
                 volume moved by {moved} m^3"
            );
        }
    }
}
