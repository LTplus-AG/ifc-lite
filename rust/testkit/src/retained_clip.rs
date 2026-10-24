// SPDX-License-Identifier: MPL-2.0
//! #7955 authored plane cases and independent integral/bounds oracles.
pub const SOURCE: &str = "ISO-10303-21;HEADER;FILE_SCHEMA(('IFC4'));ENDSEC;DATA;
#1=IFCPROJECT('p',$,$,$,$,$,$,(#2),#3);
#2=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-5,#5,$);
#3=IFCUNITASSIGNMENT((#6));#4=IFCCARTESIANPOINT((0.,0.,0.));
#5=IFCAXIS2PLACEMENT3D(#4,$,$);#6=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#7=IFCAXIS2PLACEMENT3D(#8,$,$);#8=IFCCARTESIANPOINT((10.,20.,30.));
#9=IFCLOCALPLACEMENT($,#7);#10=IFCWALL('w',$,'Wall',$,$,#9,#11,$,$);
#11=IFCPRODUCTDEFINITIONSHAPE($,$,(#12));#12=IFCSHAPEREPRESENTATION(#2,'Body','CSG',(#13));
#13=IFCBOOLEANRESULT(.DIFFERENCE.,#113,#203);
#113=IFCEXTRUDEDAREASOLID(#14,#5,#15,3.);#14=IFCRECTANGLEPROFILEDEF(.AREA.,$,$,2.,4.);
#15=IFCDIRECTION((0.,0.,1.));
#200=IFCCARTESIANPOINT((0.,0.,1.));#201=IFCAXIS2PLACEMENT3D(#200,#15,$);
#202=IFCPLANE(#201);#203=IFCHALFSPACESOLID(#202,.T.);
ENDSEC;END-ISO-10303-21;";
pub struct Case { pub name: &'static str, pub source: String, pub volume: f64,
    pub bounds: [f64; 6], pub centroid: [f64; 3] }
pub fn cases() -> Vec<Case> {
    let mut cases = Vec::new();
    for (name, operation, agreement, lower) in [
        ("difference_true", "DIFFERENCE", "T", false),
        ("intersection_true", "INTERSECTION", "T", true),
        ("difference_false", "DIFFERENCE", "F", true),
        ("intersection_false", "INTERSECTION", "F", false)] {
        cases.push(Case { name, source: SOURCE.replace(".DIFFERENCE.", &format!(".{operation}."))
            .replace("#202,.T.", &format!("#202,.{agreement}.")), volume: if lower {8.} else {16.},
            bounds: [-1.,-2.,if lower {0.} else {1.},1.,2.,if lower {1.} else {3.}],
            centroid: [0.,0.,if lower {0.5} else {2.}] });
    }
    let append = |text: &str, suffix: &str| text.replace("ENDSEC;END-ISO", &format!("{suffix}ENDSEC;END-ISO"));
    cases.push(Case { name: "clip_of_clip", source: append(&SOURCE.replace("#13=IFCBOOLEANRESULT", "#13=IFCBOOLEANRESULT(.INTERSECTION.,#213,#303);#213=IFCBOOLEANRESULT"),
        "#300=IFCCARTESIANPOINT((0.,0.,2.));#301=IFCAXIS2PLACEMENT3D(#300,#15,$);#302=IFCPLANE(#301);#303=IFCHALFSPACESOLID(#302,.T.);"),
        volume: 8., bounds: [-1.,-2.,1.,1.,2.,2.], centroid: [0.,0.,1.5] });
    let mapping = "#314=IFCMAPPEDITEM(#315,#316);#315=IFCREPRESENTATIONMAP(#5,#317);#316=IFCCARTESIANTRANSFORMATIONOPERATOR3DNONUNIFORM($,$,#4,2.,$,3.,1.);#317=IFCSHAPEREPRESENTATION(#2,'Body','CSG',(#113));";
    cases.push(Case { name: "mapped_input", source: append(&SOURCE.replace(".DIFFERENCE.,#113,#203", ".DIFFERENCE.,#314,#203"), mapping),
        volume: 96., bounds: [-2.,-6.,1.,2.,6.,3.], centroid: [0.,0.,2.] });
    cases.push(Case { name: "affine_of_clip", source: append(&SOURCE.replace("'CSG',(#13)", "'CSG',(#314)"), &mapping.replace("'CSG',(#113)", "'CSG',(#13)")),
        volume: 96., bounds: [-2.,-6.,1.,2.,6.,3.], centroid: [0.,0.,2.] });
    cases.push(Case { name: "clip_to_boolean", source: append(&SOURCE.replace("#13=IFCBOOLEANRESULT", "#13=IFCBOOLEANRESULT(.UNION.,#213,#114);#213=IFCBOOLEANRESULT"),
        "#114=IFCEXTRUDEDAREASOLID(#14,#5,#15,0.5);"), volume: 20., bounds: [-1.,-2.,0.,1.,2.,3.], centroid: [0.,0.,1.65] });
    cases.push(Case { name: "mapped_boolean_clip", source: append(&SOURCE.replace(".DIFFERENCE.,#113,#203", ".DIFFERENCE.,#314,#203"),
        &mapping.replace("'CSG',(#113)", "'CSG',(#513)").replace("#314=", "#513=IFCBOOLEANRESULT(.UNION.,#113,#113);#314=")),
        volume: 96., bounds: [-2.,-6.,1.,2.,6.,3.], centroid: [0.,0.,2.] });
    cases
}
/// Integrate oriented tetrahedra; bounds and centroid catch wrong side/origin
/// even when a volume-only oracle could pass. Fixed tolerances precede SDK runs.
pub fn assert_geometry(case: &Case, positions: &[f64], indices: &[u32], frame: &[f64; 16]) {
    let points: Vec<[f64;3]> = positions.chunks_exact(3).map(|p| std::array::from_fn(|r|
        frame[r]*p[0]+frame[4+r]*p[1]+frame[8+r]*p[2]+frame[12+r])).collect();
    let mut bounds = [f64::INFINITY,f64::INFINITY,f64::INFINITY,f64::NEG_INFINITY,f64::NEG_INFINITY,f64::NEG_INFINITY];
    for p in &points { for j in 0..3 { bounds[j]=bounds[j].min(p[j]); bounds[3+j]=bounds[3+j].max(p[j]); } }
    let mut volume = 0.; let mut moment = [0.;3];
    for t in indices.chunks_exact(3) {
        let [a,b,c] = [points[t[0] as usize],points[t[1] as usize],points[t[2] as usize]];
        let v=(a[0]*(b[1]*c[2]-b[2]*c[1])+a[1]*(b[2]*c[0]-b[0]*c[2])+a[2]*(b[0]*c[1]-b[1]*c[0]))/6.;
        volume+=v; for j in 0..3 { moment[j]+=v*(a[j]+b[j]+c[j])/4.; }
    }
    assert!((volume.abs()-case.volume).abs() <= 1e-6, "{} volume {volume}",case.name);
    for j in 0..6 { assert!((bounds[j]-case.bounds[j]).abs() <= 1e-6,"{} bounds {bounds:?}",case.name); }
    for j in 0..3 { assert!((moment[j]/volume-case.centroid[j]).abs() <= 1e-6,"{} centroid {:?}",case.name,moment.map(|x|x/volume)); }
}
