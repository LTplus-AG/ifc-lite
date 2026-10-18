// SPDX-License-Identifier: MPL-2.0
//! actual isolated native SMLib processes; no mock geometry engine.
#![cfg(not(target_arch = "wasm32"))]
use ifc_lite_geometry::document::BooleanOperation;
use ifc_lite_geometry_runtime::{SmlibWorker, WorkerError};

fn worker() -> Option<SmlibWorker> {
    let Some(path) = std::env::var_os("IFCLITE_SMLIB_WORKER") else {
        eprintln!("SKIP: build native/smlib-adapter and set IFCLITE_SMLIB_WORKER to its ifclite_smlib_worker executable");
        return None;
    };
    Some(SmlibWorker::spawn(path).expect("configured worker must start"))
}

fn close(left: f64, right: f64) {
    assert!((left - right).abs() < 1e-6, "{left} != {right}");
}

#[test]
fn real_worker_preserves_boolean_inputs_and_empty_success() {
    let Some(mut worker) = worker() else { return };
    let left = worker.create_box([0.; 3], [2.; 3]).unwrap();
    let right = worker.create_box([1., 0., 0.], [2.; 3]).unwrap();
    for (operation, expected) in [
        (BooleanOperation::Difference, 4.),
        (BooleanOperation::Union, 12.),
        (BooleanOperation::Intersection, 4.),
    ] {
        let result = worker.boolean(left, right, operation).unwrap();
        close(worker.volume(result, 1e-8).unwrap(), expected);
        assert!(worker.is_manifold(result).unwrap());
        close(worker.volume(left, 1e-8).unwrap(), 8.);
        close(worker.volume(right, 1e-8).unwrap(), 8.);
        worker.release(result).unwrap();
    }
    let empty = worker
        .boolean(left, left, BooleanOperation::Difference)
        .unwrap();
    close(worker.volume(empty, 1e-8).unwrap(), 0.);
    worker.release(empty).unwrap();
    worker.release(right).unwrap();
    assert!(matches!(
        worker.boolean(left, right, BooleanOperation::Difference),
        Err(WorkerError::Kernel { .. })
    ));
    close(worker.volume(left, 1e-8).unwrap(), 8.);
    worker.release(left).unwrap();
}

#[test]
fn two_real_workers_isolate_context_and_handles() {
    let Some(mut first) = worker() else { return };
    let Some(mut second) = worker() else { return };
    // Session and slot wire IDs coincide across fresh processes. Host identity
    // must still reject a cross-worker handle before it can alias another solid.
    let left = first.create_box([0.; 3], [2.; 3]).unwrap();
    let right = second.create_box([0.; 3], [3.; 3]).unwrap();
    assert!(matches!(
        second.volume(left, 1e-8),
        Err(WorkerError::WrongWorker)
    ));
    let a = std::thread::spawn(move || first.volume(left, 1e-8).unwrap());
    let b = std::thread::spawn(move || second.volume(right, 1e-8).unwrap());
    close(a.join().unwrap(), 8.);
    close(b.join().unwrap(), 27.);
}

#[test]
fn failed_commands_preserve_worker_session_and_released_handles_stay_stale() {
    let Some(mut worker) = worker() else { return };
    assert!(matches!(
        worker.create_box([0.; 3], [-1., 1., 1.]),
        Err(WorkerError::Kernel { .. })
    ));
    let solid = worker.create_cylinder([0.; 3], 0.5, 3.).unwrap();
    close(
        worker.volume(solid, 1e-8).unwrap(),
        std::f64::consts::PI * 0.75,
    );
    worker.release(solid).unwrap();
    let replacement = worker.create_box([0.; 3], [1.; 3]).unwrap();
    assert!(matches!(
        worker.volume(solid, 1e-8),
        Err(WorkerError::Kernel { .. })
    ));
    close(worker.volume(replacement, 1e-8).unwrap(), 1.);
}

#[test]
fn explicit_termination_reaps_worker_and_refuses_reuse() {
    let Some(mut worker) = worker() else { return };
    let solid = worker.create_box([0.; 3], [1.; 3]).unwrap();
    #[cfg(target_os = "linux")]
    let pid = worker.process_id();
    worker.terminate().unwrap();
    worker.terminate().unwrap();
    assert!(matches!(
        worker.volume(solid, 1e-8),
        Err(WorkerError::Protocol(_))
    ));
    #[cfg(target_os = "linux")]
    assert!(
        !std::path::Path::new(&format!("/proc/{pid}")).exists(),
        "child must be reaped"
    );
}

#[cfg(unix)]
#[test]
fn real_worker_death_poisons_transport_and_drop_reaps() {
    let Some(mut worker) = worker() else { return };
    let solid = worker.create_box([0.; 3], [1.; 3]).unwrap();
    let pid = worker.process_id();
    let status = std::process::Command::new("kill")
        .args(["-KILL", &pid.to_string()])
        .status()
        .unwrap();
    assert!(status.success());
    assert!(matches!(
        worker.volume(solid, 1e-8),
        Err(WorkerError::Io(_))
    ));
    assert!(matches!(
        worker.volume(solid, 1e-8),
        Err(WorkerError::Protocol(_))
    ));
    drop(worker);
    #[cfg(target_os = "linux")]
    assert!(
        !std::path::Path::new(&format!("/proc/{pid}")).exists(),
        "dead child must be reaped"
    );
}

fn mesh_volume(mesh: &ifc_lite_geometry_runtime::TessellatedMesh) -> f64 {
    mesh.indices
        .chunks_exact(3)
        .map(|triangle| {
            let p = |i: u32| -> [f64; 3] {
                let i = i as usize * 3;
                mesh.positions[i..i + 3].try_into().unwrap()
            };
            let [a, b, c] = [p(triangle[0]), p(triangle[1]), p(triangle[2])];
            (a[0] * (b[1] * c[2] - b[2] * c[1])
                + a[1] * (b[2] * c[0] - b[0] * c[2])
                + a[2] * (b[0] * c[1] - b[1] * c[0]))
                / 6.
        })
        .sum::<f64>()
        .abs()
}

#[test]
fn real_worker_returns_closed_face_attributed_mesh() {
    use ifc_lite_geometry_runtime::MeshLimits;
    let Some(mut worker) = worker() else { return };
    let a = worker.create_box([0.; 3], [2.; 3]).unwrap();
    let b = worker.create_box([1., 0., 0.], [2.; 3]).unwrap();
    let body = worker.boolean(a, b, BooleanOperation::Difference).unwrap();
    let mesh = worker
        .tessellate(body, 0.001, 15., MeshLimits::default())
        .unwrap();
    assert!(!mesh.indices.is_empty());
    close(mesh_volume(&mesh), 4.);
    assert_eq!(mesh.boundary_edges, 0);
    assert_eq!(mesh.spine_edges, 0);
    assert_eq!(mesh.corner_normals.len(), mesh.indices.len() * 3);
    assert_eq!(mesh.source_faces.len(), mesh.indices.len() / 3);
    assert!(mesh
        .source_faces
        .iter()
        .all(|&face| face < mesh.source_face_count));
    let mut edges = std::collections::HashMap::<(u32, u32), Vec<(u32, u32)>>::new();
    for t in mesh.indices.chunks_exact(3) {
        for (a, b) in [(t[0], t[1]), (t[1], t[2]), (t[2], t[0])] {
            edges.entry((a.min(b), a.max(b))).or_default().push((a, b));
        }
    }
    for directions in edges.values() {
        assert_eq!(
            directions.len(),
            2,
            "each closed mesh edge has two incident triangles"
        );
        assert_eq!(
            directions[0],
            (directions[1].1, directions[1].0),
            "consistent winding"
        );
    }
    worker.release(body).unwrap();
    close(mesh_volume(&mesh), 4.); // host buffer lifetime is independent of body.
    assert!(matches!(
        worker.tessellate(a, 0.001, 15., MeshLimits { max_bytes: 1 }),
        Err(WorkerError::ResourceLimit(_))
    ));
    close(worker.volume(a, 1e-8).unwrap(), 8.); // limit rejection kept session usable.
}

#[test]
fn brep_mesh_conversion_enters_exact_document_only_explicitly() {
    use ifc_lite_geometry::document::{DocumentError, EvaluationContract, GeometryDocument};
    use ifc_lite_geometry_runtime::MeshLimits;
    let Some(mut worker) = worker() else { return };
    let a = worker.create_box([0.; 3], [2.; 3]).unwrap();
    let b = worker.create_box([1., 0., 0.], [2.; 3]).unwrap();
    let mut document = GeometryDocument::new();
    let mut definitions = Vec::new();
    for (id, body) in [(10, a), (20, b)] {
        let tessellation = worker
            .tessellate(body, 0.001, 15., MeshLimits::default())
            .unwrap();
        let mut discrete = ifc_lite_geometry::Mesh::new();
        // Explicit representation conversion: exact predicates subsequently act
        // on these discrete f32 operands, not on the original analytic surfaces.
        discrete.positions = tessellation.positions.iter().map(|&v| v as f32).collect();
        discrete.indices = tessellation.indices;
        definitions.push(document.add_mesh_definition(id, discrete).unwrap());
    }
    let exact = document
        .prepare_boolean(
            BooleanOperation::Difference,
            definitions[0],
            definitions[1],
            EvaluationContract::ExactPolyhedral,
        )
        .unwrap();
    let result = document.evaluate_exact(&exact).unwrap();
    let mesh = document.result_mesh(&result).unwrap();
    let mut volume = 0.;
    for t in mesh.indices.chunks_exact(3) {
        let point = |i: u32| -> [f64; 3] {
            let i = i as usize * 3;
            [
                mesh.positions[i] as f64,
                mesh.positions[i + 1] as f64,
                mesh.positions[i + 2] as f64,
            ]
        };
        let [a, b, c] = [point(t[0]), point(t[1]), point(t[2])];
        volume += (a[0] * (b[1] * c[2] - b[2] * c[1])
            + a[1] * (b[2] * c[0] - b[0] * c[2])
            + a[2] * (b[0] * c[1] - b[1] * c[0]))
            / 6.;
    }
    close(volume.abs(), 4.);
    let unsupported = document
        .prepare_boolean(
            BooleanOperation::Difference,
            definitions[0],
            definitions[1],
            EvaluationContract::RetainedBrep,
        )
        .unwrap();
    assert_eq!(
        document.evaluate_exact(&unsupported).unwrap_err(),
        DocumentError::UnsupportedContract
    );
    let brep_result = worker.boolean(a, b, BooleanOperation::Difference).unwrap();
    close(worker.volume(brep_result, 1e-8).unwrap(), 4.);
}
