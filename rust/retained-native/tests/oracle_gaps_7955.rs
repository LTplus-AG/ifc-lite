// SPDX-License-Identifier: MPL-2.0
#![cfg(feature = "retained-runtime")]
//! #7955: a source oracle's own limits must not turn into a missing expectation
//! (SDK-free): the analytic walk's output budget, and tangent section integrals.
#[path = "../examples/compare/analytic_sources.rs"]
mod analytic_sources;

use ifc_lite_core::SourceBundle;
use ifc_lite_processing::extract_analytic_quantity_sources;
use ifc_lite_retained_native::oracle::{clips::ClipOracle, layers};
use std::collections::BTreeSet;

const WALL: &str = include_str!("../../../tests/fixtures/synthetic-retained/m4-band-appearance.ifc");

fn with(extra: &str) -> String { WALL.replace("ENDSEC;\nEND-ISO", &format!("{extra}ENDSEC;\nEND-ISO")) }
/// A wall of `#19` repeated: `items` analytic instances for a few bytes each.
fn wall(id: u32, items: usize) -> String {
    let list = vec!["#19"; items].join(",");
    format!("#{id}=IFCSHAPEREPRESENTATION(#4,'Body','SweptSolid',({list}));\n#{}=IFCPRODUCTDEFINITIONSHAPE($,$,(#{id}));\n#{}=IFCWALL('{id:0>22}',$,$,$,$,#9,#{},$,.NOTDEFINED.);\n", id + 1, id + 2, id + 1)
}

/// Holter Tower: one walk's 100k instance budget dropped its last 1.2k products entirely.
#[test]
fn a_product_past_the_walk_budget_still_gets_its_sources() {
    let ids = [9000, 9010, 9020, 9030, 9040];
    let text = with(&ids.map(|id| wall(id, 24_000)).concat());
    let one_walk = extract_analytic_quantity_sources(text.as_bytes(), None);
    assert!(!one_walk.extrusion_definitions.instances.contains_key(&9042), "the fixture must overflow one walk");
    let all = analytic_sources::analytic_sources(text.as_bytes());
    for id in ids.map(|id| id + 2) { assert_eq!(all.extrusion_definitions.instances.get(&id).map(Vec::len), Some(24_000), "#{id}: {:?}", all.extrusion_definitions.diagnostics); }
    assert!(all.extrusion_definitions.diagnostics.iter().all(|d| !d.contains("budget")), "{:?}", all.extrusion_definitions.diagnostics);
    let keys: Vec<_> = all.extrusion_definitions.sources.iter().map(|s| &s.key).collect();
    assert_eq!(keys.iter().collect::<BTreeSet<_>>().len(), keys.len(), "a source once per key");
}

#[test]
fn a_product_alone_past_the_budget_stays_named() {
    let text = with(&wall(9000, 25_001));
    let all = analytic_sources::analytic_sources(text.as_bytes());
    assert!(!all.extrusion_definitions.instances.contains_key(&9002));
    assert!(all.extrusion_definitions.diagnostics.iter().any(|d| d.contains("product #9002") && d.contains("budget")), "{:?}", all.extrusion_definitions.diagnostics);
}

/// Snowdon #28109: at a circular tangency area grows like t^(3/2), which exhausted uniform
/// refinement. A plane through a cylinder's diameter cuts a wedge of V = 2/3 r^2 h.
#[test]
fn a_tangent_section_integrates_to_the_closed_form() {
    let (r, h) = (0.25, 1.5);
    // Centre (1, 0.3); z <= (h/r)(y - 0.3) keeps the wedge, and z <= h caps it at the far edge.
    let text = with("#8000=IFCCARTESIANPOINT((1.,0.3,0.));\n#8001=IFCDIRECTION((0.,-6.,1.));\n#8002=IFCDIRECTION((1.,0.,0.));\n#8003=IFCAXIS2PLACEMENT3D(#8000,#8001,#8002);\n\
#8004=IFCPLANE(#8003);\n#8005=IFCHALFSPACESOLID(#8004,.F.);\n#8006=IFCBOOLEANCLIPPINGRESULT(.DIFFERENCE.,#19,#8005);\n\
#8007=IFCCARTESIANPOINT((0.,0.,1.5));\n#8008=IFCAXIS2PLACEMENT3D(#8007,#3,#8002);\n#8009=IFCPLANE(#8008);\n#8010=IFCHALFSPACESOLID(#8009,.F.);\n#8011=IFCBOOLEANCLIPPINGRESULT(.DIFFERENCE.,#8006,#8010);\n")
        .replace("#18=IFCRECTANGLEPROFILEDEF(.AREA.,$,#17,2.,0.6);", "#18=IFCCIRCLEPROFILEDEF(.AREA.,$,#17,0.25);")
        .replace("#19=IFCEXTRUDEDAREASOLID(#18,#2,#3,3.);", "#19=IFCEXTRUDEDAREASOLID(#18,#2,#3,4.);")
        .replace("'Body','SweptSolid',(#19)", "'Body','Clipping',(#8011)");
    let sources = extract_analytic_quantity_sources(text.as_bytes(), None);
    let bundle = SourceBundle::new(text.as_bytes().to_vec());
    let oracle = ClipOracle::new(&bundle, &sources);
    let e = oracle.expected(22).unwrap().expect("clipped");
    let hand = 2. / 3. * r * r * h;
    let volume = e.section_volume().unwrap_or_else(|| panic!("a required integral: {:?}", e.parts[0].section_gap));
    assert!((volume - hand).abs() < hand * 1e-10, "{volume} vs {hand}");
}

/// The named reason a layered product has no band expectation, not a bare failure.
#[test]
fn a_layered_gap_says_why() {
    let bundle_text = WALL.replace("'Body','SweptSolid',(#19)", "'Body','Clipping',(#8036)").replace("ENDSEC;\nEND-ISO",
        "#8033=IFCCARTESIANPOINT((0.,0.,2.));\n#8034=IFCAXIS2PLACEMENT3D(#8033,$,$);\n#8035=IFCBLOCK(#8034,4.,3.,1.);\n#8036=IFCBOOLEANRESULT(.DIFFERENCE.,#19,#8035);\nENDSEC;\nEND-ISO");
    let sources = extract_analytic_quantity_sources(bundle_text.as_bytes(), None);
    let bundle = SourceBundle::new(bundle_text.as_bytes().to_vec());
    let gap = layers::explain_in(&bundle, &ClipOracle::new(&bundle, &sources), &sources, 22);
    assert!(gap.is_err());
    assert!(!gap.err().unwrap().is_empty());
}

/// The source's own answer to whether face-set rows can bound a solid, by exact coordinates.
#[test]
fn authored_rows_report_their_open_edges() {
    use ifc_lite_core::EntityDecoder;
    use ifc_lite_retained_native::oracle::{face_set_closure, face_sets};
    let set = |rows: &str, closed: &str| format!("#1=IFCCARTESIANPOINTLIST3D(((0.,0.,0.),(1.,0.,0.),(0.,1.,0.),(0.,0.,1.),(0.,0.,0.)));\n#2=IFCTRIANGULATEDFACESET(#1,$,{closed},({rows}),$);\n");
    for (rows, closed, open_edges, declared) in [
        ("(1,3,2),(1,2,4),(2,3,4),(3,1,4)", ".T.", 0, "TRUE"),
        ("(1,3,2),(1,2,4),(2,3,4)", "$", 3, "UNSET"),
        // Point 5 repeats point 1 exactly: coordinates decide, not indices.
        ("(1,3,2),(1,2,4),(2,3,4),(3,5,4)", ".F.", 0, "FALSE"),
    ] {
        let text = set(rows, closed);
        let mut decoder = EntityDecoder::new(text.as_bytes());
        let item = decoder.decode_by_id(2).unwrap();
        let authored = face_sets::authored(&item, &mut decoder, 1.).unwrap();
        assert_eq!(authored.open_edges, open_edges, "{rows}");
        assert_eq!(face_set_closure::declared(&item), declared);
    }
}
