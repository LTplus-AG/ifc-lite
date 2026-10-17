// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//! #7292 actual selected RVT01 #26832 ALT first cut, before consolidation.
//! Passive input48 contains60 exactly closed triangles; projected emission51
//! separates an originally paired edge by1.8985um at one endpoint.
//! Exact captured f32 positions/face normals and original triangle order.
use super::*;
use crate::csg::ClippingProcessor;
use crate::Mesh;
use nalgebra::Vector3;

const ALT60_POSITIONS: [[u32; 3]; 32] = [
    [1048777216, 1021411328, 3150217216],
    [1048777216, 3197654016, 3150217216],
    [1048399479, 1021411328, 3150217216],
    [1048240128, 1021411328, 3150217216],
    [3196260864, 3197654016, 3150249984],
    [1048225792, 1021411328, 3150217230],
    [3196260864, 1050170368, 3150249984],
    [1048225792, 1021473134, 3150217230],
    [1048777216, 1050170368, 3150217216],
    [1048777216, 1027776512, 3150217216],
    [1048690373, 1027776512, 3150217216],
    [1048240128, 1027776512, 3150217216],
    [1048225792, 1023649007, 3150217230],
    [1048225792, 1027776512, 3150217230],
    [1048777216, 3197654016, 1002766336],
    [3196260864, 1050170368, 1002733568],
    [3196260864, 3197654016, 1002733568],
    [1048173568, 1050170368, 1002733568],
    [1048777216, 1027776512, 1002766336],
    [1048777216, 1050170368, 1002766336],
    [1048240128, 1027776512, 1002733568],
    [1048690090, 1027776512, 1002758602],
    [1048235200, 1027776512, 1002733568],
    [1048777216, 1021411328, 1002766336],
    [1048400044, 1021411328, 1002740666],
    [1048240128, 1021411328, 1002733568],
    [1048225792, 1021411328, 1002733580],
    [1048225792, 1021473134, 1002733568],
    [1048225792, 1023653040, 1002733568],
    [1048225792, 1027776512, 1002733568],
    [1048399601, 1021411328, 3143565887],
    [1048690306, 1027776512, 3142579067],
];

const ALT60_TRIANGLES: [[usize; 3]; 60] = [
    [0, 1, 2],
    [1, 3, 2],
    [3, 1, 4],
    [3, 4, 5],
    [4, 6, 5],
    [5, 6, 7],
    [6, 8, 9],
    [6, 9, 10],
    [11, 6, 10],
    [7, 6, 12],
    [6, 11, 13],
    [12, 6, 13],
    [14, 15, 16],
    [17, 18, 19],
    [17, 20, 21],
    [18, 17, 21],
    [20, 17, 22],
    [14, 23, 24],
    [25, 14, 24],
    [14, 25, 26],
    [15, 14, 26],
    [15, 26, 27],
    [17, 15, 27],
    [17, 27, 28],
    [17, 28, 29],
    [17, 29, 22],
    [4, 1, 14],
    [4, 14, 16],
    [6, 4, 16],
    [6, 16, 15],
    [17, 19, 8],
    [17, 8, 6],
    [17, 6, 15],
    [3, 25, 30],
    [23, 30, 24],
    [30, 25, 24],
    [23, 0, 2],
    [2, 3, 30],
    [23, 2, 30],
    [20, 11, 31],
    [9, 31, 10],
    [31, 11, 10],
    [9, 18, 21],
    [9, 21, 31],
    [21, 20, 31],
    [8, 19, 18],
    [8, 18, 9],
    [14, 1, 0],
    [14, 0, 23],
    [5, 25, 3],
    [26, 25, 5],
    [11, 29, 13],
    [29, 11, 22],
    [20, 22, 11],
    [7, 27, 5],
    [12, 28, 7],
    [27, 26, 5],
    [28, 27, 7],
    [13, 29, 28],
    [12, 13, 28],
];

const ALT60_NORMALS: [[u32; 3]; 60] = [
    [2147483648, 2147483648, 3212836864],
    [0, 0, 3212836864],
    [939131091, 898065242, 3212836864],
    [939490882, 659190311, 3212836864],
    [939490882, 0, 3212836864],
    [939490882, 587691147, 3212836864],
    [939131091, 0, 3212836864],
    [0, 3095396352, 3212836864],
    [0, 3095396352, 3212836864],
    [939490882, 0, 3212836864],
    [939490882, 2810408375, 3212836864],
    [939490882, 0, 3212836864],
    [3086614739, 0, 1065353216],
    [3131490837, 0, 1065353202],
    [3132476082, 3065553373, 1065353200],
    [3132476082, 3065553373, 1065353200],
    [0, 0, 1065353216],
    [3132476082, 0, 1065353200],
    [3132476082, 2728733227, 1065353200],
    [936913286, 944279085, 1065353216],
    [936913286, 944279085, 1065353216],
    [936913286, 944279085, 1065353216],
    [0, 0, 1065353216],
    [0, 0, 1065353216],
    [0, 0, 1065353216],
    [0, 0, 1065353216],
    [0, 3212836864, 0],
    [0, 3212836864, 0],
    [3212836864, 0, 0],
    [3212836864, 0, 0],
    [2147483648, 1065353216, 0],
    [0, 1065353216, 0],
    [0, 1065353216, 0],
    [0, 1065353216, 0],
    [0, 1065353216, 0],
    [0, 1065353216, 2147483648],
    [0, 1065353216, 0],
    [0, 1065353216, 2147483648],
    [0, 1065353216, 0],
    [0, 3212836864, 0],
    [0, 3212836864, 0],
    [0, 3212836864, 2147483648],
    [0, 3212836864, 0],
    [0, 3212836864, 0],
    [0, 3212836864, 2147483648],
    [1065353216, 0, 2147483648],
    [1065353216, 0, 0],
    [1065353216, 0, 0],
    [1065353216, 2147483648, 0],
    [2828159269, 1065353216, 0],
    [2651639500, 1065353216, 2779169299],
    [2147483648, 3212836864, 0],
    [0, 3212836864, 0],
    [2147483648, 3212836864, 2147483648],
    [1065353216, 713537876, 2147483648],
    [1065353216, 0, 2147483648],
    [1065353216, 537044028, 656851475],
    [1065353216, 0, 0],
    [1065353216, 0, 2147483648],
    [1065353216, 0, 0],
];

fn captured_source(positions: &[[u32; 3]], triangles: &[[usize; 3]], normals: &[[u32; 3]]) -> Mesh {
    let mut mesh = Mesh::new();
    for (triangle, normal) in triangles.iter().zip(normals) {
        let base = mesh.vertex_count() as u32;
        let normal = Vector3::from(normal.map(|v| f64::from(f32::from_bits(v))));
        for &i in triangle {
            let p = positions[i].map(|v| f64::from(f32::from_bits(v)));
            mesh.add_vertex(Point3::from(p), normal);
        }
        mesh.add_triangle(base, base + 1, base + 2);
    }
    mesh
}

#[test]
fn issue_7292_source_lift_preserves_actual_selected_alt_boundary() {
    let raw = captured_source(&ALT60_POSITIONS, &ALT60_TRIANGLES, &ALT60_NORMALS);
    let supported = super::super::supported_cells::find(&super::super::buckets::build(&raw));
    assert!(crate::exact_topology::strict_closed_mesh(&raw), "captured source is exactly closed");
    assert!(super::super::preservation::public_weld_closed(&raw));
    assert!(!super::super::supported_cells::has_uncertified_needle(&raw, &supported));
    let output = ClippingProcessor::consolidate_coplanar(raw);
    assert!(crate::exact_topology::strict_closed_mesh(&output),
        "retained shared source corners must not separate on the plane lift");
    assert!(super::super::preservation::public_weld_closed(&output));
    assert!(!super::super::supported_cells::has_uncertified_needle(&output, &supported));
}

fn projected_patch(depths: &[f64]) -> (Vec<PlanBucket>, Buckets) {
    use super::super::{conform::PlanRegion, plane_merge::PlaneTri};
    let ring = vec![Point2::new(0.,0.), Point2::new(1.,0.), Point2::new(0.,1.)];
    let faces = depths.iter().map(|&z| PlaneTri {
        v: [Point3::new(0.,0.,z), Point3::new(1.,0.,z), Point3::new(0.,1.,z)],
        normal: Vector3::z(), tag: None,
    }).collect();
    let mut buckets = Buckets::new();
    buckets.insert((0,0,1000,0), faces);
    let plan = PlanBucket {
        bid: 0, normal: Vector3::z(), origin: Point3::origin(),
        u_axis: Vector3::x(), v_axis: Vector3::y(), raw: Vec::new(), raw_conformed: None,
        regions: vec![PlanRegion { outer: ring.clone(), holes: Vec::new(),
            outer_conformed: ring, holes_conformed: Vec::new(), changed: false, cached: None }],
    };
    (vec![plan], buckets)
}

#[test]
fn issue_7292_source_lift_refuses_ambiguous_depth_and_excess_displacement() {
    let (plans, buckets) = projected_patch(&[0., 0.00001, 0.]);
    assert!(build(&plans, &buckets).is_none(),
        "repeating the first3Dpoint cannot resolve two depths at one overlay key");
    let (plans, buckets) = projected_patch(&[2. * CONFORM_TOL]);
    assert!(build(&plans, &buckets).is_none(),
        "an exact projected match cannot authorize an arbitrary normal displacement");
}

#[test]
fn issue_7292_source_lift_recovers_direct_and_overlay_corner_coordinates() {
    let (mut plans, mut buckets) = projected_patch(&[0.00001]);
    buckets.values_mut().next().unwrap()[0].v[1].x = 0.7;
    let region = &mut plans[0].regions[0];
    region.outer[1].x = 0.7;
    region.outer_conformed[1].x = 0.7;
    let xy = [[0.,0.], [0.7,0.], [0.,1.]];
    let adapter = FloatPointAdapter::<[f64;2], i32>::with_iter(xy.iter());
    let canonical = adapter.int_to_float(&adapter.float_to_int(&xy[1]));
    assert_ne!(canonical, xy[1], "control: this corner changes on the overlay grid");
    for endpoint in [Point2::new(0.7,0.), Point2::new(canonical[0],canonical[1])] {
        plans[0].regions[0].outer_conformed[1] = endpoint;
        let lifts = build(&plans, &buckets).expect("unique source corner within conform displacement");
        assert_eq!(lifts[0][0][&point_key(&endpoint)], Point3::new(0.7,0.,0.00001),
            "both exact representations restore the original third coordinate");
    }
}
