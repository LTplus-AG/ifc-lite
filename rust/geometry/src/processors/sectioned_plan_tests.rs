// SPDX-License-Identifier: MPL-2.0
//! Decoder-free sectioned construction and admission invariants.
use super::SectionedPlan;
use crate::processors::SectionedSolidHorizontalProcessor;
use crate::{Mesh, TessellationQuality};
use ifc_lite_core::{EntityDecoder, IfcSchema};

const DATA: &str = "#1=IFCCARTESIANPOINT((0.,0.));
#2=IFCAXIS2PLACEMENT2D(#1,$);
#3=IFCRECTANGLEHOLLOWPROFILEDEF(.AREA.,$,#2,2.,1.,0.25,$,$);
#40=IFCCARTESIANPOINT((0.,0.,0.));
#41=IFCCARTESIANPOINT((0.,20.,0.));
#42=IFCPOLYLINE((#40,#41));
#43=IFCDISTANCEEXPRESSION(0.,0.,0.,0.,.T.);
#44=IFCDISTANCEEXPRESSION(20.,0.,0.,0.,.T.);";

fn lower(source: &str) -> crate::Result<SectionedPlan> {
    let mut decoder = EntityDecoder::new(source);
    let entity = decoder.decode_by_id(45)?;
    SectionedSolidHorizontalProcessor::new(IfcSchema::new()).lower(
        &entity,
        &mut decoder,
        TessellationQuality::Medium,
    )
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
fn hollow_sectioned_plan_replays_after_source_disposal_and_sorts_stations() {
    let plan = {
        let source = format!("{DATA}\n#45=IFCSECTIONEDSOLIDHORIZONTAL(#42,(#3,#3),(#44,#43));");
        lower(&source).unwrap()
    };
    let mesh = plan.evaluate().unwrap();
    // The 2x1 outer rectangle minus its 1.5x0.5 void, along twenty file units.
    assert!((volume(&mesh) - 25.).abs() < 1e-10);
    assert_eq!(plan.sections.len(), 2);
    assert_eq!(plan.sections[0][0].holes.len(), 1);
    let replay = plan.clone().evaluate().unwrap();
    assert_eq!(mesh.positions, replay.positions);
    assert_eq!(mesh.indices, replay.indices);
    assert_eq!(mesh.normals, replay.normals);
}

#[test]
fn section_list_mismatch_is_refused_before_dangling_directrix() {
    let source = "#45=IFCSECTIONEDSOLIDHORIZONTAL(#999,(#3,#3),(#43));";
    let error = lower(source).unwrap_err().to_string();
    assert!(error.contains("must have equal length"), "{error}");
}
