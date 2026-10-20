// SPDX-License-Identifier: MPL-2.0
//! Owned primitive replay and production admission invariants.

use super::{BlockPlan, SpherePlan};
use crate::processors::{BlockProcessor, SphereProcessor};
use crate::{Mesh, TessellationQuality};
use ifc_lite_core::EntityDecoder;

const PLACEMENT: &str = "#1=IFCCARTESIANPOINT((7.,11.,13.));\n\
    #2=IFCDIRECTION((0.,0.,1.));\n#3=IFCDIRECTION((0.,1.,0.));\n\
    #4=IFCAXIS2PLACEMENT3D(#1,#2,#3);\n";

fn block(source: &str) -> crate::Result<BlockPlan> {
    let mut decoder = EntityDecoder::new(source);
    let entity = decoder.decode_by_id(5)?;
    BlockProcessor::new().lower(&entity, &mut decoder)
}

fn sphere(source: &str, quality: TessellationQuality) -> crate::Result<SpherePlan> {
    let mut decoder = EntityDecoder::new(source);
    let entity = decoder.decode_by_id(5)?;
    SphereProcessor::new().lower(&entity, &mut decoder, quality)
}

fn bounds(mesh: &Mesh) -> ([f32; 3], [f32; 3]) {
    let mut min = [f32::INFINITY; 3];
    let mut max = [f32::NEG_INFINITY; 3];
    for point in mesh.positions.chunks_exact(3) {
        for axis in 0..3 {
            min[axis] = min[axis].min(point[axis]);
            max[axis] = max[axis].max(point[axis]);
        }
    }
    (min, max)
}

fn volume(mesh: &Mesh) -> f64 {
    mesh.indices
        .chunks_exact(3)
        .map(|triangle| {
            let point = |index: u32| {
                let i = index as usize * 3;
                nalgebra::Vector3::new(
                    mesh.positions[i] as f64,
                    mesh.positions[i + 1] as f64,
                    mesh.positions[i + 2] as f64,
                )
            };
            point(triangle[0]).dot(&point(triangle[1]).cross(&point(triangle[2]))) / 6.
        })
        .sum::<f64>()
}

#[test]
fn block_plan_replays_rotated_raw_dimensions_after_source_disposal() {
    let plan = {
        let source = format!("{PLACEMENT}#5=IFCBLOCK(#4,2.000000000001,3.,4.);");
        block(&source).unwrap()
    };
    assert_eq!(plan.dimensions[0].to_bits(), 2.000000000001f64.to_bits());
    let mesh = plan.evaluate();
    // Position rotates +X to +Y and +Y to -X before translation.
    assert_eq!(bounds(&mesh), ([4., 11., 13.], [7., 13., 17.]));
    assert!((volume(&mesh) - 24.).abs() < 1e-12);
    let replay = plan.clone().evaluate();
    assert_eq!(mesh.positions, replay.positions);
    assert_eq!(mesh.indices, replay.indices);
    assert_eq!(mesh.normals, replay.normals);
}

#[test]
fn sphere_plan_replays_radius_and_quality_after_source_disposal() {
    let plan = {
        let source = format!("{PLACEMENT}#5=IFCSPHERE(#4,2.000000000001);");
        sphere(&source, TessellationQuality::Medium).unwrap()
    };
    assert_eq!(plan.radius.to_bits(), 2.000000000001f64.to_bits());
    assert_eq!((plan.slices, plan.stacks), (24, 16));
    let mesh = plan.evaluate();
    assert_eq!(bounds(&mesh), ([5., 9., 11.], [9., 13., 15.]));
    for point in mesh.positions.chunks_exact(3) {
        let radius = (point[0] as f64 - 7.)
            .hypot(point[1] as f64 - 11.)
            .hypot(point[2] as f64 - 13.);
        assert!((radius - 2.).abs() < 1e-6);
    }
    for normal in mesh.normals.chunks_exact(3) {
        let length = (normal[0] as f64)
            .hypot(normal[1] as f64)
            .hypot(normal[2] as f64);
        assert!((length - 1.).abs() < 1e-6);
    }
    let source = "#5=IFCSPHERE($,2.);";
    let coarse = sphere(source, TessellationQuality::Lowest)
        .unwrap()
        .evaluate();
    let fine = sphere(source, TessellationQuality::Highest)
        .unwrap()
        .evaluate();
    let expected = 4. / 3. * std::f64::consts::PI * 8.;
    assert!(fine.indices.len() > coarse.indices.len());
    assert!((volume(&fine) - expected).abs() < (volume(&coarse) - expected).abs());
}

#[test]
fn primitive_null_and_wrong_type_positions_preserve_identity() {
    for position in ["$", "#1"] {
        let source = format!("#1=IFCDIRECTION((1.,0.,0.));\n#5=IFCBLOCK({position},2.,3.,4.);");
        let plan = block(&source).unwrap();
        assert!(plan.position.is_none());
        assert_eq!(bounds(&plan.evaluate()), ([0., 0., 0.], [2., 3., 4.]));
        let source = format!("#1=IFCDIRECTION((1.,0.,0.));\n#5=IFCSPHERE({position},2.);");
        let plan = sphere(&source, TessellationQuality::Medium).unwrap();
        assert!(plan.position.is_none());
        assert_eq!(bounds(&plan.evaluate()), ([-2., -2., -2.], [2., 2., 2.]));
    }
}

#[test]
fn primitive_dimensions_are_admitted_before_position_and_keep_error_order() {
    // Missing YLength wins before nonpositive XLength validation or bad Position.
    let source = "#4=IFCAXIS2PLACEMENT3D(17.);\n#5=IFCBLOCK(#4,0.,$,4.);";
    assert_eq!(
        block(source).unwrap_err().to_string(),
        "Geometry processing error: IfcBlock missing YLength"
    );
    let source = "#4=IFCAXIS2PLACEMENT3D(17.);\n#5=IFCBLOCK(#4,0.,3.,4.);";
    assert_eq!(
        block(source).unwrap_err().to_string(),
        "Geometry processing error: IfcBlock requires finite positive lengths, got (0, 3, 4)"
    );
    let source = "#4=IFCAXIS2PLACEMENT3D(17.);\n#5=IFCSPHERE(#4,0.);";
    assert_eq!(
        sphere(source, TessellationQuality::Medium)
            .unwrap_err()
            .to_string(),
        "Geometry processing error: IfcSphere requires finite positive radius, got 0"
    );
    let source = "#5=IFCSPHERE($,$);";
    assert_eq!(
        sphere(source, TessellationQuality::Medium)
            .unwrap_err()
            .to_string(),
        "Geometry processing error: IfcSphere missing Radius"
    );
    assert!(block("#4=IFCAXIS2PLACEMENT3D(17.);\n#5=IFCBLOCK(#4,2.,3.,4.);").is_err());
    assert!(sphere(
        "#4=IFCAXIS2PLACEMENT3D(17.);\n#5=IFCSPHERE(#4,2.);",
        TessellationQuality::Medium
    )
    .is_err());
}
