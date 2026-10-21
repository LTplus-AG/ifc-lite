// SPDX-License-Identifier: MPL-2.0
//! Selected-instance lowering parity for the initial ten built-in constructors.
//! The other nine are exercised by construction::family_tests. Each owned
//! evaluation outlives its source; direct process is the compatibility oracle.
use crate::{GeometryProcessor, Mesh, TessellationQuality};
use crate::processors::*;
use ifc_lite_core::{EntityDecoder, IfcSchema};

// #7880: extrusion keeps +Z (#6); revolution uses a separate XY axis (#16).
// Its line at X=-3 lies outside the centered 2x2 profile (#5), avoiding an
// axis-crossing sweep while retaining all ten nonempty construction controls.
const SOURCE: &str = "#1=IFCCARTESIANPOINT((0.,0.,0.));
#2=IFCCARTESIANPOINT((0.,0.,4.));
#3=IFCPOLYLINE((#1,#2));
#4=IFCRECTANGLEPROFILEDEF(.AREA.,$,$,4.,4.);
#5=IFCRECTANGLEPROFILEDEF(.AREA.,$,$,2.,2.);
#6=IFCDIRECTION((0.,0.,1.));
#7=IFCAXIS1PLACEMENT(#17,#16);
#8=IFCCARTESIANPOINT((4.,0.,0.));
#9=IFCCARTESIANPOINT((0.,4.,0.));
#10=IFCPOLYLOOP((#1,#8,#9));
#11=IFCFACEOUTERBOUND(#10,.T.);
#12=IFCFACE((#11));
#13=IFCCLOSEDSHELL((#12));
#14=IFCCARTESIANPOINTLIST3D(((0.,0.,0.),(4.,0.,0.),(0.,4.,0.)));
#15=IFCINDEXEDPOLYGONALFACE((1,2,3));
#16=IFCDIRECTION((0.,1.,0.));
#17=IFCCARTESIANPOINT((-3.,0.,0.));
#100=IFCEXTRUDEDAREASOLID(#4,$,#6,3.);
#101=IFCEXTRUDEDAREASOLIDTAPERED(#4,$,#6,3.,#5);
#102=IFCREVOLVEDAREASOLID(#5,$,#7,3.141592653589793);
#103=IFCSWEPTDISKSOLID(#3,2.,1.,$,$);
#104=IFCSURFACECURVESWEPTAREASOLID(#5,$,#3,$,$,$);
#105=IFCBLOCK($,2.,3.,4.);
#106=IFCSPHERE($,2.);
#107=IFCTRIANGULATEDFACESET(#14,$,.F.,((1,2,3)),$);
#108=IFCPOLYGONALFACESET(#14,.F.,(#15),$);
#109=IFCFACETEDBREP(#13);";

fn same_mesh(actual: &Mesh, expected: &Mesh) {
    assert_eq!(actual.positions, expected.positions);
    assert_eq!(actual.indices, expected.indices);
    assert_eq!(actual.normals, expected.normals);
    assert_eq!(actual.rtc_applied, expected.rtc_applied);
    assert_eq!(actual.origin, expected.origin);
    assert_eq!(actual.local_bounds, expected.local_bounds);
}

#[test]
fn selected_constructor_payloads_match_production_after_source_disposal() {
    let schema = IfcSchema::new();
    let processors: [Box<dyn GeometryProcessor>; 10] = [
        Box::new(ExtrudedAreaSolidProcessor::new(schema.clone())),
        Box::new(ExtrudedAreaSolidTaperedProcessor::new(schema.clone())),
        Box::new(RevolvedAreaSolidProcessor::new(schema.clone())),
        Box::new(SweptDiskSolidProcessor::new(schema.clone())),
        Box::new(SurfaceCurveSweptAreaSolidProcessor::new(schema.clone())),
        Box::new(BlockProcessor::new()), Box::new(SphereProcessor::new()),
        Box::new(TriangulatedFaceSetProcessor::new()), Box::new(PolygonalFaceSetProcessor::new()),
        Box::new(FacetedBrepProcessor::new()),
    ];
    for (id, processor) in (100..=109).zip(processors) {
        let (plan, expected) = {
            let source = SOURCE.to_owned();
            let mut decoder = EntityDecoder::new(&source);
            let item = decoder.decode_by_id(id).unwrap();
            let expected = processor.process(&item, &mut decoder, &schema, TessellationQuality::Medium).unwrap();
            let plan = processor.lower_owned(&item, &mut decoder, TessellationQuality::Medium, None)
                .expect("actual selected builtin admission").unwrap();
            (plan, expected)
        };
        assert!(!expected.is_empty(), "#{id} must exercise real construction");
        same_mesh(&plan.evaluate().unwrap(), &expected);
    }
}

#[test]
fn raw_constructor_rtc_admission_retains_f64_sub_ulp_detail() {
    let source = "#1=IFCCARTESIANPOINTLIST3D(((5000000.,5000000.,0.),
        (5000000.125,5000000.,0.),(5000000.,5000000.125,0.)));
        #2=IFCTRIANGULATEDFACESET(#1,$,.F.,((1,2,3)),$);";
    let plan = {
        let mut decoder = EntityDecoder::new(source);
        let item = decoder.decode_by_id(2).unwrap();
        TriangulatedFaceSetProcessor::new().lower_owned(&item, &mut decoder,
            TessellationQuality::Medium, Some((5_000_000., 5_000_000., 0.))).unwrap().unwrap()
    };
    let mesh = plan.evaluate().unwrap();
    assert!(mesh.rtc_applied);
    let max = mesh.positions.iter().copied().fold(f32::NEG_INFINITY, f32::max);
    assert_eq!(max, 0.125, "RTC subtraction precedes f32 narrowing");
    assert_eq!(mesh.indices.len(), 3);
}
