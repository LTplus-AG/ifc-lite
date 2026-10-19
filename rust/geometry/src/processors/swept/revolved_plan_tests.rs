// SPDX-License-Identifier: MPL-2.0
//! Decoder-free revolution replay and independent geometry/admission invariants.

use super::RevolvedPlan;
use crate::{processors::RevolvedAreaSolidProcessor, Mesh, TessellationQuality};
use ifc_lite_core::{EntityDecoder, IfcSchema};

const SOURCE: &str = "#1=IFCCARTESIANPOINT((2.,-1.));\n#2=IFCCARTESIANPOINT((4.,-1.));\n\
    #3=IFCCARTESIANPOINT((4.,1.));\n#4=IFCCARTESIANPOINT((2.,1.));\n\
    #5=IFCPOLYLINE((#1,#2,#3,#4,#1));\n\
    #6=IFCCARTESIANPOINT((2.5,-0.5));\n#7=IFCCARTESIANPOINT((2.5,0.5));\n\
    #8=IFCCARTESIANPOINT((3.5,0.5));\n#9=IFCCARTESIANPOINT((3.5,-0.5));\n\
    #10=IFCPOLYLINE((#6,#7,#8,#9,#6));\n\
    #11=IFCARBITRARYPROFILEDEFWITHVOIDS(.AREA.,$,#5,(#10));\n\
    #12=IFCCARTESIANPOINT((0.,0.,0.));\n#13=IFCDIRECTION((0.,1.,0.));\n\
    #14=IFCAXIS1PLACEMENT(#12,#13);\n#15=IFCREVOLVEDAREASOLID(#11,$,#14,6.283185307179586);";

fn lower(source: &str) -> crate::Result<RevolvedPlan> {
    let processor = RevolvedAreaSolidProcessor::new(IfcSchema::new());
    let mut decoder = EntityDecoder::new(source);
    let entity = decoder.decode_by_id(15)?;
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
fn holed_revolution_replays_after_source_disposal_and_keeps_enclosed_void() {
    let plan = {
        let source = SOURCE.to_owned();
        lower(&source).unwrap()
    };
    let mesh = plan.evaluate().unwrap();
    // Pappus: net profile area 4 - 1, centroid radius 3, one full turn.
    let expected = 18. * std::f64::consts::PI;
    assert!((volume(&mesh) - expected).abs() / expected < 0.02);
    assert!(
        volume(&mesh) < 20. * std::f64::consts::PI,
        "the internal profile hole must not become filled material"
    );
    let replay = plan.clone().evaluate().unwrap();
    assert_eq!(mesh.positions, replay.positions);
    assert_eq!(mesh.indices, replay.indices);
    assert_eq!(mesh.normals, replay.normals);
}

#[test]
fn partial_revolution_keeps_caps_and_authored_axis_location() {
    let source = SOURCE.replace("6.283185307179586)", "1.5707963267948966)");
    let mesh = lower(&source).unwrap().evaluate().unwrap();
    let expected = 4.5 * std::f64::consts::PI;
    assert!((volume(&mesh) - expected).abs() / expected < 0.02);
    assert!(mesh
        .positions
        .chunks_exact(3)
        .all(|point| point[0] >= -1e-6 && point[2] <= 1e-6));
}

#[test]
fn empty_profile_defers_axis_data_but_still_requires_axis_reference_and_angle() {
    let source = "#5=IFCPOLYLINE(());\n#11=IFCARBITRARYCLOSEDPROFILEDEF(.AREA.,$,#5);\n\
        #14=IFCAXIS1PLACEMENT();\n#15=IFCREVOLVEDAREASOLID(#11,$,#14,1.);";
    assert!(lower(source).unwrap().evaluate().unwrap().is_empty());
    let missing_angle = source.replace("#14,1.)", "#14,$)");
    assert_eq!(
        lower(&missing_angle).unwrap_err().to_string(),
        "Geometry processing error: RevolvedAreaSolid missing Angle"
    );
    let nonempty = SOURCE.replace(
        "#14=IFCAXIS1PLACEMENT(#12,#13);",
        "#14=IFCAXIS1PLACEMENT();",
    );
    assert_eq!(
        lower(&nonempty).unwrap_err().to_string(),
        "Geometry processing error: Axis1Placement missing Location"
    );
}

#[test]
fn positional_axis_leniency_is_preserved_without_new_type_owner_assertions() {
    // The production decoder historically reads this positional layout without
    // requiring Axis1Placement's entity type. Keep that malformed-input policy.
    let source = SOURCE.replace(
        "#14=IFCAXIS1PLACEMENT(#12,#13);",
        "#14=IFCAXIS2PLACEMENT3D(#12,#13,$);",
    );
    let mesh = lower(&source).unwrap().evaluate().unwrap();
    assert!((volume(&mesh) - 18. * std::f64::consts::PI).abs() < 1.);
}
