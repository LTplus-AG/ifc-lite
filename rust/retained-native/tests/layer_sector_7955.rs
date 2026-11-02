// SPDX-License-Identifier: MPL-2.0
#![cfg(feature = "retained-runtime")]
//! #7955: dental_clinic #1674's stack, with its authored numbers. The end lines are not
//! radial (inner arc 77.4 degrees, outer 75.1), so a band's arcs end where the lines cross
//! its own radii. Hand band volumes by polar integration of the raw numbers, no ifc-lite
//! code: 0.0712154, 0.4086828, 0.0709397 m3. The former oracle kept each host arc's span
//! and read the real bands as 1.3% and 1.2% off.
use ifc_lite_core::SourceBundle;
use ifc_lite_retained_native::{oracle::layers, run_model_native, ModelOptions, ProductOutcome};

const HAND: [f64; 3] = [0.07121544750620877, 0.4086828242738528, 0.07093971704382002];
const WALL: &str = "ISO-10303-21;HEADER;FILE_SCHEMA(('IFC2X3'));ENDSEC;DATA;
#1=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);#2=IFCSIUNIT(*,.PLANEANGLEUNIT.,$,.RADIAN.);
#3=IFCDIMENSIONALEXPONENTS(0,0,0,0,0,0,0);#4=IFCMEASUREWITHUNIT(IFCRATIOMEASURE(0.01745329251994328),#2);
#5=IFCCONVERSIONBASEDUNIT(#3,.PLANEANGLEUNIT.,'DEGREE',#4);#6=IFCUNITASSIGNMENT((#1,#5));
#7=IFCPROJECT('0000000000000000000000',$,'SYNTHETIC',$,$,$,$,$,#6);
#10=IFCCARTESIANPOINT((0.,0.,0.));#11=IFCAXIS2PLACEMENT3D(#10,$,$);#12=IFCDIRECTION((0.,0.,1.));#13=IFCLOCALPLACEMENT($,#11);
#20=IFCCARTESIANPOINT((3.91471628788658,-3.106318873909782));#21=IFCDIRECTION((1.,0.));#22=IFCAXIS2PLACEMENT2D(#20,#21);
#23=IFCCIRCLE(#22,4.997421391182919);#24=IFCCIRCLE(#22,4.935421391182919);#25=IFCCIRCLE(#22,5.059421391182918);
#26=IFCTRIMMEDCURVE(#23,(IFCPARAMETERVALUE(141.5680761427488)),(IFCPARAMETERVALUE(218.9441241541247)),.T.,.PARAMETER.);
#27=IFCTRIMMEDCURVE(#24,(IFCPARAMETERVALUE(141.5680761427487)),(IFCPARAMETERVALUE(218.9441241541247)),.T.,.PARAMETER.);
#28=IFCTRIMMEDCURVE(#25,(IFCPARAMETERVALUE(142.6739435505508)),(IFCPARAMETERVALUE(217.8181222408535)),.T.,.PARAMETER.);
#30=IFCCARTESIANPOINT((0.04856752930165641,-0.03853822903991245));#31=IFCCARTESIANPOINT((-0.1085245361905843,-0.03853822903991245));
#32=IFCCARTESIANPOINT((-0.0820298744579635,-6.208538229039827));#33=IFCCARTESIANPOINT((0.07614632223498968,-6.208538229039827));
#34=IFCPOLYLINE((#30,#31));#35=IFCPOLYLINE((#32,#33));
#36=IFCCOMPOSITECURVESEGMENT(.CONTINUOUS.,.F.,#27);#37=IFCCOMPOSITECURVESEGMENT(.CONTINUOUS.,.T.,#34);
#38=IFCCOMPOSITECURVESEGMENT(.CONTINUOUS.,.T.,#28);#39=IFCCOMPOSITECURVESEGMENT(.CONTINUOUS.,.T.,#35);
#40=IFCCOMPOSITECURVE((#36,#37,#38,#39),.F.);#41=IFCARBITRARYCLOSEDPROFILEDEF(.AREA.,$,#40);
#42=IFCEXTRUDEDAREASOLID(#41,#11,#12,0.6680000000044504);
#43=IFCSHAPEREPRESENTATION($,'Axis','Curve2D',(#26));#44=IFCSHAPEREPRESENTATION($,'Body','SweptSolid',(#42));#45=IFCPRODUCTDEFINITIONSHAPE($,$,(#43,#44));
#46=IFCWALLSTANDARDCASE('0000000000000000000001',$,'SYNTHETIC wall',$,$,#13,#45,$);
#50=IFCMATERIAL('Plasterboard');#51=IFCMATERIAL('Stud');#52=IFCMATERIALLAYER(#50,0.016,$);#53=IFCMATERIALLAYER(#51,0.092,$);
#54=IFCMATERIALLAYERSET((#52,#53,#52),'wall');#55=IFCMATERIALLAYERSETUSAGE(#54,.AXIS2.,.NEGATIVE.,0.062);
#56=IFCRELASSOCIATESMATERIAL('0000000000000000000002',$,$,$,(#46),#55);
ENDSEC;END-ISO-10303-21;";

#[test]
fn bands_of_a_sector_with_non_radial_ends_match_the_hand_integral() {
    let sources = ifc_lite_processing::extract_analytic_quantity_sources(WALL.as_bytes(), None);
    let e = layers::expected(WALL.as_bytes(), &sources, 46).expect("a curved layered wall");
    assert!(e.curved);
    let mut volumes = e.volumes.clone();
    // Sorted: which of the thin bands is first depends on the usage, not on this rule.
    volumes.sort_by(f64::total_cmp);
    let mut hand = HAND;
    hand.sort_by(f64::total_cmp);
    for (band, hand) in volumes.iter().zip(hand) {
        assert!((band - hand).abs() <= hand * 1e-6, "{band} vs {hand}: {:?}", e.volumes);
    }
    assert!((e.opened_volume - HAND.iter().sum::<f64>()).abs() < 1e-6);
}

#[test]
fn real_retained_bands_match_the_hand_integral() {
    let Some(worker) = std::env::var_os("IFCLITE_SMLIB_WORKER") else {
        assert!(std::env::var_os("IFCLITE_REQUIRE_SMLIB").is_none(), "real SDK required");
        return;
    };
    let mut products = Vec::new();
    run_model_native(SourceBundle::new(WALL.as_bytes().to_vec()), &worker,
        &ModelOptions { ids: Some([46].into_iter().collect()), ..Default::default() }, |o| products.push(o)).unwrap();
    let ProductOutcome::Published(shape) = products.pop().unwrap() else { panic!("must publish") };
    let mut volumes: Vec<f64> = shape.parts.iter().map(|p| p.capped_volume_m3.unwrap()).collect();
    volumes.sort_by(f64::total_cmp);
    let mut hand = HAND;
    hand.sort_by(f64::total_cmp);
    assert_eq!(volumes.len(), 3);
    for (band, hand) in volumes.iter().zip(hand) {
        assert!((band - hand).abs() <= hand * 2e-3, "{band} vs {hand}");
    }
}
