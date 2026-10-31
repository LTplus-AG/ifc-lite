// SPDX-License-Identifier: MPL-2.0
#![cfg(feature = "retained-runtime")]
//! #7955 hand-integrated oracles, independent of any kernel or retained cutter.
use ifc_lite_retained_native::oracle::bounded;
const SOURCE:&[u8]=include_bytes!("../../../tests/fixtures/synthetic-retained/f-f-halfspaces.ifc");
#[test]
fn m6_7955_mapped_pbhs_products_are_checked() {
    let bytes=include_bytes!("../../../tests/fixtures/synthetic-retained/f-e-mapped-booleans.ifc");
    let sources=ifc_lite_processing::extract_analytic_quantity_sources(bytes,None);
    for id in [173,231] {
        assert!(bounded::applies(bytes,id),"#{id}: mapped PBHS must be detected");
        let e=bounded::expected(bytes,&sources,id).expect("mapped source expectation");
        assert!((e.section_volume.unwrap()-3.).abs()<1e-12,"#{id}");
        assert!(e.removed_clearance([1.,0.5,1.])>0.4,"#{id}: removed side");
        assert_eq!(e.removed_clearance([1.,0.5,2.]),0.,"#{id}: kept side");
    }
}
#[test]
fn m6_section_partition_matches_hand_integrals_and_overlap() {
    let sources=ifc_lite_processing::extract_analytic_quantity_sources(SOURCE,None);
    let pins:serde_json::Value=serde_json::from_str(include_str!("../../../tests/fixtures/cli-retained/expected.d/m6-halfspaces.json")).unwrap();
    for id in [1000,1001,1002,1003,1007,1008,1009,1010,1011,1014,1015] {
        let expected=bounded::expected(SOURCE,&sources,id).unwrap_or_else(||panic!("source oracle #{id}"));
        let volume=expected.section_volume.unwrap_or_else(||panic!("section #{id}"));
        let hand=if id==1011{0.}else{pins["rows"][(id-1000) as usize]["volume"].as_f64().unwrap()};
        assert!((volume-hand).abs()<=1e-10*hand.abs().max(1.),"#{id}: {volume} vs {hand}");
        assert!((expected.host_volume-64.).abs()<1e-12);
    }
}
#[test]
fn m6_outside_material_uses_original_boundary_not_partition_edges() {
    let sources=ifc_lite_processing::extract_analytic_quantity_sources(SOURCE,None);
    let e=bounded::expected(SOURCE,&sources,1000).unwrap();
    assert!(e.removed_clearance([1.5,1.5,3.])>0.4,"internal triangle diagonal is material");
    assert_eq!(e.removed_clearance([3.,1.5,3.]),0.);
    assert_eq!(e.removed_clearance([1.5,1.5,2.]),0.);
    assert_eq!(e.removed_clearance([0.5,1.5,3.]),0.);
    let e=bounded::expected(SOURCE,&sources,1002).unwrap();
    assert_eq!(e.removed_clearance([1.5,1.5,3.9]),0.,"L notch is outside");
    assert!(e.removed_clearance([0.5,1.5,3.9])>0.4);
    let arc=bounded::expected(SOURCE,&sources,1005).unwrap();
    assert!(arc.curved);assert!(arc.removed_clearance([0.5,0.5,3.])>0.4);
    assert_eq!(arc.removed_clearance([1.5,1.5,3.]),0.);
}

#[test]
fn m6_circle_boundary_clearance_remains_analytic() {
    let text=std::str::from_utf8(SOURCE).unwrap().replace("#36=IFCINDEXEDPOLYCURVE(#35,(IFCARCINDEX((1,2,3)),IFCLINEINDEX((3,4,1))),.F.);","#36=IFCCIRCLE(#9036,0.5);\n#9036=IFCAXIS2PLACEMENT2D(#9037,$);\n#9037=IFCCARTESIANPOINT((1.,1.));");
    let sources=ifc_lite_processing::extract_analytic_quantity_sources(text.as_bytes(),None);
    let e=bounded::expected(text.as_bytes(),&sources,1005).unwrap();
    assert!(e.curved);assert!((e.section_volume.unwrap()-(64.-std::f64::consts::FRAC_PI_2)).abs()<1e-10,"independent circular removed-volume integral");
    assert!((e.removed_clearance([1.,1.,3.])-0.5).abs()<1e-12);
    assert_eq!(e.removed_clearance([1.6,1.,3.]),0.);
}

// #7955: an arc in the host profile (ISSUE_129's curved walls) is tessellated
// chordally, so the section volume is judged against the curved tolerance.
#[test]
fn m6_curved_host_profile_marks_the_expectation_curved() {
    let text=std::str::from_utf8(SOURCE).unwrap().replace("#11=IFCRECTANGLEPROFILEDEF(.AREA.,$,#10,4.,4.);",
        "#11=IFCARBITRARYCLOSEDPROFILEDEF(.AREA.,$,#9100);\n\
#9100=IFCCOMPOSITECURVE((#9101,#9102),.F.);\n\
#9101=IFCCOMPOSITECURVESEGMENT(.CONTINUOUS.,.T.,#9103);\n#9102=IFCCOMPOSITECURVESEGMENT(.CONTINUOUS.,.T.,#9104);\n\
#9103=IFCPOLYLINE((#9105,#9106,#9107,#9108));\n\
#9104=IFCTRIMMEDCURVE(#9109,(IFCPARAMETERVALUE(2.5535900500422257)),(IFCPARAMETERVALUE(3.7295952571373605)),.T.,.PARAMETER.);\n\
#9105=IFCCARTESIANPOINT((0.,0.));\n#9106=IFCCARTESIANPOINT((4.,0.));\n#9107=IFCCARTESIANPOINT((4.,4.));\n#9108=IFCCARTESIANPOINT((0.,4.));\n\
#9109=IFCCIRCLE(#9110,3.605551275463989);\n#9110=IFCAXIS2PLACEMENT2D(#9111,$);\n#9111=IFCCARTESIANPOINT((3.,2.));");
    assert!(text.contains("#9109="),"host profile replaced");
    let sources=ifc_lite_processing::extract_analytic_quantity_sources(text.as_bytes(),None);
    let e=bounded::expected(text.as_bytes(),&sources,1000).expect("curved host expectation");
    // The bulge west of x=0 adds a circular segment to the 4 m square host.
    let (r,half)=(13f64.sqrt(),(2f64/3.).atan());
    assert!((e.host_volume-4.*(16.+r*r*(half-half.sin()*half.cos()))).abs()<1e-9,"host {}",e.host_volume);
    assert!(e.curved,"a host arc is curved even though the boundary is a polyline");
    let rectangle=bounded::expected(SOURCE,&sources_of(SOURCE),1000).unwrap();
    assert!(!rectangle.curved,"the rectangular host stays linear");
}
fn sources_of(bytes:&[u8])->ifc_lite_processing::AnalyticQuantitySources { ifc_lite_processing::extract_analytic_quantity_sources(bytes,None) }

#[test]
fn m6_fzk_sections_are_available_for_both_bounded_chains() {
    let Some(bytes)=ifc_lite_testkit::fixture_bytes("ara3d/AC20-FZK-Haus.ifc") else {return;};
    let sources=ifc_lite_processing::extract_analytic_quantity_sources(&bytes,None);
    for id in [60012,67828] {
        let e=bounded::expected(&bytes,&sources,id).expect("FZK source oracle");
        assert!(e.section_volume.is_some(),"#{id}: {:?}",e.section_unavailable);
        println!("M6 FZK #{id} source section: {:?}",e.section_volume);
    }
}

#[test]
fn m6_7955_mapped_pbhs_applies_rotation_translation_and_scale() {
    let mut text=include_str!("../../../tests/fixtures/synthetic-retained/f-e-mapped-booleans.ifc").to_owned();
    for (x,y,p,op) in [(166,167,168,169),(224,225,226,227)] {
        text=text.replace(&format!("#{x}=IFCDIRECTION((1.,0.,0.));"),&format!("#{x}=IFCDIRECTION((0.,1.,0.));"))
            .replace(&format!("#{y}=IFCDIRECTION((-0.,1.,0.));"),&format!("#{y}=IFCDIRECTION((-1.,0.,0.));"))
            .replace(&format!("#{p}=IFCCARTESIANPOINT((0.,0.,0.));"),&format!("#{p}=IFCCARTESIANPOINT((10.,20.,30.));"))
            .replace(&format!("#{op}=IFCCARTESIANTRANSFORMATIONOPERATOR3D(#{x},#{y},#{p},1.,#3);"),
                &format!("#{op}=IFCCARTESIANTRANSFORMATIONOPERATOR3D(#{x},#{y},#{p},2.,#3);"));
    }
    let sources=ifc_lite_processing::extract_analytic_quantity_sources(text.as_bytes(),None);
    for id in [173,231] {
        assert!(bounded::applies(text.as_bytes(),id));
        let e=bounded::expected(text.as_bytes(),&sources,id).unwrap();
        assert!((e.section_volume.unwrap()-24.).abs()<1e-10,"#{id}");
        assert!(e.removed_clearance([9.,22.,32.])>0.8,"#{id}: transformed cut");
        assert_eq!(e.removed_clearance([9.,22.,34.]),0.,"#{id}: transformed kept side");
    }
}
