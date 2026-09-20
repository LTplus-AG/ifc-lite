// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Fixture regression for #4206: schema-prescribed `IfcFaceSurface` reference
//! topology on `IfcStructuralSurfaceMember` must survive routing, triangulate
//! its hole, and receive the normal placement/unit transforms.

use ifc_lite_processing::process_geometry;

const FIXTURE: &str = "../../tests/models/ifcopenshell/generated_structural_surface_member.ifc";

fn read_fixture() -> Option<String> {
    match std::fs::read_to_string(FIXTURE) {
        Ok(source) => Some(source),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            eprintln!(
                "skipping structural surface-member geometry regression: fixture missing at \
                 {FIXTURE} — run `pnpm fixtures` (sha256 in tests/models/manifest.json)"
            );
            None
        }
        Err(error) => panic!("failed to read fixture {FIXTURE}: {error}"),
    }
}

#[test]
fn structural_surface_member_meshes_face_hole_in_world_metres() {
    let Some(source) = read_fixture() else { return };
    let result = process_geometry(&source);
    assert_eq!(result.metadata.length_unit_scale, Some(0.001));

    let meshes: Vec<_> = result
        .meshes
        .iter()
        .filter(|mesh| mesh.express_id == 28)
        .collect();
    assert_eq!(
        meshes.len(),
        1,
        "the one surface member must emit one face mesh"
    );
    let mesh = meshes[0];
    assert!(!mesh.positions.is_empty() && !mesh.indices.is_empty());

    let world = |index: u32| {
        let base = index as usize * 3;
        [
            mesh.positions[base] as f64 + mesh.origin[0],
            mesh.positions[base + 1] as f64 + mesh.origin[1],
            mesh.positions[base + 2] as f64 + mesh.origin[2],
        ]
    };
    let vertices: Vec<_> = (0..mesh.positions.len() / 3)
        .map(|index| world(index as u32))
        .collect();
    let bounds = |axis: usize| {
        vertices
            .iter()
            .fold((f64::INFINITY, f64::NEG_INFINITY), |(min, max), point| {
                (min.min(point[axis]), max.max(point[axis]))
            })
    };
    let tolerance = 1e-5;
    for (got, expected) in
        [bounds(0), bounds(1), bounds(2)]
            .into_iter()
            .zip([(1.0, 5.0), (2.0, 5.0), (3.0, 3.0)])
    {
        assert!(
            (got.0 - expected.0).abs() < tolerance,
            "min: {got:?} vs {expected:?}"
        );
        assert!(
            (got.1 - expected.1).abs() < tolerance,
            "max: {got:?} vs {expected:?}"
        );
    }

    let area: f64 = mesh
        .indices
        .chunks_exact(3)
        .map(|triangle| {
            let a = nalgebra::Point3::from(world(triangle[0]));
            let b = nalgebra::Point3::from(world(triangle[1]));
            let c = nalgebra::Point3::from(world(triangle[2]));
            (b - a).cross(&(c - a)).norm() / 2.0
        })
        .sum();
    assert!(
        (area - 11.0).abs() < tolerance,
        "4m x 3m face minus its 1m x 1m opening must have area 11m², got {area}"
    );
}
