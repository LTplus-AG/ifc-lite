// SPDX-License-Identifier: MPL-2.0
//! Construction invariants for owned production extrusion plans.

use super::ExtrusionPlan;
use crate::processors::ExtrudedAreaSolidProcessor;
use crate::{GeometryProcessor, Mesh, TessellationQuality};
use ifc_lite_core::{EntityDecoder, IfcSchema};

const HOLED: &str = "\
#1=IFCCARTESIANPOINT((-2.,-2.));\n#2=IFCCARTESIANPOINT((2.,-2.));\n\
#3=IFCCARTESIANPOINT((2.,2.));\n#4=IFCCARTESIANPOINT((-2.,2.));\n\
#5=IFCPOLYLINE((#1,#2,#3,#4,#1));\n\
#6=IFCCARTESIANPOINT((-1.,-1.));\n#7=IFCCARTESIANPOINT((-1.,1.));\n\
#8=IFCCARTESIANPOINT((1.,1.));\n#9=IFCCARTESIANPOINT((1.,-1.));\n\
#10=IFCPOLYLINE((#6,#7,#8,#9,#6));\n\
#11=IFCARBITRARYPROFILEDEFWITHVOIDS(.AREA.,$,#5,(#10));\n\
#12=IFCDIRECTION((0.,3.,4.));\n#13=IFCCARTESIANPOINT((7.,11.,13.));\n\
#14=IFCAXIS2PLACEMENT3D(#13,$,$);\n#15=IFCEXTRUDEDAREASOLID(#11,#14,#12,5.);";

fn owned_plan(content: &str) -> crate::Result<ExtrusionPlan> {
    let schema = IfcSchema::new();
    let processor = ExtrudedAreaSolidProcessor::new(schema);
    let mut decoder = EntityDecoder::new(content);
    let entity = decoder.decode_by_id(15)?;
    processor.lower(&entity, &mut decoder, TessellationQuality::Medium)
}

fn bounds(mesh: &Mesh) -> ([f32; 3], [f32; 3]) {
    let mut minimum = [f32::INFINITY; 3];
    let mut maximum = [f32::NEG_INFINITY; 3];
    for point in mesh.positions.chunks_exact(3) {
        for axis in 0..3 {
            minimum[axis] = minimum[axis].min(point[axis]);
            maximum[axis] = maximum[axis].max(point[axis]);
        }
    }
    (minimum, maximum)
}

fn signed_volume(mesh: &Mesh) -> f64 {
    mesh.indices
        .chunks_exact(3)
        .map(|triangle| {
            let point = |index: u32| {
                let index = index as usize * 3;
                nalgebra::Vector3::new(
                    mesh.positions[index] as f64,
                    mesh.positions[index + 1] as f64,
                    mesh.positions[index + 2] as f64,
                )
            };
            point(triangle[0]).dot(&point(triangle[1]).cross(&point(triangle[2]))) / 6.0
        })
        .sum()
}

#[test]
fn owned_oblique_holed_plan_replays_without_source_or_decoder() {
    // The owned String, decoder and processor all die before replay.
    let plan = {
        let source = HOLED.to_owned();
        owned_plan(&source).unwrap()
    };
    let ExtrusionPlan::Regions {
        source_id,
        profile_id,
        regions,
        direction,
        depth,
        position,
    } = &plan
    else {
        panic!("nonempty holed source must have regions")
    };
    assert_eq!((*source_id, *profile_id), (15, 11));
    assert_eq!(regions.len(), 1);
    assert_eq!(
        regions[0].outer.len(),
        5,
        "retain authored closing point through production profile admission"
    );
    assert_eq!(regions[0].holes.len(), 1);
    assert_eq!(*direction, nalgebra::Vector3::new(0., 3., 4.));
    assert_eq!(*depth, 5.);
    assert_eq!(position.unwrap()[(2, 3)], 13.);
    let mesh = plan.evaluate().unwrap();
    // Area 16 - 4, vertical height 5 * (4 / 5); shear shifts top by +3 Y.
    assert_eq!(bounds(&mesh), ([5., 9., 13.], [9., 16., 17.]));
    assert!((signed_volume(&mesh).abs() - 48.).abs() < 1e-9);
    let replay = plan.clone().evaluate().unwrap();
    assert_eq!(mesh.positions, replay.positions);
    assert_eq!(mesh.indices, replay.indices);
    assert_eq!(mesh.normals, replay.normals);
}

#[test]
fn empty_profile_short_circuits_unreadable_parameters() {
    let source = "#5=IFCPOLYLINE(());\n\
        #11=IFCARBITRARYCLOSEDPROFILEDEF(.AREA.,$,#5);\n\
        #15=IFCEXTRUDEDAREASOLID(#11,#999,$,$);";
    let plan = owned_plan(source).unwrap();
    assert!(matches!(
        plan,
        ExtrusionPlan::Empty {
            source_id: 15,
            profile_id: 11
        }
    ));
    assert!(plan.evaluate().unwrap().is_empty());
}

#[test]
fn disjoint_composite_regions_replay_as_separate_areas_with_their_holes() {
    let source = HOLED.replace(
        "#15=IFCEXTRUDEDAREASOLID(#11,#14,#12,5.);",
        "#20=IFCCARTESIANPOINT((20.,0.));\n#21=IFCAXIS2PLACEMENT2D(#20,$);\n\
         #22=IFCRECTANGLEPROFILEDEF(.AREA.,$,#21,2.,2.);\n\
         #23=IFCCOMPOSITEPROFILEDEF(.AREA.,$,(#11,#22),$);\n\
         #15=IFCEXTRUDEDAREASOLID(#23,#14,#12,5.);",
    );
    let plan = owned_plan(&source).unwrap();
    let ExtrusionPlan::Regions {
        profile_id,
        regions,
        ..
    } = &plan
    else {
        panic!("regions")
    };
    assert_eq!(*profile_id, 23);
    assert_eq!(regions.len(), 2);
    assert_eq!(regions[0].holes.len(), 1);
    assert!(regions[1].holes.is_empty());
    let mesh = plan.evaluate().unwrap();
    assert_eq!(bounds(&mesh), ([5., 9., 13.], [28., 16., 17.]));
    assert!((signed_volume(&mesh).abs() - 64.).abs() < 1e-9);
}

#[test]
fn malformed_direction_is_refused_before_missing_depth_and_bad_position() {
    let source = HOLED
        .replace(
            "#12=IFCDIRECTION((0.,3.,4.));",
            "#12=IFCDIRECTION((0.,0.,0.));",
        )
        .replace(
            "#15=IFCEXTRUDEDAREASOLID(#11,#14,#12,5.);",
            "#15=IFCEXTRUDEDAREASOLID(#11,#999,#12,$);",
        );
    let error = owned_plan(&source).unwrap_err();
    assert_eq!(
        error.to_string(),
        "Geometry processing error: ExtrudedAreaSolid has zero-length ExtrudedDirection"
    );
    let source = source.replace(
        "#12=IFCDIRECTION((0.,0.,0.));",
        "#12=IFCCARTESIANPOINT((0.,0.,0.));",
    );
    assert_eq!(
        owned_plan(&source).unwrap_err().to_string(),
        "Geometry processing error: Expected IfcDirection, got IfcCartesianPoint"
    );
}

#[test]
fn production_direction_defaults_and_missing_position_remain_admitted() {
    let source = HOLED
        .replace(
            "#12=IFCDIRECTION((0.,3.,4.));",
            "#12=IFCDIRECTION((0.,0.));",
        )
        .replace(
            "#15=IFCEXTRUDEDAREASOLID(#11,#14,#12,5.);",
            "#15=IFCEXTRUDEDAREASOLID(#11,$,#12,5.);",
        );
    let plan = owned_plan(&source).unwrap();
    let ExtrusionPlan::Regions {
        direction,
        position,
        ..
    } = &plan
    else {
        panic!("regions")
    };
    assert_eq!(*direction, nalgebra::Vector3::new(0., 0., 1.));
    assert!(position.is_none());
    let mesh = plan.evaluate().unwrap();
    assert_eq!(bounds(&mesh), ([-2., -2., 0.], [2., 2., 5.]));
    assert!((signed_volume(&mesh).abs() - 60.).abs() < 1e-9);
}

#[test]
fn production_processor_uses_owned_construction_for_holed_solid() {
    let schema = IfcSchema::new();
    let processor = ExtrudedAreaSolidProcessor::new(schema.clone());
    let mut decoder = EntityDecoder::new(HOLED);
    let entity = decoder.decode_by_id(15).unwrap();
    let mesh = processor
        .process(&entity, &mut decoder, &schema, TessellationQuality::Medium)
        .unwrap();
    assert_eq!(bounds(&mesh), ([5., 9., 13.], [9., 16., 17.]));
    assert!((signed_volume(&mesh).abs() - 48.).abs() < 1e-9);
}
