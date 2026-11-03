// SPDX-License-Identifier: MPL-2.0
#![cfg(feature = "retained-runtime")]
//! #7955: layered walls with any opening extrusion and layered Boolean chains have an
//! independent per-band expectation. m4-band-appearance's wall #22 is x 0..2, y 0..0.6,
//! z 0..3 with Y bands 0.1/0.2/0.3 thick, so the uncut bands are 0.6, 1.2 and 1.8 m3.
use ifc_lite_core::SourceBundle;
use ifc_lite_retained_native::oracle::{bounded, clips::ClipOracle, layers, openings};

const WALL: &str = include_str!("../../../tests/fixtures/synthetic-retained/m4-band-appearance.ifc");
const THICK: [f64; 3] = [0.1, 0.2, 0.3];

fn with(extra: &str) -> String { WALL.replace("ENDSEC;\nEND-ISO", &format!("{extra}ENDSEC;\nEND-ISO")) }
/// `body` is the wall's Body item, with a representation type that admits it.
fn body(text: String, item: &str) -> String {
    text.replace("#20=IFCSHAPEREPRESENTATION(#4,'Body','SweptSolid',(#19));", &format!("#20=IFCSHAPEREPRESENTATION(#4,'Body','CSG',({item}));"))
}
fn oracle(text: &str) -> Result<layers::LayerExpectation, &'static str> {
    let sources = ifc_lite_processing::extract_analytic_quantity_sources(text.as_bytes(), None);
    let bundle = SourceBundle::new(text.as_bytes().to_vec());
    layers::explain_in(&bundle, &ClipOracle::new(&bundle, &sources), &sources, 22)
}
fn assert_bands(e: &layers::LayerExpectation, removed_per_metre: f64, tolerance: f64) {
    for (band, t) in e.volumes.iter().zip(THICK) {
        let hand = 2. * 3. * t - removed_per_metre * t;
        assert!((band - hand).abs() <= tolerance, "{band} vs {hand}: {:?}", e.volumes);
    }
    let hand = 3.6 - removed_per_metre * 0.6;
    assert!((e.opened_volume - hand).abs() <= tolerance * 3., "{} vs {hand}", e.opened_volume);
}
/// An opening extruded +Y through the wall, its profile in XZ, placed at (0, -0.1, 0).
fn opening(id: u32, profile: &str) -> String {
    format!("#{id}=IFCCARTESIANPOINT((0.,-0.1,0.));\n#{a}=IFCDIRECTION((0.,1.,0.));\n#{b}=IFCDIRECTION((1.,0.,0.));\n\
#{c}=IFCAXIS2PLACEMENT3D(#{id},#{a},#{b});\n#{d}=IFCEXTRUDEDAREASOLID({profile},#{c},#3,0.8);\n\
#{e}=IFCSHAPEREPRESENTATION(#4,'Body','SweptSolid',(#{d}));\n#{f}=IFCPRODUCTDEFINITIONSHAPE($,$,(#{e}));\n\
#{g}=IFCOPENINGELEMENT('{id:0>22}',$,$,$,$,#9,#{f},$,.OPENING.);\n#{h}=IFCRELVOIDSELEMENT('{h:0>22}',$,$,$,#22,#{g});\n",
        a = id + 1, b = id + 2, c = id + 3, d = id + 4, e = id + 5, f = id + 6, g = id + 7, h = id + 8)
}
/// Rectangle x 0.5..1.5, local y -2..-1 (the placement's local Y is world -Z): z 1..2.
const WINDOW: &str = "#8000=IFCCARTESIANPOINT((1.,-1.5));\n#8001=IFCAXIS2PLACEMENT2D(#8000,$);\n#8002=IFCRECTANGLEPROFILEDEF(.AREA.,$,#8001,1.,1.);\n";

/// 678 corpus walls: a window across the wall's vertical axis has no parallel prism.
#[test]
fn opening_across_the_host_axis_has_band_volumes() {
    let e = oracle(&with(&format!("{WINDOW}{}", opening(8100, "#8002")))).expect("an opening across the axis is modelled");
    assert!(!e.curved);
    assert_bands(&e, 1., 1e-10);
}

/// The previous inclusion-exclusion stopped at eight cutters, however disjoint.
#[test]
fn nine_openings_are_integrated_and_an_overlap_counts_once() {
    let mut extra = WINDOW.to_owned();
    for i in 0..9 { extra += &opening(8100 + i * 20, "#8002"); }
    let e = oracle(&with(&extra)).expect("no cutter cap");
    assert_bands(&e, 1., 1e-10);
}

#[test]
fn a_non_convex_opening_removes_its_partition_not_its_hull() {
    // An L of area 0.75 in x 0.5..1.5, z 1..2; its hull would remove 0.875.
    let l = "#8000=IFCCARTESIANPOINT((0.5,-1.));\n#8001=IFCCARTESIANPOINT((1.5,-1.));\n#8002=IFCCARTESIANPOINT((1.5,-1.5));\n\
#8003=IFCCARTESIANPOINT((1.,-1.5));\n#8004=IFCCARTESIANPOINT((1.,-2.));\n#8005=IFCCARTESIANPOINT((0.5,-2.));\n\
#8006=IFCPOLYLINE((#8000,#8001,#8002,#8003,#8004,#8005,#8000));\n#8007=IFCARBITRARYCLOSEDPROFILEDEF(.AREA.,$,#8006);\n";
    let e = oracle(&with(&format!("{l}{}", opening(8100, "#8007")))).expect("a non-convex opening is modelled");
    assert_bands(&e, 0.75, 1e-10);
}

#[test]
fn an_arc_opening_is_polygonised_and_judged_as_curved() {
    let circle = "#8000=IFCCARTESIANPOINT((1.,-1.5));\n#8001=IFCAXIS2PLACEMENT2D(#8000,$);\n#8002=IFCCIRCLEPROFILEDEF(.AREA.,$,#8001,0.3);\n";
    let e = oracle(&with(&format!("{circle}{}", opening(8100, "#8002")))).expect("an arc opening is modelled");
    assert!(e.curved, "a polygonised cutter must never meet the linear limit");
    let removed = std::f64::consts::PI * 0.09;
    assert_bands(&e, removed, 3.6 * 2e-3);
    // Inscribed chords remove less than the arc, and only by the chord height's order.
    assert!(e.opened_volume > 3.6 - removed * 0.6 && e.opened_volume < 3.6 - removed * 0.6 * 0.999, "{}", e.opened_volume);
}

/// A polygonal bounded halfspace over the whole footprint removes z >= 2.
const CAP: &str = "#8010=IFCCARTESIANPOINT((0.,0.,2.));\n#8011=IFCDIRECTION((1.,0.,0.));\n#8012=IFCAXIS2PLACEMENT3D(#8010,#3,#8011);\n#8013=IFCPLANE(#8012);\n\
#8014=IFCCARTESIANPOINT((-1.,-1.));\n#8015=IFCCARTESIANPOINT((3.,-1.));\n#8016=IFCCARTESIANPOINT((3.,2.));\n#8017=IFCCARTESIANPOINT((-1.,2.));\n\
#8018=IFCPOLYLINE((#8014,#8015,#8016,#8017,#8014));\n#8019=IFCPOLYGONALBOUNDEDHALFSPACE(#8013,.F.,#2,#8018);\n#8020=IFCBOOLEANCLIPPINGRESULT(.DIFFERENCE.,#19,#8019);\n";

/// 430 corpus walls: a layered host with a bounded chain had no band expectation.
#[test]
fn a_bounded_chain_splits_into_band_volumes() {
    let e = oracle(&body(with(CAP), "#8020")).expect("a bounded chain is modelled");
    assert!(!e.curved);
    assert_bands(&e, 2., 1e-10);
}

#[test]
fn a_solid_operand_is_removed_like_an_opening() {
    // The whole upper metre as an extruded box: x -1..3, y -1..2, z 2..3.
    let solid = "#8030=IFCCARTESIANPOINT((1.,0.5));\n#8031=IFCAXIS2PLACEMENT2D(#8030,$);\n#8032=IFCRECTANGLEPROFILEDEF(.AREA.,$,#8031,4.,3.);\n\
#8033=IFCCARTESIANPOINT((0.,0.,2.));\n#8034=IFCAXIS2PLACEMENT3D(#8033,$,$);\n#8035=IFCEXTRUDEDAREASOLID(#8032,#8034,#3,1.);\n#8036=IFCBOOLEANRESULT(.DIFFERENCE.,#19,#8035);\n";
    let text = body(with(solid), "#8036");
    let e = oracle(&text).expect("an extrusion operand is modelled");
    assert_bands(&e, 2., 1e-10);
}

#[test]
fn a_solid_operand_outside_the_family_stays_a_named_gap() {
    let block = "#8033=IFCCARTESIANPOINT((0.,0.,2.));\n#8034=IFCAXIS2PLACEMENT3D(#8033,$,$);\n#8035=IFCBLOCK(#8034,4.,3.,1.);\n#8036=IFCBOOLEANRESULT(.DIFFERENCE.,#19,#8035);\n";
    let text = body(with(block), "#8036");
    let sources = ifc_lite_processing::extract_analytic_quantity_sources(text.as_bytes(), None);
    let bundle = SourceBundle::new(text.as_bytes().to_vec());
    let chain = layers::explain_in(&bundle, &ClipOracle::new(&bundle, &sources), &sources, 22);
    assert!(chain.is_err(), "no expectation may be invented: {:?}", chain.map(|e| e.opened_volume));
    assert_eq!(chain.err(), Some("chain_band_integral"));
    assert_eq!(bounded::expected(text.as_bytes(), &sources, 22).map(|e| e.section_volume), None, "no bounded clip: M6 stays out");
}

/// M3: a voided host with cutters across its axis now gets a result volume, not bounds only.
#[test]
fn a_voided_host_has_a_result_volume_for_any_cutter_extrusion() {
    let text = with(&format!("{WINDOW}{}", opening(8100, "#8002")));
    let sources = ifc_lite_processing::extract_analytic_quantity_sources(text.as_bytes(), None);
    let e = openings::expected(&sources, 22, &[8107]).expect("opening expectation");
    assert!((e.result_volume.expect("a result volume") - 3.).abs() < 1e-10);
}

/// Only the polygon's footprint is removed: x -1..1 of the wall's x 0..2, above z = 2.
#[test]
fn a_partial_bounded_footprint_removes_only_its_part_of_each_band() {
    let partial = CAP.replace("#8015=IFCCARTESIANPOINT((3.,-1.));", "#8015=IFCCARTESIANPOINT((1.,-1.));")
        .replace("#8016=IFCCARTESIANPOINT((3.,2.));", "#8016=IFCCARTESIANPOINT((1.,2.));");
    let e = oracle(&body(with(&partial), "#8020")).expect("a bounded chain is modelled");
    assert_bands(&e, 1., 1e-10);
}

/// rvt01 #12345: the opening's Body is closed, convex face sets, not extrusions.
#[test]
fn a_voided_host_has_a_result_volume_for_convex_face_set_cutters() {
    // The box x 0.5..1.5, y -0.1..0.7, z 1..2.
    let opening = |id: u32, points: &str, rows: &str, closed: &str| format!("#{id}=IFCCARTESIANPOINTLIST3D(({points}));\n#{a}=IFCTRIANGULATEDFACESET(#{id},$,{closed},({rows}),$);\n\
#{b}=IFCSHAPEREPRESENTATION(#4,'Body','Tessellation',(#{a}));\n#{c}=IFCPRODUCTDEFINITIONSHAPE($,$,(#{b}));\n#{d}=IFCOPENINGELEMENT('{id:0>22}',$,$,$,$,#9,#{c},$,.OPENING.);\n\
#{e}=IFCRELVOIDSELEMENT('{e:0>22}',$,$,$,#22,#{d});\n", a = id + 1, b = id + 2, c = id + 3, d = id + 4, e = id + 5);
    let points = "(0.5,-0.1,1.),(1.5,-0.1,1.),(1.5,0.7,1.),(0.5,0.7,1.),(0.5,-0.1,2.),(1.5,-0.1,2.),(1.5,0.7,2.),(0.5,0.7,2.)";
    let rows = "(1,3,2),(1,4,3),(5,6,7),(5,7,8),(1,2,6),(1,6,5),(2,3,7),(2,7,6),(3,4,8),(3,8,7),(4,1,5),(4,5,8)";
    let cut = |text: String| {
        let sources = ifc_lite_processing::extract_analytic_quantity_sources(text.as_bytes(), None);
        let bundle = SourceBundle::new(text.into_bytes());
        openings::expected_with_face_set_cutters(&bundle, &sources, 22, &[8104])
    };
    let e = cut(with(&opening(8100, points, rows, ".T."))).expect("a closed convex face set is a cutter");
    assert!((e.result_volume.unwrap() - 3.).abs() < 1e-10, "{:?}", e.result_volume);
    assert!((e.volume_bounds[0] - (3.6 - 0.8)).abs() < 1e-10, "nominal cutter volume {:?}", e.volume_bounds);
    let open = "(1,3,2),(1,4,3),(5,6,7),(5,7,8),(1,2,6),(1,6,5),(2,3,7),(2,7,6),(3,4,8),(3,8,7),(4,1,5)";
    assert!(cut(with(&opening(8100, points, open, ".F."))).is_none(), "an open set bounds no solid");
    // Pushing one corner in leaves a closed but non-convex set: no hull is invented.
    // A circular extrusion beside the face set is still chordal: never the linear limit.
    let circle = "#8050=IFCCARTESIANPOINT((1.,-1.5));\n#8051=IFCAXIS2PLACEMENT2D(#8050,$);\n#8052=IFCCIRCLEPROFILEDEF(.AREA.,$,#8051,0.3);\n";
    let text = with(&format!("{}{circle}{}", opening(8100, points, rows, ".T."), self::opening(8200, "#8052")));
    let sources = ifc_lite_processing::extract_analytic_quantity_sources(text.as_bytes(), None);
    let bundle = SourceBundle::new(text.into_bytes());
    assert!(openings::expected_with_face_set_cutters(&bundle, &sources, 22, &[8104, 8207]).unwrap().curved, "a polygonised arc stays curved");
    let dented = points.replacen("(1.5,0.7,2.)", "(1.,0.3,1.5)", 1);
    assert!(cut(with(&opening(8100, &dented, rows, ".T."))).is_none(), "a non-convex set stays a gap");
    // A row whose corner is unreadable is stored empty and adds no edge: still a gap, never a panic.
    let unreadable = format!("{rows},(1,2,99)");
    assert!(cut(with(&opening(8100, points, &unreadable, ".T."))).is_none(), "an unreadable row stays a gap");
}

/// Snowdon #81962: a cutter inside the host's own void removes nothing, and rounding in
/// outer-minus-hole about a large profile must not read as "no integral".
#[test]
fn a_cutter_inside_a_host_void_removes_nothing() {
    let (x, y) = (123.456789, -98.7654321);
    let point = |id: u32, a: f64, b: f64| format!("#{id}=IFCCARTESIANPOINT(({:?},{:?}));\n", x + a, y + b);
    let mut extra = String::new();
    for (id, a, b) in [(8000, 0., 0.), (8001, 31.7, 0.), (8002, 31.7, 17.3), (8003, 0., 17.3), (8010, 10.1, 5.3), (8011, 10.1, 9.7), (8012, 14.9, 9.7), (8013, 14.9, 5.3)] { extra += &point(id, a, b); }
    extra += "#8004=IFCPOLYLINE((#8000,#8001,#8002,#8003,#8000));\n#8014=IFCPOLYLINE((#8010,#8011,#8012,#8013,#8010));\n#8015=IFCARBITRARYPROFILEDEFWITHVOIDS(.AREA.,$,#8004,(#8014));\n";
    extra += &format!("#8020=IFCCARTESIANPOINT(({:?},{:?}));\n#8021=IFCAXIS2PLACEMENT2D(#8020,$);\n#8022=IFCRECTANGLEPROFILEDEF(.AREA.,$,#8021,4.8,4.4);\n", x + 12.5, y + 7.5);
    extra += "#8030=IFCCARTESIANPOINT((0.,0.,-1.));\n#8031=IFCAXIS2PLACEMENT3D(#8030,$,$);\n#8032=IFCEXTRUDEDAREASOLID(#8022,#8031,#3,5.);\n#8033=IFCSHAPEREPRESENTATION(#4,'Body','SweptSolid',(#8032));\n#8034=IFCPRODUCTDEFINITIONSHAPE($,$,(#8033));\n\
#8035=IFCOPENINGELEMENT('0000000000000000008035',$,$,$,$,#9,#8034,$,.OPENING.);\n#8036=IFCRELVOIDSELEMENT('0000000000000000008036',$,$,$,#22,#8035);\n";
    let text = with(&extra).replace("#19=IFCEXTRUDEDAREASOLID(#18,#2,#3,3.);", "#19=IFCEXTRUDEDAREASOLID(#8015,#2,#3,3.);");
    let sources = ifc_lite_processing::extract_analytic_quantity_sources(text.as_bytes(), None);
    let e = openings::expected(&sources, 22, &[8035]).expect("voided host");
    let hand = (31.7 * 17.3 - 4.8 * 4.4) * 3.;
    assert!((e.result_volume.expect("a result volume") - hand).abs() < hand * 1e-9, "{:?} vs {hand}", e.result_volume);
}
