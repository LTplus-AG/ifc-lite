// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Exporter-boundary regression for #4206 curved structural topology.
//!
//! The MPL-2.0 fixture is independently authored by this project and written
//! by IfcOpenShell 0.8.3's IFC4 exporter. Its reproducible generator lives at
//! `scripts/fixtures/generate-structural-edge-curve.py`.

use ifc_lite_core::EntityScanner;
use ifc_lite_processing::{process_geometry, MeshData};

const FIXTURE: &str =
    "../../tests/models/ifcopenshell/generated_structural_edge_curve.ifc";

fn read_fixture() -> Option<String> {
    match std::fs::read_to_string(FIXTURE) {
        Ok(source) => Some(source),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            eprintln!(
                "skipping structural edge-curve exporter regression: fixture missing at \
                 {FIXTURE} — run `pnpm fixtures` (sha256 in tests/models/manifest.json)"
            );
            None
        }
        Err(error) => panic!("failed to read fixture {FIXTURE}: {error}"),
    }
}

fn find_member_id(source: &str, name: &str) -> u32 {
    let needle = format!("'{name}'");
    let mut scanner = EntityScanner::new(source);
    while let Some((id, ifc_type, start, end)) = scanner.next_entity() {
        if ifc_type == "IFCSTRUCTURALCURVEMEMBER" && source[start..end].contains(&needle) {
            return id;
        }
    }
    panic!("fixture must contain an IfcStructuralCurveMember named {name}");
}

fn world_position(mesh: &MeshData, vertex: usize) -> [f64; 3] {
    let offset = vertex * 3;
    [
        mesh.positions[offset] as f64 + mesh.origin[0],
        mesh.positions[offset + 1] as f64 + mesh.origin[1],
        mesh.positions[offset + 2] as f64 + mesh.origin[2],
    ]
}

fn pair_midpoint(mesh: &MeshData, first: usize) -> [f64; 3] {
    let a = world_position(mesh, first);
    let b = world_position(mesh, first + 1);
    [
        (a[0] + b[0]) / 2.0,
        (a[1] + b[1]) / 2.0,
        (a[2] + b[2]) / 2.0,
    ]
}

fn member_mesh(
    result: &ifc_lite_processing::ProcessingResult,
    id: u32,
) -> &MeshData {
    let meshes: Vec<_> = result
        .meshes
        .iter()
        .filter(|mesh| mesh.express_id == id)
        .collect();
    assert_eq!(meshes.len(), 1, "member #{id} must produce one mesh");
    meshes[0]
}

#[test]
fn ifcopenshell_exported_edge_curve_honors_curve_sense_and_orientation() {
    let Some(source) = read_fixture() else { return };
    let polyline_id = find_member_id(&source, "Generated reversed polyline");
    let circle_id = find_member_id(&source, "Generated reverse-sense circle");
    let result = process_geometry(&source);

    let polyline = member_mesh(&result, polyline_id);
    assert_eq!(polyline.positions.len(), 8 * 3, "two spans need two ribbon quads");
    let polyline_start = pair_midpoint(polyline, 0);
    let polyline_bend = pair_midpoint(polyline, 2);
    let polyline_end = pair_midpoint(polyline, 6);
    assert!((polyline_start[0] - 10.0).abs() < 1e-6, "{polyline_start:?}");
    assert!(
        (polyline_bend[0] - 5.0).abs() < 1e-6
            && (polyline_bend[1] - 5.0).abs() < 1e-6,
        "the exporter-authored bend must survive: {polyline_bend:?}"
    );
    assert!(polyline_end[0].abs() < 1e-6, "{polyline_end:?}");

    let circle = member_mesh(&result, circle_id);
    assert!(circle.positions.len() > 8 * 3, "a circle arc must be sampled");
    let centers: Vec<_> = (0..circle.positions.len() / 3)
        .step_by(2)
        .map(|vertex| pair_midpoint(circle, vertex))
        .collect();
    assert!(
        centers.iter().any(|point| point[1] < -9.0),
        "SameSense=.F. must select the negative-y semicircle: {centers:?}"
    );
    assert!(
        centers.iter().all(|point| point[1] < 1e-6),
        "the opposite semicircle must not leak into the mesh: {centers:?}"
    );
}
