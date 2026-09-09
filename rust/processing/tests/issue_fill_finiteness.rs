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

/// Sanity check on the fixture itself: `1.E400` must actually parse to a
/// non-finite f32 through the real extraction path, not silently become
/// `0.0` via `unwrap_or(0.0)` on a parse failure. If this fails, the fixture
/// needs a different malformed literal — it would not be exercising the bug.
#[test]
fn contrast_fixture_bare_polyline_drops_the_non_finite_point() {
    let data = extract_symbolic_data(BARE_POLYLINE_WITH_INFINITE_COORD);
    assert_eq!(
        data.polylines.len(),
        1,
        "expected exactly one polyline, got {:?}",
        data.polylines
    );
    let pts = &data.polylines[0].points;
    // 3 input points, one dropped (the non-finite one) -> 2 finite points -> 4 floats.
    assert_eq!(
        pts.len(),
        4,
        "items.rs must drop the non-finite point and keep the two finite ones, got {pts:?}"
    );
    for v in pts {
        assert!(v.is_finite(), "items.rs must never emit a non-finite coordinate, got {v}");
    }
}

/// RED (before the fix): `IfcAnnotationFillArea`'s boundary ring propagates
/// the non-finite coordinate straight into `SymbolicFillArea.points`,
/// diverging from the sibling polyline path above which drops it.
#[test]
fn fill_area_boundary_ring_must_not_emit_non_finite_points() {
    let data = extract_symbolic_data(FILL_AREA_WITH_INFINITE_COORD);
    assert_eq!(
        data.fills.len(),
        1,
        "expected exactly one fill area, got {:?}",
        data.fills
    );
    let pts = &data.fills[0].points;
    // 4 input points, one dropped (the non-finite one) -> 3 finite points -> 6 floats.
    assert_eq!(
        pts.len(),
        6,
        "fill.rs must drop the non-finite point and keep the three finite ones, got {pts:?}"
    );
    for v in pts {
        assert!(
            v.is_finite(),
            "fill.rs must never emit a non-finite coordinate into SymbolicFillArea.points, \
             got {v} in {pts:?} — this is the asymmetry with items.rs's guarded polyline path"
        );
    }
}
