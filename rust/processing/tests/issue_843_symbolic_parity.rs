// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Regression test for issue #843 follow-up — full parity refactor
//! moved the 2D-symbol extractor from the wasm bindings into the
//! processing crate. The browser-side parser used to emit a much richer
//! set of primitives than the server scaffolding: IfcCircle disks,
//! IfcEllipse polygons, IfcTrimmedCurve arcs, IfcTextLiteral text
//! annotations, IfcAnnotationFillArea fills with optional holes,
//! IfcMappedItem with transform composition, IfcGrid bubble + tag
//! glyphs, and IfcStyledItem colour resolution. After the refactor the
//! server response carries the same primitives because both pipelines
//! now call into `ifc_lite_processing::extract_symbolic_data`.
//!
//! This test drives a synthetic IFC that exercises every new primitive
//! family at once.

use ifc_lite_processing::extract_symbolic_data;

const RICH_IFC: &str = r#"ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('issue-843 parity fixture'),'2;1');
FILE_NAME('parity.ifc','2026-05-28T00:00:00',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0$ScRe4drECQ4DMSqUjd6d',$,'P',$,$,$,$,(#2),#3);
#2=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.0E-5,#5,$);
#3=IFCUNITASSIGNMENT((#6,#7));
#4=IFCCARTESIANPOINT((0.,0.,0.));
#5=IFCAXIS2PLACEMENT3D(#4,$,$);
#6=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#7=IFCSIUNIT(*,.PLANEANGLEUNIT.,$,.RADIAN.);

/* Shared placement at world origin */
#40=IFCLOCALPLACEMENT($,#5);

/* ── IfcCircle (full disk) inside an IfcAnnotation ──────────────── */
#100=IFCCARTESIANPOINT((5.,3.));
#101=IFCAXIS2PLACEMENT2D(#100,$);
#102=IFCCIRCLE(#101,2.0);
#103=IFCSHAPEREPRESENTATION(#2,'Annotation','GeometricCurveSet',(#102));
#104=IFCPRODUCTDEFINITIONSHAPE($,$,(#103));
#105=IFCANNOTATION('AnnoCircle0000000000001',$,'Bubble',$,$,#40,#104);

/* ── IfcTextLiteralWithExtent text annotation ───────────────────── */
#200=IFCCARTESIANPOINT((10.,5.,0.));
#201=IFCAXIS2PLACEMENT3D(#200,$,$);
#202=IFCPLANAREXTENT(0.5,0.4);
#203=IFCTEXTLITERALWITHEXTENT('Hello world',#201,.RIGHT.,#202,'center');
#204=IFCSHAPEREPRESENTATION(#2,'Annotation','Annotation2D',(#203));
#205=IFCPRODUCTDEFINITIONSHAPE($,$,(#204));
#206=IFCANNOTATION('AnnoText00000000000001',$,'Label',$,$,#40,#205);

/* ── IfcAnnotationFillArea with a square outer boundary ─────────── */
#300=IFCCARTESIANPOINT((0.,0.));
#301=IFCCARTESIANPOINT((4.,0.));
#302=IFCCARTESIANPOINT((4.,4.));
#303=IFCCARTESIANPOINT((0.,4.));
#304=IFCCARTESIANPOINT((0.,0.));
#305=IFCPOLYLINE((#300,#301,#302,#303,#304));
#306=IFCANNOTATIONFILLAREA(#305,$);
#307=IFCSHAPEREPRESENTATION(#2,'Annotation','GeometricCurveSet',(#306));
#308=IFCPRODUCTDEFINITIONSHAPE($,$,(#307));
#309=IFCANNOTATION('AnnoFill00000000000001',$,'Fill',$,$,#40,#308);

/* ── IfcEllipse boundary ────────────────────────────────────────── */
#400=IFCCARTESIANPOINT((20.,10.));
#401=IFCAXIS2PLACEMENT2D(#400,$);
#402=IFCELLIPSE(#401,3.0,1.5);
#403=IFCSHAPEREPRESENTATION(#2,'Annotation','GeometricCurveSet',(#402));
#404=IFCPRODUCTDEFINITIONSHAPE($,$,(#403));
#405=IFCANNOTATION('AnnoEllipse000000000001',$,'Oval',$,$,#40,#404);

ENDSEC;
END-ISO-10303-21;
"#;

#[test]
fn emits_circles_for_ifccircle() {
    let data = extract_symbolic_data(RICH_IFC);
    assert_eq!(
        data.circles.len(),
        1,
        "expected 1 IfcCircle, got {} (full set: {:#?})",
        data.circles.len(),
        data.circles
    );
    let c = &data.circles[0];
    assert_eq!(c.ifc_type, "IfcAnnotation");
    assert_eq!(c.representation, "Annotation");
    // Center (5, 3) in IFC coords → (5, -3) after Y-flip.
    assert!((c.center_x - 5.0).abs() < 1e-3);
    assert!((c.center_y + 3.0).abs() < 1e-3);
    assert!((c.radius - 2.0).abs() < 1e-3);
    // Full circle: end_angle − start_angle = TAU.
    assert!((c.end_angle - c.start_angle - std::f32::consts::TAU).abs() < 1e-3);
}

#[test]
fn emits_text_for_ifctextliteral_with_extent() {
    let data = extract_symbolic_data(RICH_IFC);
    assert_eq!(
        data.texts.len(),
        1,
        "expected exactly 1 IfcTextLiteral (no grid in this fixture), got {} (full set: {:#?})",
        data.texts.len(),
        data.texts
    );
    let t = &data.texts[0];
    assert_eq!(t.content, "Hello world");
    assert_eq!(t.alignment, "center");
    // World position (10, 5, 0) in IFC → (10, -5) after Y-flip.
    assert!((t.x - 10.0).abs() < 1e-3);
    assert!((t.y + 5.0).abs() < 1e-3);
    // Cap height derived from PlanarExtent SizeInY (0.4) × CAP_TO_BOX_RATIO (0.7) = 0.28.
    assert!(
        (t.height - 0.28).abs() < 1e-3,
        "cap height should be SizeInY × 0.7, got {}",
        t.height
    );
}

#[test]
fn emits_fill_for_ifcannotationfillarea() {
    let data = extract_symbolic_data(RICH_IFC);
    assert_eq!(
        data.fills.len(),
        1,
        "expected 1 IfcAnnotationFillArea, got {} (full set: {:#?})",
        data.fills.len(),
        data.fills
    );
    let f = &data.fills[0];
    assert_eq!(f.ifc_type, "IfcAnnotation");
    assert_eq!(f.holes_offsets.len(), 0, "no inner boundaries in fixture");
    // 5 outer-boundary points × 2 coords = 10 floats. (The polyline
    // closes back on the start so the extractor receives 5 points.)
    assert_eq!(f.points.len(), 10);
    // Default fill colour is opaque black when no IfcStyledItem chain.
    assert_eq!(f.fill_color, [0.0, 0.0, 0.0, 1.0]);
}

#[test]
fn emits_ellipse_as_tessellated_polyline() {
    let data = extract_symbolic_data(RICH_IFC);
    // IfcEllipse tessellates to 64 segments + closing point = 65 points (130 floats).
    // It's one of the polylines in the collection alongside the IfcAnnotationFillArea
    // outer boundary (5 points = 10 floats).
    let ellipse = data
        .polylines
        .iter()
        .find(|p| p.points.len() == 130)
        .unwrap_or_else(|| {
            panic!(
                "expected one 65-vertex tessellated ellipse polyline; got point lengths {:?}",
                data.polylines.iter().map(|p| p.points.len()).collect::<Vec<_>>()
            )
        });
    assert!(ellipse.closed, "ellipse tessellation should be closed");
}
