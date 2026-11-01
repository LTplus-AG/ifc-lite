// SPDX-License-Identifier: MPL-2.0
#![cfg(feature = "retained-runtime")]
//! #7955: a real retained run agrees with section_net's hand band volumes, so the new
//! expectations are not vacuous. m4-band-appearance's wall #22: x 0..2, z 0..3, Y bands 0.1/0.2/0.3.
use ifc_lite_core::SourceBundle;
use ifc_lite_retained_native::{run_model_native, ModelOptions, ProductOutcome};

const WALL: &str = include_str!("../../../tests/fixtures/synthetic-retained/m4-band-appearance.ifc");
const THICK: [f64; 3] = [0.1, 0.2, 0.3];
fn with(extra: &str) -> String { WALL.replace("ENDSEC;\nEND-ISO", &format!("{extra}ENDSEC;\nEND-ISO")) }

/// A 1 x 1 window extruded +Y through the wall, z 1..2.
const ACROSS: &str = "#8000=IFCCARTESIANPOINT((1.,-1.5));\n#8001=IFCAXIS2PLACEMENT2D(#8000,$);\n#8002=IFCRECTANGLEPROFILEDEF(.AREA.,$,#8001,1.,1.);\n\
#8100=IFCCARTESIANPOINT((0.,-0.1,0.));\n#8101=IFCDIRECTION((0.,1.,0.));\n#8102=IFCDIRECTION((1.,0.,0.));\n#8103=IFCAXIS2PLACEMENT3D(#8100,#8101,#8102);\n\
#8104=IFCEXTRUDEDAREASOLID(#8002,#8103,#3,0.8);\n#8105=IFCSHAPEREPRESENTATION(#4,'Body','SweptSolid',(#8104));\n#8106=IFCPRODUCTDEFINITIONSHAPE($,$,(#8105));\n\
#8107=IFCOPENINGELEMENT('0000000000000000008100',$,$,$,$,#9,#8106,$,.OPENING.);\n#8108=IFCRELVOIDSELEMENT('0000000000000000008108',$,$,$,#22,#8107);\n";
/// A polygonal bounded halfspace over the whole footprint removes z >= 2.
const CAP: &str = "#8010=IFCCARTESIANPOINT((0.,0.,2.));\n#8011=IFCDIRECTION((1.,0.,0.));\n#8012=IFCAXIS2PLACEMENT3D(#8010,#3,#8011);\n#8013=IFCPLANE(#8012);\n\
#8014=IFCCARTESIANPOINT((-1.,-1.));\n#8015=IFCCARTESIANPOINT((3.,-1.));\n#8016=IFCCARTESIANPOINT((3.,2.));\n#8017=IFCCARTESIANPOINT((-1.,2.));\n\
#8018=IFCPOLYLINE((#8014,#8015,#8016,#8017,#8014));\n#8019=IFCPOLYGONALBOUNDEDHALFSPACE(#8013,.F.,#2,#8018);\n#8020=IFCBOOLEANCLIPPINGRESULT(.DIFFERENCE.,#19,#8019);\n";
fn body(text: String, item: &str) -> String {
    text.replace("#20=IFCSHAPEREPRESENTATION(#4,'Body','SweptSolid',(#19));", &format!("#20=IFCSHAPEREPRESENTATION(#4,'Body','CSG',({item}));"))
}

#[test]
fn real_retained_bands_match_the_new_expectations() {
    let Some(worker) = std::env::var_os("IFCLITE_SMLIB_WORKER") else {
        assert!(std::env::var_os("IFCLITE_REQUIRE_SMLIB").is_none(), "real SDK required");
        return;
    };
    for (label, text, removed) in [
        ("across", with(ACROSS), 1.),
        ("bounded", body(with(CAP), "#8020"), 2.),
    ] {
        let mut products = Vec::new();
        run_model_native(SourceBundle::new(text.into_bytes()), &worker,
            &ModelOptions { ids: Some([22].into_iter().collect()), ..Default::default() }, |o| products.push(o)).unwrap();
        let ProductOutcome::Published(shape) = products.pop().unwrap() else { panic!("{label}: must publish") };
        let mut bands: Vec<_> = shape.parts.iter().map(|p| (p.layer.unwrap().index as usize, p.capped_volume_m3.unwrap())).collect();
        bands.sort_by_key(|b| b.0);
        assert_eq!(bands.len(), 3, "{label}");
        for ((_, volume), t) in bands.iter().zip(THICK) {
            let hand = 6. * t - removed * t;
            assert!((volume - hand).abs() < 1e-9, "{label}: {volume} vs {hand}");
        }
    }
}
