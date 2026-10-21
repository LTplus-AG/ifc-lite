// SPDX-License-Identifier: MPL-2.0
//! retained admission preserves real canonical IFC geometry and frames.

use ifc_lite_processing::retained_geometry::{
    RetainedGeometry, RetainedGeometryErrorCause, RetainedGeometryLocation,
};
use ifc_lite_processing::{process, InstanceRecord, ProcessingRequest, ProcessingResult};
use ifc_lite_testkit::fixture_bytes;

const SWEPT_DISK: &[u8] =
    include_bytes!("../../geometry/tests/fixtures/swept_disk_trimmed_line.ifc");
const MAPPED_INSTANCES: &[u8] =
    include_bytes!("../../geometry/tests/fixtures/mapped_instances_synthetic.ifc");

type MeshSidechannels = (
    Option<[f32; 6]>,
    Option<[f64; 16]>,
    Option<ifc_lite_geometry::InstanceMeta>,
);

fn sidechannels(result: &ProcessingResult) -> Vec<MeshSidechannels> {
    result
        .meshes
        .iter()
        .map(|mesh| {
            (
                mesh.local_bounds,
                mesh.local_to_world,
                mesh.instance.clone(),
            )
        })
        .collect()
}

fn assert_sidechannels_preserved(expected: &[MeshSidechannels], actual: &ProcessingResult) {
    assert_eq!(expected.len(), actual.meshes.len());
    for ((bounds, placement, instance), actual) in expected.iter().zip(&actual.meshes) {
        assert_eq!(actual.local_bounds, *bounds);
        assert_eq!(actual.local_to_world, *placement);
        match (&actual.instance, instance) {
            (Some(actual), Some(expected)) => {
                assert_eq!(actual.transform, expected.transform);
                assert_eq!(actual.local_transform, expected.local_transform);
                assert_eq!(actual.canonical_transform, expected.canonical_transform);
                assert_eq!(actual.rep_identity, expected.rep_identity);
                assert_eq!(actual.instanceable, expected.instanceable);
            }
            (None, None) => {}
            _ => panic!("retained admission changed instancing metadata"),
        }
    }
}

fn assert_instances_preserved(expected: &[InstanceRecord], actual: &[InstanceRecord]) {
    assert_eq!(actual.len(), expected.len());
    for (actual, expected) in actual.iter().zip(expected) {
        assert_eq!(actual.express_id, expected.express_id);
        assert_eq!(actual.ifc_type, expected.ifc_type);
        assert_eq!(actual.global_id, expected.global_id);
        assert_eq!(actual.name, expected.name);
        assert_eq!(actual.presentation_layer, expected.presentation_layer);
        assert_eq!(actual.color, expected.color);
        assert_eq!(actual.template_express_id, expected.template_express_id);
        assert_eq!(actual.rep_identity, expected.rep_identity);
        assert_eq!(actual.transform, expected.transform);
        assert_eq!(actual.geometry_item_id, expected.geometry_item_id);
    }
}

fn apply(matrix: &[f64; 16], point: [f64; 3]) -> [f64; 3] {
    [0, 1, 2].map(|row| {
        matrix[row * 4] * point[0]
            + matrix[row * 4 + 1] * point[1]
            + matrix[row * 4 + 2] * point[2]
            + matrix[row * 4 + 3]
    })
}

fn assert_point_close(actual: [f64; 3], expected: [f64; 3], tolerance: f64) {
    for axis in 0..3 {
        assert!(
            (actual[axis] - expected[axis]).abs() <= tolerance,
            "point {actual:?} differs from {expected:?}"
        );
    }
}

fn assert_preserved(result: ProcessingResult) {
    assert!(
        !result.meshes.is_empty(),
        "fixture must exercise actual geometry"
    );
    let original = serde_json::to_value(&result.meshes).unwrap();
    let original_sidechannels = sidechannels(&result);
    let frame = result.frame.world_matrix();
    let triangles = result.stats.total_triangles;
    let instances = result.instances.clone();
    let retained = RetainedGeometry::try_from_processing(result).unwrap();
    assert_eq!(
        serde_json::to_value(&retained.processed().meshes).unwrap(),
        original
    );
    assert_eq!(retained.processed().frame.world_matrix(), frame);
    assert_instances_preserved(&instances, &retained.processed().instances);
    assert_sidechannels_preserved(&original_sidechannels, retained.processed());
    for record in retained.records() {
        let source = &retained.processed().meshes[record.mesh_index];
        let mesh = retained.document().mesh(record.definition).unwrap();
        assert_eq!(mesh.positions, source.positions);
        assert_eq!(mesh.normals, source.normals);
        assert_eq!(mesh.indices, source.indices);
        let occurrence = retained.document().occurrence(record.occurrence).unwrap();
        assert_eq!(occurrence.source_entity_id, source.express_id);
        let m = occurrence.local_to_model;
        for p in mesh.positions.chunks_exact(3) {
            let placed = [
                m[0] * p[0] as f64 + m[1] * p[1] as f64 + m[2] * p[2] as f64 + m[3],
                m[4] * p[0] as f64 + m[5] * p[1] as f64 + m[6] * p[2] as f64 + m[7],
                m[8] * p[0] as f64 + m[9] * p[1] as f64 + m[10] * p[2] as f64 + m[11],
            ];
            let expected = [
                p[0] as f64 + source.origin[0],
                p[1] as f64 + source.origin[1],
                p[2] as f64 + source.origin[2],
            ];
            assert_eq!(
                retained.processed().frame.to_world(placed),
                retained.processed().frame.to_world(expected)
            );
        }
    }
    let recovered = retained.into_processing_result();
    assert_eq!(recovered.stats.total_triangles, triangles);
    assert_eq!(serde_json::to_value(&recovered.meshes).unwrap(), original);
    assert_instances_preserved(&instances, &recovered.instances);
    assert_sidechannels_preserved(&original_sidechannels, &recovered);
}

#[test]
fn mapped_millimetre_source_keeps_canonical_geometry() {
    assert_preserved(process(
        SWEPT_DISK,
        &ProcessingRequest::full_pass(),
        &mut (),
    ));
}

#[test]
fn admission_refusal_returns_original_result() {
    let mut result = process(SWEPT_DISK, &ProcessingRequest::full_pass(), &mut ());
    assert!(!result.meshes.is_empty());
    result.meshes[0].indices[0] = u32::MAX;
    let original = serde_json::to_value(&result.meshes).unwrap();
    let error = match RetainedGeometry::try_from_processing(result) {
        Ok(_) => panic!("invalid index must be refused"),
        Err(error) => error,
    };
    assert_eq!(error.location, RetainedGeometryLocation::Mesh(0));
    assert_eq!(
        serde_json::to_value(&error.into_processing_result().meshes).unwrap(),
        original
    );
}

#[test]
fn retained_instances_reproduce_canonical_flat_world_geometry() {
    let flat = process(
        MAPPED_INSTANCES,
        &ProcessingRequest::full_pass().instancing(false),
        &mut (),
    );
    let processed = process(
        MAPPED_INSTANCES,
        &ProcessingRequest::full_pass().instancing(true),
        &mut (),
    );
    assert!(
        !processed.instances.is_empty(),
        "real instancing path must execute"
    );
    let expected_instances = processed.instances.clone();
    let original_sidechannels = sidechannels(&processed);
    let retained = RetainedGeometry::try_from_processing(processed).unwrap();
    assert_eq!(retained.instances().len(), expected_instances.len());
    for record in retained.instances() {
        let source = &expected_instances[record.instance_index];
        let template = &retained.processed().meshes[record.mesh_index];
        assert_eq!(template.express_id, source.template_express_id);
        let occurrence = retained.document().occurrence(record.occurrence).unwrap();
        let mesh_record = &retained.records()[record.mesh_index];
        assert_eq!(occurrence.definition, mesh_record.definition);
        assert_eq!(occurrence.source_entity_id, source.express_id);
        let mesh = retained.document().mesh(occurrence.definition).unwrap();
        let flat_mesh = flat
            .meshes
            .iter()
            .find(|mesh| {
                mesh.express_id == source.express_id
                    && mesh.geometry_item_id == template.geometry_item_id
            })
            .expect("flat occurrence exists");
        assert_eq!(mesh.positions.len(), flat_mesh.positions.len());
        assert_eq!(mesh.indices, flat_mesh.indices);
        for (local, flat_local) in mesh
            .positions
            .chunks_exact(3)
            .zip(flat_mesh.positions.chunks_exact(3))
        {
            let local = [local[0] as f64, local[1] as f64, local[2] as f64];
            let placed = apply(&occurrence.local_to_model, local);
            let expected = apply(
                &source.transform.map(f64::from),
                [
                    local[0] + template.origin[0],
                    local[1] + template.origin[1],
                    local[2] + template.origin[2],
                ],
            );
            assert_point_close(placed, expected, 1e-12);
            let flat_point = [
                flat_local[0] as f64 + flat_mesh.origin[0],
                flat_local[1] as f64 + flat_mesh.origin[1],
                flat_local[2] as f64 + flat_mesh.origin[2],
            ];
            assert_point_close(
                retained.processed().frame.to_world(placed),
                flat.frame.to_world(flat_point),
                1e-6,
            );
        }
    }
    assert_instances_preserved(&expected_instances, &retained.processed().instances);
    assert_sidechannels_preserved(&original_sidechannels, retained.processed());
    let recovered = retained.into_processing_result();
    assert_instances_preserved(&expected_instances, &recovered.instances);
    assert_sidechannels_preserved(&original_sidechannels, &recovered);
}

#[test]
fn each_instance_admits_all_template_meshes_and_composes_origins() {
    let mut processed = process(
        MAPPED_INSTANCES,
        &ProcessingRequest::full_pass().instancing(true),
        &mut (),
    );
    assert!(!processed.instances.is_empty());
    processed.instances[0].transform = [
        0., -1., 0., 10., 1., 0., 0., 20., 0., 0., 1., 30., 0., 0., 0., 1.,
    ];
    processed.instances[0].color = [0.13, 0.27, 0.71, 0.5];
    // Exercise a multi-piece template using real produced geometry, with a
    // separate local origin that the template-relative instance must transform.
    let template_id = processed.instances[0].template_express_id;
    let mut second_piece = processed
        .meshes
        .iter()
        .find(|mesh| mesh.express_id == template_id)
        .unwrap()
        .clone();
    second_piece.origin = [3.25, -4.75, 8.125];
    processed.meshes.push(second_piece);
    let expected_instances = processed.instances.clone();
    let retained = RetainedGeometry::try_from_processing(processed).unwrap();
    assert_eq!(retained.instances().len(), 2 * expected_instances.len());
    for record in retained.instances() {
        let source = &expected_instances[record.instance_index];
        let template = &retained.processed().meshes[record.mesh_index];
        let occurrence = retained.document().occurrence(record.occurrence).unwrap();
        assert_eq!(
            occurrence.definition,
            retained.records()[record.mesh_index].definition
        );
        for p in template.positions.chunks_exact(3) {
            let local = [p[0] as f64, p[1] as f64, p[2] as f64];
            let expected = apply(
                &source.transform.map(f64::from),
                [
                    local[0] + template.origin[0],
                    local[1] + template.origin[1],
                    local[2] + template.origin[2],
                ],
            );
            assert_point_close(apply(&occurrence.local_to_model, local), expected, 1e-12);
        }
    }
    assert_instances_preserved(
        &expected_instances,
        &retained.into_processing_result().instances,
    );
}

#[test]
fn missing_instance_template_refuses_admission_and_returns_every_record() {
    let mut processed = process(
        MAPPED_INSTANCES,
        &ProcessingRequest::full_pass().instancing(true),
        &mut (),
    );
    assert!(!processed.instances.is_empty());
    processed.instances[0].template_express_id = u32::MAX;
    let original_meshes = serde_json::to_value(&processed.meshes).unwrap();
    let original_instances = processed.instances.clone();
    let error = match RetainedGeometry::try_from_processing(processed) {
        Ok(_) => panic!("missing template must be refused"),
        Err(error) => error,
    };
    assert_eq!(error.location, RetainedGeometryLocation::Instance(0));
    assert_eq!(
        error.source,
        RetainedGeometryErrorCause::MissingTemplate {
            template_express_id: u32::MAX
        }
    );
    let recovered = error.into_processing_result();
    assert_eq!(
        serde_json::to_value(&recovered.meshes).unwrap(),
        original_meshes
    );
    assert_instances_preserved(&original_instances, &recovered.instances);
}

#[test]
fn survey_coordinate_admission_keeps_f64_frame() {
    let model = std::str::from_utf8(SWEPT_DISK).unwrap().replace(
        "#10=IFCCARTESIANPOINT((0.,0.,0.));",
        "#10=IFCCARTESIANPOINT((5000000000.,0.,0.));",
    );
    let result = process(model.as_bytes(), &ProcessingRequest::full_pass(), &mut ());
    let source = &result.meshes[0];
    let p = &source.positions;
    let world = result.frame.to_world([
        p[0] as f64 + source.origin[0],
        p[1] as f64 + source.origin[1],
        p[2] as f64 + source.origin[2],
    ]);
    assert!(
        world[0] > 1_000_000.,
        "exercise a survey-scale world placement"
    );
    assert_preserved(result);
}

#[test]
fn real_authoring_models_preserve_retained_buffers() {
    for name in [
        "AC20-FZK-Haus.ifc",
        "ISSUE_129_N1540_17_EXE_MOD_448200_02_09_11SMC_IGC_V17.ifc",
    ] {
        let Some(content) = fixture_bytes(&format!("ara3d/{name}")) else {
            continue;
        };
        assert_preserved(process(&content, &ProcessingRequest::full_pass(), &mut ()));
    }
}
