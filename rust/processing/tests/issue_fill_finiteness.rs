// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! `fill.rs`'s `IfcAnnotationFillArea` boundary-ring extraction did not guard
//! coordinates with `is_finite()`, unlike `items.rs`'s line/polyline
//! extraction which does (`x.is_finite() && y.is_finite()` before pushing a
//! point). A non-finite STEP REAL (`1.E400`, or a hand-edited file) parsed to
//! `f32::INFINITY` and flowed unsanitized out of `extract_curve_ring`,
//! through the WASM boundary, into `Drawing2DState`.
//!
//! Both fixtures below carry the identical malformed coordinate
//! (`1.E400` on the second point of a multi-point boundary) so the only
//! variable is which extraction path reads it — `IfcAnnotationFillArea`
//! (fill.rs) vs. a bare `IfcPolyline` on an `IfcAnnotation` (items.rs).

use ifc_lite_processing::extract_symbolic_data;

const FILL_AREA_WITH_INFINITE_COORD: &str = r#"ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('fill-finiteness fixture'),'2;1');
FILE_NAME('test.ifc','2026-09-08',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0$ScRe4drECQ4DMSqUjd6d',$,'P',$,$,$,$,(#2),#3);
#2=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.0E-5,#5,$);
#3=IFCUNITASSIGNMENT((#6));
#4=IFCCARTESIANPOINT((0.,0.,0.));
#5=IFCAXIS2PLACEMENT3D(#4,$,$);
#6=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#10=IFCCARTESIANPOINT((0.,0.));
#11=IFCCARTESIANPOINT((1.E400,5.));
#12=IFCCARTESIANPOINT((10.,10.));
#13=IFCCARTESIANPOINT((0.,10.));
#20=IFCPOLYLINE((#10,#11,#12,#13));
#21=IFCANNOTATIONFILLAREA(#20,$);
#40=IFCLOCALPLACEMENT($,#5);
#60=IFCSHAPEREPRESENTATION(#2,'Annotation','Annotation2D',(#21));
#61=IFCPRODUCTDEFINITIONSHAPE($,$,(#60));
#62=IFCANNOTATION('2xScRe4drECQ4DMSqUjd6d',$,'Note',$,$,#40,#61);
ENDSEC;
END-ISO-10303-21;
"#;

const BARE_POLYLINE_WITH_INFINITE_COORD: &str = r#"ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('fill-finiteness contrast fixture'),'2;1');
FILE_NAME('test.ifc','2026-09-08',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0$ScRe4drECQ4DMSqUjd6d',$,'P',$,$,$,$,(#2),#3);
#2=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.0E-5,#5,$);
#3=IFCUNITASSIGNMENT((#6));
#4=IFCCARTESIANPOINT((0.,0.,0.));
#5=IFCAXIS2PLACEMENT3D(#4,$,$);
#6=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#10=IFCCARTESIANPOINT((0.,0.));
#11=IFCCARTESIANPOINT((1.E400,5.));
#12=IFCCARTESIANPOINT((10.,10.));
#20=IFCPOLYLINE((#10,#11,#12));
#40=IFCLOCALPLACEMENT($,#5);
#60=IFCSHAPEREPRESENTATION(#2,'Annotation','Annotation2D',(#20));
#61=IFCPRODUCTDEFINITIONSHAPE($,$,(#60));
#62=IFCANNOTATION('2xScRe4drECQ4DMSqUjd6d',$,'Note',$,$,#40,#61);
ENDSEC;
END-ISO-10303-21;
"#;

/// Since #7678 the STEP decode boundary refuses the point record holding
/// `1.E400` (a REAL the double range cannot represent) instead of decoding it
/// to infinity. `items.rs` resolves a polyline's points as one list, so the
/// polyline that referenced the refused point is refused whole rather than
/// drawn with that one point left out: it fails closed, and still emits no
/// non-finite coordinate.
#[test]
fn contrast_fixture_bare_polyline_drops_the_non_finite_point() {
    let data = extract_symbolic_data(BARE_POLYLINE_WITH_INFINITE_COORD)
        .expect("symbolic extraction must complete");
    assert!(
        data.polylines.is_empty(),
        "a polyline whose point the decode boundary refused must be refused whole, got {:?}",
        data.polylines
    );
    for v in data.polylines.iter().flat_map(|p| &p.points) {
        assert!(
            v.is_finite(),
            "items.rs must never emit a non-finite coordinate, got {v}"
        );
    }
}

/// RED (before the original fix): `IfcAnnotationFillArea`'s boundary ring
/// propagated the non-finite coordinate straight into
/// `SymbolicFillArea.points`. Since #7678 the decode boundary refuses that
/// point record, so the ring, and with it the fill, is refused whole like
/// the polyline above: no fill, and nothing non-finite.
#[test]
fn fill_area_boundary_ring_must_not_emit_non_finite_points() {
    let data = extract_symbolic_data(FILL_AREA_WITH_INFINITE_COORD)
        .expect("symbolic extraction must complete");
    assert!(
        data.fills.is_empty(),
        "a fill whose boundary point the decode boundary refused must be refused, got {:?}",
        data.fills
    );
    for v in data.fills.iter().flat_map(|f| &f.points) {
        assert!(
            v.is_finite(),
            "fill.rs must never emit a non-finite coordinate into SymbolicFillArea.points, got {v}"
        );
    }
}
