// SPDX-License-Identifier: MPL-2.0
//! exercise retained admission through the canonical IFC processing path.
//! cargo run -p ifc-lite-processing --example retained_geometry -- model.ifc

use ifc_lite_processing::retained_geometry::RetainedGeometry;
use ifc_lite_processing::{process, ProcessingRequest};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let path = std::env::args_os().nth(1).ok_or("pass an IFC file path")?;
    let content = std::fs::read(path)?;
    let result = process(&content, &ProcessingRequest::full_pass(), &mut ());
    let retained = RetainedGeometry::try_from_processing(result)?;
    let mut vertices = 0;
    let mut triangles = 0;
    for record in retained.records() {
        let mesh = retained.document().mesh(record.definition)?;
        vertices += mesh.positions.len() / 3;
        triangles += mesh.indices.len() / 3;
    }
    println!(
        "{}",
        serde_json::json!({
            "meshes": retained.records().len(),
            "vertices": vertices,
            "triangles": triangles,
            "instances": retained.processed().instances.len(),
            "frame": retained.processed().mesh_coordinate_space,
            "csg_failures": retained.processed().stats.total_csg_failures,
            "note": "display approximations admitted into a geometry document; not authored geometry",
        })
    );
    Ok(())
}
