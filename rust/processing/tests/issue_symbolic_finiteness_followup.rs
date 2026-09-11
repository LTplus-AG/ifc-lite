// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Follow-up coverage for the finiteness sweep in `issue_fill_finiteness.rs`.
//!
//! That test only contrasts `fill.rs` against `items.rs`'s bare-polyline
//! path — it says nothing about `grid.rs`'s or `text.rs`'s guards, nor about
//! a FOURTH gap an adversarial review of PR #4185 found: `items.rs`'s
//! `IfcCircle` branch checks only its own LOCAL `center_x`/`center_y` before
//! `return`ing early, then pushes the POST-transform `(px, py)` unchecked.
//! An ambient placement with a malformed STEP REAL (`1.E400`) in its
//! `Location` — read by `parse_axis2_placement_2d` with no finiteness check
//! — turns a perfectly finite local center into a non-finite world point.
//! Fixed by guarding inside `output_cap.rs`'s `push_circle`, the single
//! chokepoint every circle-producing call site feeds through (mirroring how
//! `push_finite_point` is the chokepoint for point-list pushes), rather than
//! at the `items.rs` call site — a per-call-site guard is exactly what let
//! this gap open despite the sibling polyline/ellipse paths already being
//! guarded post-transform.

use ifc_lite_processing::extract_symbolic_data;

const BOILERPLATE_HEADER: &str = r#"ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('symbolic finiteness follow-up fixture'),'2;1');
FILE_NAME('test.ifc','2026-09-09',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0$ScRe4drECQ4DMSqUjd6e',$,'P',$,$,$,$,(#2),#3);
#2=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.0E-5,#5,$);
#3=IFCUNITASSIGNMENT((#6));
#4=IFCCARTESIANPOINT((0.,0.,0.));
#5=IFCAXIS2PLACEMENT3D(#4,$,$);
#6=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
"#;

/// Gap 1: an ambient `IfcLocalPlacement` whose `Location` carries `1.E400`
/// (#7/#8/#40) makes `Transform2D.tx = Infinity`, while the `IfcCircle`
/// itself (#70-#72) has a perfectly finite local center. `items.rs` only
/// checks the local center, so the non-finite value must be caught
/// POST-transform, at (or before) `push_circle`.
const CIRCLE_WITH_INFINITE_AMBIENT_PLACEMENT: &str = r#"
#7=IFCCARTESIANPOINT((1.E400,0.,0.));
#8=IFCAXIS2PLACEMENT3D(#7,$,$);
#40=IFCLOCALPLACEMENT($,#8);
#70=IFCCARTESIANPOINT((0.,0.));
#71=IFCAXIS2PLACEMENT2D(#70,$);
#72=IFCCIRCLE(#71,2.);
#60=IFCSHAPEREPRESENTATION(#2,'Annotation','Curve2D',(#72));
#61=IFCPRODUCTDEFINITIONSHAPE($,$,(#60));
#62=IFCANNOTATION('1xScRe4drECQ4DMSqUjd6e',$,'Note',$,$,#40,#61);
ENDSEC;
END-ISO-10303-21;
"#;

/// Gap 2a: `grid.rs`'s `IfcGridAxis` endpoint sampling. The axis curve's
/// second point (#11) carries `1.E400` directly, so the endpoint is
/// non-finite even under an identity ambient placement.
const GRID_AXIS_WITH_INFINITE_ENDPOINT: &str = r#"
#10=IFCCARTESIANPOINT((0.,0.));
#11=IFCCARTESIANPOINT((1.E400,5.));
#20=IFCPOLYLINE((#10,#11));
#30=IFCGRIDAXIS('A1',#20,.T.);
#40=IFCLOCALPLACEMENT($,#5);
#50=IFCGRID('2xScRe4drECQ4DMSqUjd6e',$,'Grid',$,$,#40,$,(#30),(),());
ENDSEC;
END-ISO-10303-21;
"#;

/// Gap 2b: `text.rs`'s `IfcTextLiteral` placement. Same ambient-placement
/// shape as the circle fixture above (#7/#8/#40 carry `1.E400`), but through
/// the text literal's own `Placement` composition instead of a bare item
/// transform.
const TEXT_LITERAL_WITH_INFINITE_AMBIENT_PLACEMENT: &str = r#"
#7=IFCCARTESIANPOINT((1.E400,0.,0.));
#8=IFCAXIS2PLACEMENT3D(#7,$,$);
#40=IFCLOCALPLACEMENT($,#8);
#70=IFCCARTESIANPOINT((0.,0.,0.));
#71=IFCAXIS2PLACEMENT3D(#70,$,$);
#72=IFCTEXTLITERAL('Hello',#71,.LEFT.);
#60=IFCSHAPEREPRESENTATION(#2,'Annotation','Annotation2D',(#72));
#61=IFCPRODUCTDEFINITIONSHAPE($,$,(#60));
#62=IFCANNOTATION('3xScRe4drECQ4DMSqUjd6e',$,'Note',$,$,#40,#61);
ENDSEC;
END-ISO-10303-21;
"#;

fn fixture(body: &str) -> String {
    format!("{BOILERPLATE_HEADER}{body}")
}

/// RED (before the `push_circle` guard existed): the circle's non-finite
/// world-space center survived into `SymbolicCircle`. GREEN: the circle is
/// dropped entirely, matching `items.rs`'s existing whole-item convention
/// for a degenerate `IfcCircle` (e.g. non-positive radius).
#[test]
fn circle_with_non_finite_ambient_placement_is_dropped() {
    let data = extract_symbolic_data(&fixture(CIRCLE_WITH_INFINITE_AMBIENT_PLACEMENT));
    assert!(
        data.circles.is_empty(),
        "a circle whose post-transform center is non-finite must be dropped by push_circle, \
         got {:?}",
        data.circles
    );
}

/// RED (if grid.rs's post-transform finiteness check were reverted): the
/// axis (and its bubble text/tag) would carry an Infinity endpoint. GREEN:
/// the whole axis is dropped (an axis is two points defining a segment, not
/// a droppable-point list).
#[test]
fn grid_axis_with_non_finite_endpoint_is_dropped() {
    let data = extract_symbolic_data(&fixture(GRID_AXIS_WITH_INFINITE_ENDPOINT));
    assert!(
        data.grid_axes.is_empty(),
        "a grid axis with a non-finite endpoint must be dropped, got {:?}",
        data.grid_axes
    );
    assert!(
        data.polylines.is_empty(),
        "the axis's rendered polyline must not be emitted either, got {:?}",
        data.polylines
    );
    assert!(
        data.texts.is_empty(),
        "the axis's bubble/tag text must not be emitted either, got {:?}",
        data.texts
    );
}

/// RED (if text.rs's finiteness check on the composed placement were
/// reverted): the text literal would carry an Infinity (x, y). GREEN: the
/// whole text item is dropped.
#[test]
fn text_literal_with_non_finite_placement_is_dropped() {
    let data = extract_symbolic_data(&fixture(TEXT_LITERAL_WITH_INFINITE_AMBIENT_PLACEMENT));
    assert!(
        data.texts.is_empty(),
        "a text literal whose composed placement is non-finite must be dropped, got {:?}",
        data.texts
    );
}
