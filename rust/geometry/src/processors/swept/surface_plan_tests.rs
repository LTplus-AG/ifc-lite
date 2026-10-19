// SPDX-License-Identifier: MPL-2.0
use super::*;
use crate::processors::SurfaceCurveSweptAreaSolidProcessor;
use crate::TessellationQuality;
use ifc_lite_core::{EntityDecoder, IfcSchema};

fn lower(kind: &str) -> SurfaceCurveSweepPlan {
    let source = format!(
        "#1=IFCCARTESIANPOINT((0.,0.,0.));\n\
        #2=IFCCARTESIANPOINT((0.,0.,3.));\n\
        #3=IFCPOLYLINE((#1,#2));\n\
        #4=IFCRECTANGLEPROFILEDEF(.AREA.,$,$,2.,4.);\n\
        #5=IFCCARTESIANPOINT((10.,20.,30.));\n\
        #6=IFCAXIS2PLACEMENT3D(#5,$,$);\n\
        #7={kind}(#4,#6,#3,$,$,$);"
    );
    let mut decoder = EntityDecoder::new(&source);
    let entity = decoder.decode_by_id(7).unwrap();
    SurfaceCurveSweptAreaSolidProcessor::new(IfcSchema::new())
        .lower(&entity, &mut decoder, TessellationQuality::Medium)
        .unwrap()
        .unwrap()
}

#[test]
fn owned_swept_area_retains_profile_and_placed_raw_directrix_after_source_disposal() {
    for kind in [
        "IFCSURFACECURVESWEPTAREASOLID",
        "IFCFIXEDREFERENCESWEPTAREASOLID",
    ] {
        let mesh = lower(kind).evaluate().unwrap();
        let mut min = [f32::INFINITY; 3];
        let mut max = [f32::NEG_INFINITY; 3];
        for vertex in mesh.positions.chunks_exact(3) {
            for axis in 0..3 {
                min[axis] = min[axis].min(vertex[axis]);
                max[axis] = max[axis].max(vertex[axis]);
            }
        }
        assert_eq!(min, [8.0, 19.0, 30.0]);
        assert_eq!(max, [12.0, 21.0, 33.0]);
        // Independent divergence-theorem volume for the authored rectangular prism.
        let volume: f64 = mesh
            .indices
            .chunks_exact(3)
            .map(|tri| {
                let p = |id: u32| {
                    nalgebra::Vector3::new(
                        mesh.positions[id as usize * 3] as f64,
                        mesh.positions[id as usize * 3 + 1] as f64,
                        mesh.positions[id as usize * 3 + 2] as f64,
                    )
                };
                p(tri[0]).dot(&p(tri[1]).cross(&p(tri[2]))) / 6.0
            })
            .sum();
        assert!((volume.abs() - 24.0).abs() < 1e-8);
        assert_eq!(mesh.positions.len(), mesh.normals.len());
        assert!(mesh.normals.iter().all(|n| n.is_finite()));
    }
}

#[test]
fn owned_swept_area_preserves_missing_profile_refusal() {
    let mut decoder = EntityDecoder::new("#1=IFCSURFACECURVESWEPTAREASOLID($,$,#98,$,$,$);");
    let entity = decoder.decode_by_id(1).unwrap();
    let error = SurfaceCurveSweptAreaSolidProcessor::new(IfcSchema::new())
        .lower(&entity, &mut decoder, TessellationQuality::Medium)
        .unwrap_err();
    assert!(error.to_string().contains("SweptArea"));
}

#[test]
fn composite_sweep_over_the_vertex_budget_is_refused_with_the_exact_count() {
    let square = |x: f64| {
        Profile2D::new(vec![
            nalgebra::Point2::new(x, 0.0),
            nalgebra::Point2::new(x + 1.0, 0.0),
            nalgebra::Point2::new(x + 1.0, 1.0),
            nalgebra::Point2::new(x, 1.0),
        ])
    };
    // 2 regions x 4 ring points x 16385 stations = 131080 > 1 << 17.
    let plan = SurfaceCurveSweepPlan {
        regions: vec![square(0.0), square(3.0)],
        points: (0..16385)
            .map(|i| Point3::new(0.0, 0.0, i as f64 * 0.001))
            .collect(),
        entity_id: 77,
    };
    let error = plan.evaluate().unwrap_err();
    assert_eq!(
        error.to_string(),
        "Geometry processing error: Sweep would place 131080 ring vertices, over 131072, at #77"
    );
}
