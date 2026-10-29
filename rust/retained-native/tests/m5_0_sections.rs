// SPDX-License-Identifier: MPL-2.0
#![cfg(feature = "retained-runtime")]
use ifc_lite_retained_native::oracle::sections::{section_volume, ExtrudedHost};
use ifc_lite_processing::extract_analytic_quantity_sources;
const SOURCE: &str = "ISO-10303-21;HEADER;FILE_SCHEMA(('IFC4'));ENDSEC;DATA;
#1=IFCCARTESIANPOINT((0.,0.,0.));#2=IFCAXIS2PLACEMENT3D(#1,$,$);#3=IFCDIRECTION((0.,0.,1.));
#4=IFCRECTANGLEPROFILEDEF(.AREA.,$,$,2.,2.);#5=IFCEXTRUDEDAREASOLID(#4,#2,#3,1.);
#12=IFCSHAPEREPRESENTATION($,'Body','SweptSolid',(#5));#13=IFCPRODUCTDEFINITIONSHAPE($,$,(#12));
#14=IFCWALL('w',$,$,$,$,$,#13,$,$);ENDSEC;END-ISO-10303-21;";
fn host(text: &str) -> ExtrudedHost {
    let s=extract_analytic_quantity_sources(text.as_bytes(),None);
    ExtrudedHost::from_sources(&s,&s.extrusion_definitions.instances[&14][0]).unwrap()
}
fn close(actual: Option<f64>, expected: f64) {
    let actual=actual.expect("section oracle declined hand case");
    let tolerance: serde_json::Value=serde_json::from_str(include_str!("../../../tests/fixtures/cli-retained/tolerances.d/cut-0.json")).unwrap();
    let limit=tolerance["cut0SectionVolumeRelative"].as_f64().unwrap();
    if expected == 0. { assert_eq!(actual,0.); }
    else { assert!((actual-expected).abs() <= limit*expected.abs(),"{actual:.16} != {expected:.16}"); }
}
// #7955: hand integration of line-profile sections, moving halfplanes, holes.
#[test]
fn sections_boxes_oblique_extrusions_and_moving_vertices() {
    let h=host(SOURCE); close(section_volume(&h,&[]),4.);
    close(section_volume(&h,&[([1.,0.,1.],1.)]),3.); // integral 2*(2-t) dt.
    close(section_volume(&h,&[([1.,0.,0.],0.),([0.,1.,0.],0.)]),1.);
    close(section_volume(&h,&[([0.,0.,1.],0.25)]),1.);
    close(section_volume(&h,&[([1.,0.,0.],-2.)]),0.);
    let oblique=host(&SOURCE.replace("((0.,0.,1.))","((0.6,0.,0.8))"));
    close(section_volume(&oblique,&[]),3.2);
    // x<=0 leaves width (1-.6t), hence .8 * integral 2*(1-.6t) = 1.12.
    close(section_volume(&oblique,&[([1.,0.,0.],0.)]),1.12);
    assert!(section_volume(&h,&[([f64::NAN,0.,0.],0.)]).is_none());
    assert!(section_volume(&h,&[([1.,0.,0.],0.);65]).is_none());
}
#[test]
fn sections_circle_segment_and_partial_arc_green_integrals() {
    let circle=SOURCE.replace("IFCRECTANGLEPROFILEDEF(.AREA.,$,$,2.,2.)","IFCCIRCLEPROFILEDEF(.AREA.,$,$,1.)");
    let h=host(&circle);
    close(section_volume(&h,&[]),std::f64::consts::PI);
    close(section_volume(&h,&[([1.,0.,0.],0.)]),std::f64::consts::PI/2.);
    // Integral from -1 to 1/2 of 2 sqrt(1-x²) dx = 2pi/3 + sqrt(3)/4.
    close(section_volume(&h,&[([1.,0.,0.],0.5)]),2.*std::f64::consts::PI/3.+3f64.sqrt()/4.);
    // Moving x<=t: integral[0,1] (pi/2 + asin t + t sqrt(1-t²)) dt = pi - 2/3.
    close(section_volume(&h,&[([1.,0.,-1.],0.)]),std::f64::consts::PI-2./3.);
    // #7955: start at the empty tangent. A(-x)=pi-A(x), hence the integral
    // of A(t-1) over [0,1] is 2/3. Per-leaf relative convergence cannot handle
    // this t^(3/2) endpoint; convergence must compare whole refinement levels.
    close(section_volume(&h,&[([1.,0.,-1.],-1.)]),2./3.);
    let sector=SOURCE.replace("IFCRECTANGLEPROFILEDEF(.AREA.,$,$,2.,2.)","IFCARBITRARYCLOSEDPROFILEDEF(.AREA.,$,#20)")
        .replace("#12=", "#20=IFCINDEXEDPOLYCURVE(#21,(IFCARCINDEX((1,2,3)),IFCLINEINDEX((3,4,1))),.F.);\n#21=IFCCARTESIANPOINTLIST2D(((1.,0.),(0.7071067811865476,0.7071067811865476),(0.,1.),(0.,0.)));\n#12=");
    let h=host(&sector); close(section_volume(&h,&[]),std::f64::consts::PI/4.);
    // Sector clipped by x<=0.5: half of the disk strip plus triangle.
    close(section_volume(&h,&[([1.,0.,0.],0.5)]),std::f64::consts::PI/12.+3f64.sqrt()/8.);
    let ring=circle.replace("IFCCIRCLEPROFILEDEF(.AREA.,$,$,1.)","IFCARBITRARYPROFILEDEFWITHVOIDS(.AREA.,$,#20,(#21))")
        .replace("#12=","#20=IFCCIRCLE(#2,2.);#21=IFCCIRCLE(#2,1.);#12=");
    close(section_volume(&host(&ring),&[([1.,0.,0.],0.)]),1.5*std::f64::consts::PI);
}
