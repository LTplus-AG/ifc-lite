// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! #11444: an `IfcSweptDiskSolid` rebar (radius 6 mm, IFC4X3, millimetres)
//! along a faceted `IfcIndexedPolyCurve` drew in the viewer with crumpled
//! bends and a non-round section. The fixture is the issue's reproducer: a
//! U-bar whose 36-point directrix approximates each 90° bend with 16 segments
//! of about 2.2 mm, with an inclined middle leg. `#60` uses the solid directly
//! (placed at y = 300 mm), `#70` through an `IfcMappedItem`.
//!
//! The kernel's tube is round; the defect was the renderer's ~1 mm vertex
//! lattice (see `packages/renderer/src/quantize-tilt-11444.test.ts` and
//! `a_thin_swept_rebar_moves_to_a_finer_lattice_11444` in the wasm encoder).
//! This pins the kernel side the maintainer asked for: finite geometry and a
//! round section on the straight legs, for both bars.

use ifc_lite_core::EntityDecoder;
use ifc_lite_geometry::{GeometryRouter, Mesh, Point3, Vector3};

const FIXTURE: &str = include_str!("fixtures/issue_11444_swept_disk_faceted_bends.ifc");
const RADIUS_M: f64 = 0.006;

fn mesh_element(id: u32) -> Mesh {
    let entity_index = ifc_lite_core::build_entity_index(FIXTURE);
    let mut decoder = EntityDecoder::with_index(FIXTURE, entity_index);
    let router = GeometryRouter::with_units(FIXTURE, &mut decoder);
    let element = decoder.decode_by_id(id).unwrap_or_else(|e| panic!("decode #{id}: {e}"));
    let mesh = router
        .process_element(&element, &mut decoder)
        .unwrap_or_else(|e| panic!("process #{id}: {e}"));
    assert!(mesh.triangle_count() > 0, "#{id} meshed to nothing");
    mesh
}

/// The directrix in metres, read back from the fixture's point list.
fn directrix_m() -> Vec<Point3<f64>> {
    let list = FIXTURE.split("IFCCARTESIANPOINTLIST3D((").nth(1).expect("point list");
    let list = &list[..list.find("),$)").expect("point list end")];
    list.split("),")
        .map(|p| {
            let c: Vec<f64> = p
                .trim_matches(|c: char| c == '(' || c == ')' || c.is_whitespace())
                .split(',')
                .map(|v| v.parse::<f64>().expect("coordinate"))
                .collect();
            Point3::new(c[0], c[1], c[2]) / 1000.0
        })
        .collect()
}

/// Distance from `p` to the segment `a`-`b`.
fn segment_distance(p: Point3<f64>, a: Point3<f64>, b: Point3<f64>) -> f64 {
    let ab: Vector3<f64> = b - a;
    let t = ((p - a).dot(&ab) / ab.norm_squared()).clamp(0.0, 1.0);
    (p - (a + ab * t)).norm()
}

#[test]
fn both_bars_mesh_finite_with_a_round_section_on_the_straight_legs_11444() {
    let axis = directrix_m();
    assert_eq!(axis.len(), 36);
    // The legs are the segments longer than a bend facet: 0-1, 17-18 (inclined), 34-35.
    let legs: Vec<usize> = (0..axis.len() - 1).filter(|&k| (axis[k + 1] - axis[k]).norm() > 0.05).collect();
    assert_eq!(legs, [0, 17, 34]);

    for (id, offset) in [(60, Vector3::new(0.0, 0.3, 0.0)), (70, Vector3::zeros())] {
        let mesh = mesh_element(id);
        assert!(mesh.positions.iter().all(|v| v.is_finite()), "#{id}: non-finite position");
        assert!(mesh.normals.iter().all(|v| v.is_finite()), "#{id}: non-finite normal");

        let mut on_legs = 0;
        for v in mesh.positions.chunks_exact(3) {
            let p = Point3::new(v[0] as f64, v[1] as f64, v[2] as f64) - offset;
            // The segment this vertex belongs to: its nearest, by distance to the axis.
            let (k, d) = (0..axis.len() - 1)
                .map(|k| (k, segment_distance(p, axis[k], axis[k + 1])))
                .min_by(|a, b| a.1.total_cmp(&b.1))
                .expect("segments");
            // Every vertex of a leg but the two cap centres, which are the directrix's ends. A ring
            // shared with a bend is square to the averaged tangent, tilted half a facet angle (about
            // 2.8°) off the leg, which puts it up to 0.12% further out; anything rougher, inward or
            // outward, is not a round section.
            let cap_centre = [axis[0], axis[axis.len() - 1]].iter().any(|&end| (p - end).norm() < 1e-6);
            if legs.contains(&k) && !cap_centre {
                on_legs += 1;
                assert!((d - RADIUS_M).abs() < 0.01 * RADIUS_M, "#{id}: leg vertex {p:?} sits {d} m off the axis, not {RADIUS_M}");
            }
        }
        // At least the two end rings; a ring at a bend shares its vertices with the first facet.
        assert!(on_legs >= 2 * 24, "#{id}: expected leg rings, found {on_legs} vertices");
    }
}
