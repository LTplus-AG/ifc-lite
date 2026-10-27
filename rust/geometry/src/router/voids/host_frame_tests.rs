// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Abutting openings on a plan-rotated wall far from the origin, cut through
//! the real cutter placement and the void stage.
//!
//! Two openings that abut in the file express their shared plane through
//! different numbers: one profile sits 58 m from its item origin, the other at
//! 0, so the item tessellation leaves them about 1 um apart, and the f32 world
//! cast at 230 m (15 um steps) rounds each cutter's seam corners on its own.
//! Whatever path the pair takes, the cut must leave no face on the seam plane
//! and stay watertight.
//!
//! These are PINS, not regression tests for #8156, and the `kernel::abutting`
//! prepass is not on this route at all: `merge_abutting_components` is called
//! zero times on every fixture here, measured with a probe at its entry, so
//! nothing it welds or declines decides these seams. The route is the prism cut and the coaxial union, and where the
//! seam comes out clean that is what closed it; every case passes with the
//! prepass stubbed out.
//! What they hold still is the far-field placement path: a plan-rotated wall at
//! 230 m, 1.5 km and 10 km, where one absolute f32 step is 15 um, 122 um and
//! 977 um. The tests that do observe the prepass are
//! `kernel::abutting::tests::subtract_many_cuts_abutting_cutters_without_a_sheet`,
//! `kernel::abutting::tests::the_one_cell_rule_declines_an_f32_step_in_the_far_field`
//! (the one-cell threshold itself, on axis-aligned operands) and
//! `coaxial_union::tests::abutting_boxes_a_snap_cell_apart_cut_as_one_void`;
//! the end-to-end evidence is the corpus row in the PR.

use super::super::*;
use crate::program::openings::ready::ProbePlacement;
use crate::program::openings::requests::{OpeningReady, OpeningReply};
use crate::router::processing::SourceHygiene;
use crate::router::GeometryRouter;
use nalgebra::{Matrix4, Point2, Point3, Vector3};

/// Along-wall position of the shared plane in the wall's own frame.
const SEAM: f64 = 0.8;
/// Wall thickness, shared by the host profile, the removed volume and the
/// tolerance below.
const WALL_THICKNESS: f64 = 0.3;
/// Where the shared plane sits in the item frame of the school wall's opening
/// #43927 (metres): its f32 item tessellation carries +0.956 um there, while
/// the neighbour reads the same plane as 0 from its own item frame.
const SEAM_IN_ITEM_FRAME: f64 = 58.032_866_475_529;
/// The item offset that puts a cutter's seam at that coordinate.
const PROFILE_OFFSET: f64 = SEAM_IN_ITEM_FRAME - SEAM;
/// Half depth of a cutter across the wall (the wall is 0.3 m thick). The two
/// seam corners of one cutter then differ by a whole number of f32 steps in
/// world x at every position below, so a step boundary between the two
/// cutters' corners moves both corners together.
const CUTTER_HALF_DEPTH: f64 = 205.0 / 1_024.0;
/// Plan rotation of the wall (degrees) and its world positions. At each
/// position the f32 world cast moves the two cutters' seam corners one step
/// apart along the wall (13 um at 230 m, 102 um at 1.5 km, 811 um at 10 km);
/// found by sweeping the position.
const WALL_ROTATION_DEG: f64 = 30.0;
const WALL_AT_230M: [f64; 3] = [200.000_011_825_561_53, 115.0, 12.0];
const WALL_AT_1500M: [f64; 3] = [1_300.000_111_083_984_4, 750.0, 12.0];
const WALL_AT_10KM: [f64; 3] = [8_700.000_538_330_078, 4_900.0, 12.0];

/// `R_z(deg)` then translate to `at`.
fn placement(deg: f64, at: [f64; 3]) -> Matrix4<f64> {
    let (s, c) = deg.to_radians().sin_cos();
    Matrix4::new(
        c, -s, 0.0, at[0], //
        s, c, 0.0, at[1], //
        0.0, 0.0, 1.0, at[2], //
        0.0, 0.0, 0.0, 1.0,
    )
}

/// Place item-local cutters the way the opening program does.
fn place_cutters(router: &GeometryRouter, items: Vec<Mesh>, placement: &Matrix4<f64>) -> Vec<Mesh> {
    let packet = OpeningReady::ProbeParts {
        parts: items,
        placement: ProbePlacement {
            hygiene: SourceHygiene::BooleanOperand,
            placement: *placement,
            frame: router.world_frame(),
            meshes: true,
            direction: None,
            placed: Vec::new(),
            bounds: Vec::new(),
        },
    };
    match packet.execute() {
        OpeningReply::ProbeParts(probe) => probe.placed,
        _ => panic!("probe parts reply"),
    }
}

/// A box opening in the wall's frame: `[x0, x1]` along the wall, `[z0, z1]` up,
/// through the thickness. `item_offset` is where the profile sits in the
/// cutter's own item frame; the item placement brings it back.
struct Opening {
    x: [f64; 2],
    z: [f64; 2],
    item_offset: f64,
}

impl Opening {
    /// The placed, classified cutter.
    fn classify(&self, router: &GeometryRouter, wall: &Matrix4<f64>) -> OpeningType {
        let item = GeometryRouter::make_box_mesh(
            Point3::new(self.x[0] + self.item_offset, -CUTTER_HALF_DEPTH, self.z[0]),
            Point3::new(self.x[1] + self.item_offset, CUTTER_HALF_DEPTH, self.z[1]),
        );
        let item_placement =
            wall * Matrix4::new_translation(&Vector3::new(-self.item_offset, 0.0, 0.0));
        let mut placed = place_cutters(router, vec![item], &item_placement);
        assert_eq!(placed.len(), 1);
        let mesh = placed.remove(0);
        let depth = wall.transform_vector(&Vector3::new(0.0, 1.0, 0.0));
        let frame = infer_opening_frame(&mesh, Some(&depth)).expect("a box has a frame");
        assert!(!frame.is_axis_aligned(), "the wall is plan-rotated");
        OpeningType::DiagonalRectangular(mesh, frame)
    }

    fn volume(&self) -> f64 {
        (self.x[1] - self.x[0]) * WALL_THICKNESS * (self.z[1] - self.z[0])
    }
}

/// An 8 m x 0.3 m x 3 m wall with one end cut at an angle, placed by `wall`,
/// as the native path stores it: absolute f32 positions, origin 0. The angled
/// end keeps it off the analytic box-host cut, on the exact kernel path the
/// school wall takes.
fn host(router: &GeometryRouter, wall: &Matrix4<f64>) -> Mesh {
    let half = WALL_THICKNESS / 2.0;
    let plan = crate::profile::Profile2D::new(vec![
        Point2::new(-4.0, -half),
        Point2::new(4.0, -half),
        Point2::new(3.8, half),
        Point2::new(-4.0, half),
    ]);
    let mut host = crate::extrusion::extrude_profile_watertight(&plan, 3.0, None).unwrap();
    router.transform_mesh_world(&mut host, wall);
    assert_eq!(
        host.origin, [0.0; 3],
        "the native path stores the host absolute"
    );
    host
}

fn volume(mesh: &Mesh) -> f64 {
    mesh_signed_volume(mesh).abs()
}

/// Triangles on the seam plane within the stretch both openings share: normal
/// along the wall, centroid within 1 mm of the seam and more than 1 mm inside
/// `z` (the shared height range). A clean cut has none; the sliver of host
/// left between two prisms shows as two or more.
///
/// `z` is in the WALL's frame and the mesh is in world coordinates, so the
/// centroid is taken back through the placement before the height test. Reading
/// a world z against a wall-frame range made this gate vacuous for every
/// fixture here, since they all sit at z = 12: a deliberate 1 mm pier still
/// counted 0.
fn seam_faces(mesh: &Mesh, wall: &Matrix4<f64>, z: [f64; 2]) -> usize {
    let run = wall.transform_vector(&Vector3::new(1.0, 0.0, 0.0));
    let seam_world = wall.transform_point(&Point3::new(SEAM, 0.0, 0.0));
    let to_wall = wall
        .try_inverse()
        .expect("a rigid placement is invertible");
    let at = |i: u32| {
        let b = i as usize * 3;
        Point3::new(
            mesh.positions[b] as f64 + mesh.origin[0],
            mesh.positions[b + 1] as f64 + mesh.origin[1],
            mesh.positions[b + 2] as f64 + mesh.origin[2],
        )
    };
    mesh.indices
        .chunks_exact(3)
        .filter(|t| {
            let (a, b, c) = (at(t[0]), at(t[1]), at(t[2]));
            let Some(n) = (b - a).cross(&(c - a)).try_normalize(1e-12) else {
                return false;
            };
            let centroid = Point3::from((a.coords + b.coords + c.coords) / 3.0);
            let local_z = to_wall.transform_point(&centroid).z;
            n.dot(&run).abs() > 0.99
                && ((centroid - seam_world).dot(&run)).abs() < 1e-3
                && local_z > z[0] + 1e-3
                && local_z < z[1] - 1e-3
        })
        .count()
}

/// The height range both openings share.
fn shared_height(openings: &[Opening]) -> [f64; 2] {
    let lo = openings
        .iter()
        .map(|o| o.z[0])
        .fold(f64::NEG_INFINITY, f64::max);
    let hi = openings
        .iter()
        .map(|o| o.z[1])
        .fold(f64::INFINITY, f64::min);
    [lo, hi]
}

/// Cut `openings` out of the wall placed by `wall`, assert the two things every
/// cut owes (watertight, the authored volume removed) and RETURN the number of
/// faces left on the seam plane. `at` names the position in every failure,
/// since the far cases differ only by it.
fn cut_and_count_seam(wall: &Matrix4<f64>, openings: &[Opening], at: &str) -> usize {
    let router = GeometryRouter::with_scale_and_local_frame(1.0, false);
    let host = host(&router, wall);
    let host_volume = volume(&host);
    let classified: Vec<OpeningType> = openings.iter().map(|o| o.classify(&router, wall)).collect();
    let ctx = VoidContext {
        merged_openings: GeometryRouter::merge_rectangular_openings(&classified),
        openings: classified,
        param: None,
        bool2d: None,
    };
    let result = router.apply_void_context(host, &ctx, 1);
    let seam = seam_faces(&result, wall, shared_height(openings));
    assert!(
        crate::exact_topology::strict_closed_mesh(&result),
        "{at}: cut is not watertight"
    );
    let removed = host_volume - volume(&result);
    let expected: f64 = openings.iter().map(Opening::volume).sum();
    // The host is absolute f32: its thickness carries one world step of
    // rounding (1 mm at 10 km), the cutters' heights another.
    let step = f64::from(f32::EPSILON) * wall[(0, 3)].abs().max(wall[(1, 3)].abs());
    let tolerance = expected * (1e-3 + 8.0 * step / WALL_THICKNESS);
    assert!(
        (removed - expected).abs() <= tolerance,
        "{at}: removed {removed} m3, expected {expected} m3"
    );
    seam
}

/// The same, for a position where the seam must come out clean.
fn assert_clean_cut(wall: &Matrix4<f64>, openings: &[Opening], at: &str) {
    assert_eq!(
        cut_and_count_seam(wall, openings, at),
        0,
        "{at}: faces left on the seam plane"
    );
}

/// The abutting pair: one opening up to the seam from its own item frame, one
/// from the seam on, read through a profile 58 m out.
fn abutting_pair() -> Vec<Opening> {
    vec![
        Opening { x: [-0.4, SEAM], z: [0.9, 2.1], item_offset: 0.0 },
        Opening { x: [SEAM, 2.0], z: [0.9, 2.1], item_offset: PROFILE_OFFSET },
    ]
}

/// The school wall's seam shape: a profile 58 m from its item origin abutting
/// one at 0, on a plan-rotated wall at 230 m, where one absolute f32 step along
/// the wall is 13 um.
#[test]
fn abutting_openings_on_a_rotated_wall_at_230m_cut_without_a_sheet() {
    assert_clean_cut(
        &placement(WALL_ROTATION_DEG, WALL_AT_230M),
        &abutting_pair(),
        "230 m",
    );
}

/// The same seam 1.5 km from the origin, where an absolute f32 step along the
/// wall is 102 um: the host itself is coarse there, the cutters are not.
#[test]
fn abutting_openings_at_1500m_cut_without_a_sheet() {
    assert_clean_cut(
        &placement(WALL_ROTATION_DEG, WALL_AT_1500M),
        &abutting_pair(),
        "1.5 km",
    );
}

/// The far end of the placement path: one absolute f32 step at 10 km is 811 um
/// along the wall, about 53 lattice cells, so the two cutters' seam corners
/// land that far apart and the strip of host between them stands.
///
/// This pins the placement, NOT the one-cell threshold. The prepass declines
/// nothing here because it is never reached: `merge_abutting_components` is
/// called zero times on this fixture. It could not weld this seam anyway, since
/// the wall is rotated in plan and the plane census takes a face only when its
/// three vertices share a coordinate. The threshold itself is measured on
/// axis-aligned operands in
/// `kernel::abutting::tests::the_one_cell_rule_declines_an_f32_step_in_the_far_field`.
///
/// The cut is still watertight and still removes the authored volume — the
/// sliver is a closed shell inside the opening, which is exactly why #8156 was
/// invisible to every topology check. If a later change closes this, the
/// assertion below turns red: update the pin, do not widen it.
#[test]
fn the_seam_still_stands_10km_out() {
    let seam = cut_and_count_seam(
        &placement(WALL_ROTATION_DEG, WALL_AT_10KM),
        &abutting_pair(),
        "10 km",
    );
    assert!(
        seam > 0,
        "the far-field seam is now clean at 10 km; the one-cell rule was not \
         supposed to reach here, so find out what closed it and re-pin this"
    );
}

/// A 0.3 m vent next to 2.4 m of glazing, abutting on the same plane: the
/// short cutter's seam corners round apart from the tall cutter's the same way.
#[test]
fn a_short_opening_abutting_a_tall_one_cuts_without_a_sheet() {
    assert_clean_cut(
        &placement(WALL_ROTATION_DEG, WALL_AT_230M),
        &[
            Opening { x: [-0.4, SEAM], z: [0.3, 2.7], item_offset: 0.0 },
            Opening { x: [SEAM, 1.4], z: [1.8, 2.1], item_offset: PROFILE_OFFSET },
        ],
        "230 m, short against tall",
    );
}

/// The school wall's own seam pattern: a third opening overlaps the left one
/// by 6 um (so the analytic prism cut refuses the pair and the cluster reaches
/// the exact kernel's coaxial union), while the right one abuts 1 um away.
#[test]
fn three_openings_with_an_overlap_and_an_abutment_cut_without_a_sheet() {
    let mut openings = vec![Opening {
        x: [-1.6, -0.4 + 6.4e-6],
        z: [0.9, 2.1],
        item_offset: 0.0,
    }];
    openings.extend(abutting_pair());
    assert_clean_cut(
        &placement(WALL_ROTATION_DEG, WALL_AT_230M),
        &openings,
        "230 m, overlap plus abutment",
    );
}
