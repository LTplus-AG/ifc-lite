// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Fifth leaf in the symbolic finiteness sweep (see
//! `issue_symbolic_finiteness_followup.rs` for the first four):
//! `trimmed_curve.rs`'s `is_near_collinear` branch builds its two-point
//! chord from `transform.transform_point(...)` / `rebase.plan(...)` and
//! calls `out.push_polyline` with no finiteness check, while its own
//! sibling arc-tessellation branch a few lines below routes every point
//! through `push_finite_point`. An ambient placement with a malformed STEP
//! REAL (`1.E400`) in its `Location` — read by `parse_axis2_placement_2d`
//! with no finiteness check — turns a perfectly finite local chord into a
//! non-finite world one.

use ifc_lite_processing::extract_symbolic_data;

const BOILERPLATE_HEADER: &str = r#"ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('trimmed curve finiteness fixture'),'2;1');
FILE_NAME('test.ifc','2026-09-09',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0$ScRe4drECQ4DMSqUjd6f',$,'P',$,$,$,$,(#2),#3);
#2=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.0E-5,#5,$);
#3=IFCUNITASSIGNMENT((#6));
#4=IFCCARTESIANPOINT((0.,0.,0.));
#5=IFCAXIS2PLACEMENT3D(#4,$,$);
#6=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#90=IFCCARTESIANPOINT((0.,0.));
#91=IFCAXIS2PLACEMENT2D(#90,$);
#92=IFCCIRCLE(#91,10.);
#93=IFCTRIMMEDCURVE(#92,(0.),(0.001),.T.,.PARAMETER.);
#60=IFCSHAPEREPRESENTATION(#2,'Annotation','Curve2D',(#93));
#61=IFCPRODUCTDEFINITIONSHAPE($,$,(#60));
"#;

/// The trimmed curve's OWN basis (#91) is a perfectly finite, un-rotated
/// placement at the origin — `trimmed_curve.rs`'s existing
/// `!basis.tx.is_finite() || !basis.ty.is_finite()` guard (line ~59) does
/// NOT fire here. The angle span (0 to 0.001 rad on a radius-10 circle) is
/// tiny, so `is_near_collinear` is true and the buggy two-point chord
/// branch runs. Only the AMBIENT `IfcLocalPlacement` (#40, composed in as
/// `transform`, not `basis`) is poisoned.
const POISONED_AMBIENT_PLACEMENT: &str = r#"
#7=IFCCARTESIANPOINT((1.E400,0.,0.));
#8=IFCAXIS2PLACEMENT3D(#7,$,$);
#40=IFCLOCALPLACEMENT($,#8);
#62=IFCANNOTATION('1xScRe4drECQ4DMSqUjd6f',$,'Note',$,$,#40,#61);
ENDSEC;
END-ISO-10303-21;
"#;

/// Control fixture: identical geometry, but the ambient placement is
/// well-formed (identity, via #5). Establishes that the near-collinear
/// chord is emitted normally when nothing is malformed, so the fix does
/// not silently swallow legitimate near-collinear trimmed arcs.
const WELL_FORMED_AMBIENT_PLACEMENT: &str = r#"
#40=IFCLOCALPLACEMENT($,#5);
#62=IFCANNOTATION('2xScRe4drECQ4DMSqUjd6f',$,'Note',$,$,#40,#61);
ENDSEC;
END-ISO-10303-21;
"#;

fn fixture(body: &str) -> String {
    format!("{BOILERPLATE_HEADER}{body}")
}

/// RED (before the fix): the near-collinear chord's non-finite world-space
/// endpoints survived into `SymbolicPolyline`. GREEN: the trimmed curve is
/// dropped entirely, matching the sibling arc-tessellation branch's
/// existing convention (and `items.rs`'s convention for other degenerate
/// symbolic primitives).
#[test]
fn near_collinear_trimmed_curve_with_non_finite_ambient_placement_is_dropped() {
    let data = extract_symbolic_data(&fixture(POISONED_AMBIENT_PLACEMENT));
    assert!(
        data.polylines.is_empty(),
        "a near-collinear trimmed curve whose post-transform chord is non-finite must be \
         dropped, got {:?}",
        data.polylines
    );
}

/// Sanity/no-regression check: the same near-collinear trimmed curve under
/// a well-formed ambient placement must still be emitted as a two-point
/// polyline with finite coordinates.
#[test]
fn near_collinear_trimmed_curve_with_well_formed_placement_is_emitted() {
    let data = extract_symbolic_data(&fixture(WELL_FORMED_AMBIENT_PLACEMENT));
    assert_eq!(
        data.polylines.len(),
        1,
        "a well-formed near-collinear trimmed curve must still be emitted, got {:?}",
        data.polylines
    );
    let polyline = &data.polylines[0];
    assert_eq!(polyline.points.len(), 4, "expected a two-point chord, got {:?}", polyline.points);
    assert!(
        polyline.points.iter().all(|v| v.is_finite()),
        "all emitted points must be finite, got {:?}",
        polyline.points
    );
}
