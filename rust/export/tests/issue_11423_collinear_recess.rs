// SPDX-License-Identifier: MPL-2.0
#[allow(dead_code)]
#[path = "../../geometry/tests/voids_common/split_wall.rs"]
mod split_wall;

use ifc_lite_export::{export_obj, ObjOptions};
use split_wall::{polyline_recess, wall_with_finish, Recess};

/// Signed tetrahedra from the wall's serialized OBJ vertices and face indices.
fn exported_volume(content: &str) -> f64 {
    let options = ObjOptions { isolated: Some(vec![100]), include_normals: false, ..Default::default() };
    let obj = export_obj(content.as_bytes(), &options).unwrap();
    let mut vertices = Vec::<[f64; 3]>::new();
    let mut volume = 0.0;
    for line in obj.lines() {
        if let Some(coords) = line.strip_prefix("v ") {
            let mut coords = coords.split_whitespace();
            vertices.push(std::array::from_fn(|_| coords.next().unwrap().parse().unwrap()));
        } else if let Some(face) = line.strip_prefix("f ") {
            let mut face = face.split_whitespace();
            let [a, b, c] = std::array::from_fn(|_| vertices[face.next().unwrap().parse::<usize>().unwrap() - 1]);
            for (i, component) in a.into_iter().enumerate() {
                let (j, k) = ((i + 1) % 3, (i + 2) % 3);
                volume += component * (b[j] * c[k] - b[k] * c[j]);
            }
        }
    }
    volume.abs() / 6.0
}

#[test]
fn collinear_recess_preserves_exported_wall_volume() {
    for turn in [0.0, 0.5, 90.0] {
        for (length, expected) in [(1.0, 2.436), (4.0, 2.532)] {
            let wall = wall_with_finish([0.0; 2], turn, 2.274, Recess::FromInterface, length);
            let [four, five] = [false, true].map(|mid| exported_volume(&polyline_recess(&wall, mid)));
            assert!((four - expected).abs() < 0.0006 && (five - expected).abs() < 0.0006,
                "{turn}° finish {length} m: expected {expected} m³, exported {four} and {five}");
            // OBJ stores six decimals per vertex. Allow 0.01 L between tessellations.
            assert!((four - five).abs() < 0.00001, "{turn}° finish {length} m: {four} vs {five} m³");
        }
    }
}
