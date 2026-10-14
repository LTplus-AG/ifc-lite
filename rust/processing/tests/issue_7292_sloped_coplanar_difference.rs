// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! #7292 through the canonical native producer, including model placement,
//! millimetre units and per-mesh origins. The reporter's public generated
//! fixture is shared with the geometry-level reproduction rather than copied.
//! Its stated oracle (IfcOpenShell and web-ifc) leaves only the 25 mm strip.

use ifc_lite_processing::process_geometry;

const FIXTURE: &str = include_str!(
    "../../geometry/tests/fixtures/issue_7292_sloped_coplanar_difference.ifc"
);
const POSITION_TOLERANCE: f64 = 1.0e-4; // 0.1 mm, including f32 and kernel snap

fn covers_bottom_witness(triangle: [[f64; 3]; 3], slope: f64) -> bool {
    if !triangle.iter().all(|vertex| {
        (vertex[2] - (4.548 + slope * vertex[1])).abs() <= POSITION_TOLERANCE
    }) {
        return false;
    }
    let point = [-3.005, 0.004];
    let signed_area = |a: [f64; 3], b: [f64; 3], p: [f64; 2]| {
        (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0])
    };
    let area = signed_area(triangle[0], triangle[1], [triangle[2][0], triangle[2][1]]);
    if !area.is_finite() || area.abs() <= 1.0e-18 {
        return false;
    }
    // Signed sub-areas are barycentric numerators. Allow the same 0.1 mm
    // positional slack perpendicular to each edge, independent of winding.
    (0..3).all(|edge| {
        let a = triangle[edge];
        let b = triangle[(edge + 1) % 3];
        let edge_length = ((b[0] - a[0]).powi(2) + (b[1] - a[1]).powi(2)).sqrt();
        signed_area(a, b, point) * area.signum() >= -POSITION_TOLERANCE * edge_length
    })
}

fn surface_face(triangle: [[f64; 3]; 3], slope: f64, length_y: f64) -> (usize, f64) {
    let edge_a = [0, 1, 2].map(|k| triangle[1][k] - triangle[0][k]);
    let edge_b = [0, 1, 2].map(|k| triangle[2][k] - triangle[0][k]);
    let cross = [
        edge_a[1] * edge_b[2] - edge_a[2] * edge_b[1],
        edge_a[2] * edge_b[0] - edge_a[0] * edge_b[2],
        edge_a[0] * edge_b[1] - edge_a[1] * edge_b[0],
    ];
    let normal_length = (1.0 + slope * slope).sqrt();
    // Each entry is a unit normal and its plane offset. The six analytic
    // faces follow from the 25 mm remainder and the rotated extrusion.
    let faces = [
        ([1.0, 0.0, 0.0], -3.025),
        ([1.0, 0.0, 0.0], -3.000),
        ([0.0, 1.0, 0.0], 0.0),
        ([0.0, 1.0, 0.0], length_y),
        ([0.0, -slope / normal_length, 1.0 / normal_length], 4.548 / normal_length),
        ([0.0, -slope / normal_length, 1.0 / normal_length], 4.602 / normal_length),
    ];
    let dot = |a: [f64; 3], b: [f64; 3]| a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    // Tiny triangles next to an edge can fit two planes within tolerance;
    // their normal selects the face with the greatest projected area.
    let mut best: Option<(usize, f64)> = None;
    for (face, (normal, offset)) in faces.into_iter().enumerate() {
        if triangle.iter().all(|&vertex| (dot(normal, vertex) - offset).abs() <= POSITION_TOLERANCE) {
            let projected_area = dot(normal, cross).abs() * 0.5;
            if best.is_none_or(|(_, area)| projected_area > area) {
                best = Some((face, projected_area));
            }
        }
    }
    best.unwrap_or_else(|| panic!("#7292: triangle {triangle:?} is not on any strip boundary"))
}

fn assert_strip(bytes: &[u8], slope: f64) {
    let result = process_geometry(bytes);
    let (mut minimum, mut maximum) = ([f64::INFINITY; 3], [f64::NEG_INFINITY; 3]);
    let mut referenced_vertices = 0;
    let length_y = 1.1 / (1.0 + slope * slope).sqrt();
    let mut surface_areas = [0.0; 6];
    let mut bottom_witness_covered = false;
    for mesh in result.meshes.iter().filter(|mesh| mesh.express_id == 107) {
        for &index in &mesh.indices {
            let world = [0, 1, 2].map(|k| {
                mesh.positions[index as usize * 3 + k] as f64 + mesh.origin[k]
            });
            for k in 0..3 {
                minimum[k] = minimum[k].min(world[k]);
                maximum[k] = maximum[k].max(world[k]);
            }
            // The extrusion direction becomes vertical after its tilted
            // placement. Every retained vertex must lie between the sloped
            // bottom and the top exactly 54 mm above it.
            let height_above_bottom = world[2] - (4.548 + slope * world[1]);
            assert!(
                (-1.0e-4..=0.054 + 1.0e-4).contains(&height_above_bottom),
                "#7292: vertex {world:?} lies outside the 54 mm sloped layer"
            );
            referenced_vertices += 1;
        }
        assert_eq!(mesh.indices.len() % 3, 0, "triangle index buffer");
        for indices in mesh.indices.chunks_exact(3) {
            let triangle = [0, 1, 2].map(|vertex| [0, 1, 2].map(|axis| {
                mesh.positions[indices[vertex] as usize * 3 + axis] as f64 + mesh.origin[axis]
            }));
            let (face, area) = surface_face(triangle, slope, length_y);
            surface_areas[face] += area;
            bottom_witness_covered |= covers_bottom_witness(triangle, slope);
        }
    }
    assert!(referenced_vertices > 0, "the 25 mm strip must remain");
    // #7292: correct bounds and summed face areas hid a triangular bottom
    // gap. This point lies strictly inside the retained strip's bottom face.
    assert!(bottom_witness_covered,
        "#7292: bottom surface must cover IFC world point x=-3.005, y=0.004, z={}",
        4.548 + slope * 0.004);
    // 0.1 mm covers f32 storage and the kernel snap. Unreferenced vertices
    // do not contribute: the issue specifically reports indexed world bounds.
    // Sloped bounds agree with the independent IfcOpenShell replay. The
    // flat control follows directly from its unchanged 1100 mm footprint.
    let expected_lo = [-3.025, 0.0, 4.548];
    let expected_hi = [-3.000, length_y, 4.602 + slope * length_y];
    for k in 0..3 {
        assert!(
            (minimum[k] - expected_lo[k]).abs() < 1.0e-4
                && (maximum[k] - expected_hi[k]).abs() < 1.0e-4,
            "#7292: axis {k} bounds [{}, {}], expected [{}, {}]",
            minimum[k], maximum[k], expected_lo[k], expected_hi[k]
        );
    }
    // Sum projected triangle area on each boundary independently of its
    // triangulation. Side x faces are y-z parallelograms; side y faces are
    // 25 x 54 mm rectangles; the tilted caps are 25 x 1100 mm rectangles.
    // Area tolerance comes from a 0.1 mm boundary displacement times each
    // face perimeter, plus a one-part-per-million summation allowance.
    let expected_areas = [0.054 * length_y, 0.054 * length_y,
        0.025 * 0.054, 0.025 * 0.054, 0.025 * 1.1, 0.025 * 1.1];
    let perimeters = [2.0 * (1.1 + 0.054), 2.0 * (1.1 + 0.054),
        2.0 * (0.025 + 0.054), 2.0 * (0.025 + 0.054),
        2.0 * (0.025 + 1.1), 2.0 * (0.025 + 1.1)];
    for face in 0..6 {
        let tolerance = perimeters[face] * POSITION_TOLERANCE + expected_areas[face] * 1.0e-6;
        assert!(
            (surface_areas[face] - expected_areas[face]).abs() <= tolerance,
            "#7292: face {face} area {} m², expected {} m² ± {tolerance}",
            surface_areas[face], expected_areas[face]
        );
    }
}

#[test]
fn issue_7292_shared_producer_leaves_only_the_25mm_strip() {
    assert_strip(FIXTURE.as_bytes(), 0.02);
}

/// Change only the reporter's operand slope: A's placement/extrusion axes
/// and B's cap heights. Footprints, layer depths and model placement stay
/// fixed. The 2% regression above always uses the original fixture verbatim.
fn fixture_at_slope(slope: f64) -> String {
    let normal_length = (1.0 + slope * slope).sqrt();
    let axis_y = slope / normal_length;
    let axis_z = 1.0 / normal_length;
    let mut fixture = String::new();
    for line in FIXTURE.lines() {
        let entity_id = line.split_once('=').and_then(|(id, _)| {
            id.strip_prefix('#').and_then(|id| id.parse::<u32>().ok())
        });
        let replacement = match entity_id {
            Some(37) => format!("#37=IFCDIRECTION((0.000000000000000,{:.15},{axis_z:.15}));", -axis_y),
            Some(41) => format!("#41=IFCDIRECTION((0.000000000000000,{axis_y:.15},{axis_z:.15}));"),
            Some(id @ 43..=62) => {
                let (_, coordinates) = line.split_once("((").expect("committed prism point");
                let coordinates = coordinates.strip_suffix("));").expect("point terminator");
                let coordinates: Vec<f64> = coordinates.split(',')
                    .map(|value| value.parse().expect("numeric prism point coordinate")).collect();
                assert_eq!(coordinates.len(), 3, "prism point has three coordinates");
                let base_z = if (id - 43) % 2 == 0 { 48.0 } else { 128.9 };
                let z = base_z + slope * coordinates[1];
                format!("#{id}=IFCCARTESIANPOINT(({:.4},{:.4},{z:.4}));", coordinates[0], coordinates[1])
            }
            _ => line.to_owned(),
        };
        fixture.push_str(&replacement);
        fixture.push('\n');
    }
    fixture
}

#[test]
fn issue_7292_flat_difference_positive_control_leaves_the_strip() {
    let flat = fixture_at_slope(0.0);
    assert_strip(flat.as_bytes(), 0.0);
}

#[test]
fn issue_7292_five_percent_difference_preserves_the_complete_strip() {
    // The reporter's 5% variation had correct bounds but extra triangles.
    // Assert six-face coverage without pinning a particular triangulation.
    let sloped = fixture_at_slope(0.05);
    assert_strip(sloped.as_bytes(), 0.05);
}
