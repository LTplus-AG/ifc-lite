// SPDX-License-Identifier: MPL-2.0
//! #7955: hand integrals and source constraints, without a retained run.
use ifc_lite_core::SourceBundle;
use ifc_lite_retained_native::oracle::clips::{self, ClipExpectation};
#[path = "../../geometry/tests/support/m5_clips.rs"]
mod fixture;
fn oracle(text: &str,id:u32)->ClipExpectation {
    let model=SourceBundle::new(text.as_bytes().to_vec());
    let sources=ifc_lite_processing::extract_analytic_quantity_sources(text.as_bytes(),None);
    clips::expected(&model,&sources,id).unwrap().expect("clip source must be recognized")
}
#[test]
fn issue_7955_section_integrals_match_hand_authored_constraints() {
    for (text,expected) in [(fixture::SOURCE.to_string(),36.),
        (fixture::SOURCE.replace("#8,.T.","#8,.F."),12.),(fixture::chain(),1229./48.)] {
        let e=oracle(&text,13);let v=e.section_volume().expect("section oracle must execute");
        assert!((v-expected).abs()/expected<1e-12,"{v} vs {expected}");
        assert!(!e.curved());assert!(e.host_volume().unwrap()>=v);
    }
}
#[test]
fn issue_7955_source_plane_flag_and_georeferenced_frame() {
    let a=oracle(fixture::SOURCE,13);
    let b=oracle(&fixture::SOURCE.replace("#8,.T.","#8,.F."),13);
    assert_eq!(a.parts[0].planes[0].excess([0.,0.,0.]),0.5);
    assert_eq!(b.parts[0].planes[0].excess([0.,0.,2.]),1.5);
    let text=fixture::SOURCE.replace("$,$,$,#12", "$,$,#53,#12")
        .replace("ENDSEC;END-ISO", "#50=IFCCARTESIANPOINT((2600000.,100000.,10.));#51=IFCDIRECTION((0.8660254037844386,0.5,0.));#52=IFCAXIS2PLACEMENT3D(#50,$,#51);#53=IFCLOCALPLACEMENT($,#52);ENDSEC;END-ISO");
    let e=oracle(&text,13);assert!((e.section_volume().unwrap()-36.).abs()<1e-8);
    assert_eq!(e.parts[0].planes[0].point,[2600000.,100000.,10.5]);
    let opposite=oracle(&text.replace("#8,.T.","#8,.F."),13);
    assert!((opposite.section_volume().unwrap()-12.).abs()<1e-8);
    assert_eq!(opposite.parts[0].planes[0].normal,[0.,0.,1.]);
}
#[test]
fn issue_7955_original_corpus_clips_have_independent_section_authority() {
    for (text,ids) in [
        (include_str!("../../../apps/viewer/public/_fixtures/AC20-FZK-Haus.ifc"),vec![67536,75347]),
        (include_str!("../../geometry/tests/fixtures/issue_5314_halfspace_edge.ifc"),vec![30]),
    ] {
        for id in ids {
            let e=oracle(text,id);let volume=e.section_volume().expect("required source integral");
            assert!(volume>0.&&volume<e.host_volume().unwrap());
            println!("source clip #{id}: {volume}");
        }
    }
}

#[test]
fn issue_7955_synthetic_oracle_covers_curves_mixed_nodes_and_openings() {
    let text=include_str!("../../../tests/fixtures/synthetic-retained/f-e-clips.ifc");
    let rows:serde_json::Value=serde_json::from_str(include_str!("../../../tests/fixtures/cli-retained/expected.d/m5.json")).unwrap();
    for row in rows["synthetic"].as_array().unwrap() {
        let id=row["id"].as_u64().unwrap() as u32;
        if row["code"]!="published" || row["unclipped"]==true{continue;}
        let e=oracle(text,id);
        if row["mixed"]==true {assert!(e.section_volume().is_none());assert!(e.parts[0].mixed);continue;}
        let v=e.section_volume().expect("required section integral");let expected=row["volume"].as_f64().unwrap();
        assert!((v-expected).abs()/expected<1e-9,"#{id}: {v} vs {expected}");
    }
}

#[test]
fn issue_7955_source_oracle_clipped_opening_composes_after_host_clip(){
    let text=include_str!("../../../tests/fixtures/synthetic-retained/f-e-clips.ifc");
    // Existing opening column [-.5,2.5] becomes z>=1; the clipped host is z>=.5.
    // Net source volume 36 - 1*1*(2-1) = 35.
    let text=text.replace("'SweptSolid',(#115)","'CSG',(#505)")
        .replace("ENDSEC;\nEND-ISO","#500=IFCCARTESIANPOINT((0.,0.,1.));#501=IFCAXIS2PLACEMENT3D(#500,$,$);#502=IFCPLANE(#501);#503=IFCHALFSPACESOLID(#502,.T.);#505=IFCBOOLEANCLIPPINGRESULT(.DIFFERENCE.,#115,#503);ENDSEC;\nEND-ISO");
    assert!((oracle(&text,200).section_volume().unwrap()-35.).abs()<1e-10);
}
