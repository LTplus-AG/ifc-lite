// SPDX-License-Identifier: MPL-2.0
use super::*;
use crate::processors::IfcEdgeProcessor;
use ifc_lite_core::EntityDecoder;
use crate::TessellationQuality;

fn lower(source: String, id: u32) -> EdgePlan {
    let mut decoder = EntityDecoder::new(&source);
    let entity = decoder.decode_by_id(id).unwrap();
    IfcEdgeProcessor::new().lower(&entity, &mut decoder, TessellationQuality::Medium).unwrap()
}

#[test]
fn owned_oriented_edge_retains_endpoint_sense_and_ribbon_width_after_source_disposal() {
    let plan = lower("#1=IFCCARTESIANPOINT((0.,0.,0.));\n\
        #2=IFCCARTESIANPOINT((4.,0.,0.));\n\
        #3=IFCVERTEXPOINT(#1);#4=IFCVERTEXPOINT(#2);\n\
        #5=IFCEDGE(#3,#4);#6=IFCORIENTEDEDGE(*,*,#5,.F.);".into(), 6);
    let mesh = plan.evaluate();
    assert_eq!(mesh.positions.len(), 12);
    assert_eq!(mesh.indices.len(), 6);
    assert_eq!(mesh.positions[0], 4.0, "oriented edge must start at its reversed endpoint");
    assert_eq!(mesh.positions[6], 0.0);
    for position in mesh.positions.chunks_exact(3) {
        assert!((position[1].abs() - 0.1).abs() < 1e-7);
        assert_eq!(position[2], 0.0);
    }
    // Two triangles cover a four-by-0.2 diagnostic ribbon, independently of
    // which side the reversed edge calls right.
    let area: f64 = mesh.indices.chunks_exact(3).map(|triangle| {
        let p = |id: u32| nalgebra::Vector3::new(mesh.positions[id as usize * 3] as f64,
            mesh.positions[id as usize * 3 + 1] as f64, mesh.positions[id as usize * 3 + 2] as f64);
        (p(triangle[1]) - p(triangle[0])).cross(&(p(triangle[2]) - p(triangle[0]))).norm() * 0.5
    }).sum();
    assert!((area - 0.8).abs() < 1e-7);
}

#[test]
fn owned_edge_preserves_cycle_and_bad_vertex_refusals() {
    for source in ["#1=IFCORIENTEDEDGE(*,*,#1,.T.);", "#1=IFCEDGE(#99,#99);"] {
        let mut decoder = EntityDecoder::new(source);
        let entity = decoder.decode_by_id(1).unwrap();
        assert!(IfcEdgeProcessor::new().lower(&entity, &mut decoder, TessellationQuality::Medium).is_err());
    }
}
