// SPDX-License-Identifier: MPL-2.0
//! The remaining registered constructors replay through their production seam.
use super::*;
use crate::{GeometryProcessor, GeometryRouter, TessellationQuality};
use crate::processors::*;
use ifc_lite_core::{EntityDecoder, IfcSchema};

const SOURCE: &str = "#1=IFCCARTESIANPOINT((0.,0.,0.));
#2=IFCCARTESIANPOINT((4.,0.,0.));
#3=IFCCARTESIANPOINT((0.,4.,0.));
#4=IFCCARTESIANPOINT((4.,4.,0.));
#5=IFCAXIS2PLACEMENT3D(#1,$,$);
#6=IFCPLANE(#5);
#7=IFCPOLYLOOP((#1,#2,#3));
#8=IFCFACEOUTERBOUND(#7,.T.);
#9=IFCFACE((#8));
#10=IFCADVANCEDFACE((#8),#6,.T.);
#11=IFCCLOSEDSHELL((#9));
#12=IFCCLOSEDSHELL((#10));
#13=IFCVERTEXPOINT(#1);
#14=IFCVERTEXPOINT(#2);
#15=IFCPOLYLINE((#1,#2));
#16=IFCRECTANGLEPROFILEDEF(.AREA.,$,$,2.,1.);
#17=IFCDISTANCEEXPRESSION(0.,0.,0.,0.,.T.);
#18=IFCDISTANCEEXPRESSION(4.,0.,0.,0.,.T.);
#19=IFCARBITRARYOPENPROFILEDEF(.CURVE.,$,#15);
#20=IFCDIRECTION((0.,0.,1.));
#100=IFCSECTIONEDSOLIDHORIZONTAL(#15,(#16,#16),(#17,#18));
#101=IFCADVANCEDBREP(#12);
#102=IFCBSPLINESURFACEWITHKNOTS(1,1,((#1,#3),(#2,#4)),.UNSPECIFIED.,.F.,.F.,.F.,(2,2),(2,2),(0.,1.),(0.,1.),.UNSPECIFIED.);
#103=IFCSHELLBASEDSURFACEMODEL((#11));
#104=IFCFACEBASEDSURFACEMODEL((#11));
#105=IFCALIGNMENT('id',$,$,$,$,$,#15,$,$);
#106=IFCEDGE(#13,#14);
#107=IFCFACESURFACE((#8),#6,.T.);
#108=IFCSURFACEOFLINEAREXTRUSION(#19,#5,#20,3.);";

#[test]
fn registered_family_plans_replay_after_disposal_through_production_builders() {
    let schema = IfcSchema::new();
    let processors: [(ConstructionFamily, Box<dyn GeometryProcessor>); 9] = [
        (ConstructionFamily::SectionedSolid, Box::new(SectionedSolidHorizontalProcessor::new(schema.clone()))),
        (ConstructionFamily::AdvancedBrep, Box::new(AdvancedBrepProcessor::new())),
        (ConstructionFamily::BSplineSurface, Box::new(BSplineSurfaceProcessor::new())),
        (ConstructionFamily::ShellSurfaceModel, Box::new(ShellBasedSurfaceModelProcessor::new())),
        (ConstructionFamily::FaceSurfaceModel, Box::new(FaceBasedSurfaceModelProcessor::new())),
        (ConstructionFamily::Alignment, Box::new(IfcAlignmentProcessor::new())),
        (ConstructionFamily::Edge, Box::new(IfcEdgeProcessor::new())),
        (ConstructionFamily::FaceSurface, Box::new(IfcFaceSurfaceProcessor::new())),
        (ConstructionFamily::LinearExtrusionSurface, Box::new(SurfaceOfLinearExtrusionProcessor::new())),
    ];
    let roots: Vec<_> = (100..=108).chain([100, 108]).collect();
    let batch = {
        let source = SOURCE.to_owned();
        GeometryRouter::new().plan_construction_items(&mut EntityDecoder::new(&source), &roots, roots.len()).unwrap()
    };
    assert_eq!(batch.nodes().len(), 9);
    assert_eq!(batch.occurrences(), &[0, 1, 2, 3, 4, 5, 6, 7, 8, 0, 8]);
    for (node, (family, _)) in batch.nodes().iter().zip(&processors) {
        assert_eq!(node.family(), Some(*family));
        assert_eq!(node.requirement(), None, "{:?}", node.requirement());
    }
    let evaluation = batch.evaluate().unwrap();
    for ((family, processor), (id, actual)) in processors.into_iter().zip((100..=108).zip(evaluation.definitions)) {
        let mut decoder = EntityDecoder::new(SOURCE);
        let entity = decoder.decode_by_id(id).unwrap();
        let expected = processor.process(&entity, &mut decoder, &schema, TessellationQuality::Medium).unwrap();
        // ProductProgram phase: the selected instance admits the common payload;
        // numerical replay outlives the source and agrees with direct production.
        let plan = processor.lower_owned(&entity, &mut decoder, TessellationQuality::Medium, None)
            .expect("registered builtin lowering").unwrap();
        drop(decoder);
        let owned = plan.evaluate().unwrap();
        assert_eq!(owned.positions, expected.positions, "{family:?} selected owned positions");
        assert_eq!(owned.indices, expected.indices, "{family:?} selected owned indices");
        assert_eq!(owned.normals, expected.normals, "{family:?} selected owned normals");
        assert!(!actual.is_empty(), "{family:?} must exercise its builder");
        assert_eq!(actual.positions, expected.positions, "{family:?} positions");
        assert_eq!(actual.indices, expected.indices, "{family:?} indices");
        assert_eq!(actual.normals, expected.normals, "{family:?} normals");
        assert!(!actual.rtc_applied, "raw construction keeps file units without router RTC");
    }
}
