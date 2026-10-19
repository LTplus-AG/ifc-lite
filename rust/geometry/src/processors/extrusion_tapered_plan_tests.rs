// SPDX-License-Identifier: MPL-2.0
//! Replay and admission invariants for owned tapered constructions.

use super::TaperedExtrusionPlan;
use crate::{processors::ExtrudedAreaSolidTaperedProcessor, Mesh, TessellationQuality};
use ifc_lite_core::{EntityDecoder, IfcSchema};

const SOURCE: &str = "#1=IFCRECTANGLEPROFILEDEF(.AREA.,$,$,4.,4.);\n\
    #2=IFCRECTANGLEPROFILEDEF(.AREA.,$,$,2.,2.);\n\
    #3=IFCDIRECTION((0.,0.,1.));\n#4=IFCCARTESIANPOINT((7.,11.,13.));\n\
    #5=IFCAXIS2PLACEMENT3D(#4,$,$);\n#6=IFCEXTRUDEDAREASOLIDTAPERED(#1,#5,#3,3.,#2);";

fn lower(source: &str) -> crate::Result<TaperedExtrusionPlan> {
    let processor = ExtrudedAreaSolidTaperedProcessor::new(IfcSchema::new());
    let mut decoder = EntityDecoder::new(source);
    let entity = decoder.decode_by_id(6)?;
    processor.lower(&entity, &mut decoder, TessellationQuality::Medium)
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
        .abs()
}

#[test]
fn square_frustum_replays_after_decoder_disposal_with_analytic_volume() {
    let plan = {
        let source = SOURCE.to_owned();
        lower(&source).unwrap()
    };
    let mesh = plan.evaluate().unwrap();
    // Height / 3 * (base area + end area + geometric mean of their areas).
    assert!((volume(&mesh) - 28.).abs() < 1e-9);
    let z: Vec<_> = mesh
        .positions
        .chunks_exact(3)
        .map(|point| point[2])
        .collect();
    assert_eq!(z.iter().copied().fold(f32::INFINITY, f32::min), 13.);
    assert_eq!(z.iter().copied().fold(f32::NEG_INFINITY, f32::max), 16.);
    let replay = plan.clone().evaluate().unwrap();
    assert_eq!(mesh.positions, replay.positions);
    assert_eq!(mesh.indices, replay.indices);
    assert_eq!(mesh.normals, replay.normals);
}

#[test]
fn absent_failed_and_unpaired_end_regions_keep_uniform_extrusion_policy() {
    for source in [
        SOURCE.replace("3.,#2)", "3.,$)"),
        SOURCE.replace(
            "#2=IFCRECTANGLEPROFILEDEF(.AREA.,$,$,2.,2.);",
            "#2=IFCRECTANGLEPROFILEDEF(.AREA.,$,$,$,$);",
        ),
        SOURCE.replace(
            "#2=IFCRECTANGLEPROFILEDEF(.AREA.,$,$,2.,2.);",
            "#2=IFCCOMPOSITEPROFILEDEF(.AREA.,$,(#1,#1),$);",
        ),
    ] {
        let plan = lower(&source).unwrap();
        let TaperedExtrusionPlan::Regions { end_regions, .. } = &plan else {
            panic!("regions")
        };
        assert!(end_regions.is_none());
        assert!((volume(&plan.evaluate().unwrap()) - 48.).abs() < 1e-9);
    }
}

#[test]
fn empty_start_short_circuits_and_invalid_direction_precedes_end_admission() {
    let source = "#1=IFCARBITRARYCLOSEDPROFILEDEF(.AREA.,$,#2);\n#2=IFCPOLYLINE(());\n\
        #6=IFCEXTRUDEDAREASOLIDTAPERED(#1,#999,$,$,#999);";
    assert!(lower(source).unwrap().evaluate().unwrap().is_empty());
    let source = SOURCE
        .replace(
            "#3=IFCDIRECTION((0.,0.,1.));",
            "#3=IFCDIRECTION((0.,0.,0.));",
        )
        .replace("3.,#2)", "3.,#999)");
    assert_eq!(
        lower(&source).unwrap_err().to_string(),
        "Geometry processing error: ExtrudedAreaSolidTapered has zero-length ExtrudedDirection"
    );
}
