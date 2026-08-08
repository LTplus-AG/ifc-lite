// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Behaviour tests for `IfcTrimmedCurve` symbolic tessellation (PR #2356
//! review findings). The extractor used to interpret the trim angles in
//! WORLD X/Y and to read only the FIRST member of the `IfcTrimmingSelect`
//! set, so a rotated `IfcCircle.Position` put the arc in the wrong place
//! and a Cartesian-point trim silently degenerated to a full circle.
//!
//! Every assertion is on emitted coordinates, never on a flag.

use ifc_lite_processing::extract_symbolic_data;

/// Build a one-annotation fixture whose single representation item is an
/// `IfcTrimmedCurve` over an `IfcCircle` of radius 2 m centred at the
/// origin. `ref_direction` is the circle placement's RefDirection (`$`
/// for "absent → local X == world X"), `trim1`/`trim2` are the raw
/// `IfcTrimmingSelect` SET literals, and `extra` holds any entities the
/// trims refer to.
fn fixture(ref_direction: &str, trim1: &str, trim2: &str, master: &str, extra: &str) -> String {
    format!(
        r#"ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('issue-2356 fixture'),'2;1');
FILE_NAME('t.ifc','2026-08-08T00:00:00',(''),(''),'','','');
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
#40=IFCLOCALPLACEMENT($,#5);
#50=IFCCARTESIANPOINT((0.,0.,0.));
#51=IFCDIRECTION((0.,0.,1.));
#52=IFCAXIS2PLACEMENT3D(#50,#51,{ref_direction});
#53=IFCCIRCLE(#52,2.);
{extra}
#60=IFCTRIMMEDCURVE(#53,{trim1},{trim2},.T.,{master});
#61=IFCSHAPEREPRESENTATION(#2,'Annotation','Annotation2D',(#60));
#62=IFCPRODUCTDEFINITIONSHAPE($,$,(#61));
#63=IFCANNOTATION('2xScRe4drECQ4DMSqUjd6d',$,'Note',$,$,#40,#62);
ENDSEC;
END-ISO-10303-21;
"#
    )
}

/// First and last emitted point of the single polyline, as (x, y).
fn endpoints(ifc: &str) -> ((f32, f32), (f32, f32)) {
    let data = extract_symbolic_data(ifc);
    assert_eq!(
        data.polylines.len(),
        1,
        "expected exactly one polyline, got {}",
        data.polylines.len()
    );
    let p = &data.polylines[0];
    assert!(p.points.len() >= 4, "degenerate polyline: {:?}", p.points);
    let n = p.points.len();
    (
        (p.points[0], p.points[1]),
        (p.points[n - 2], p.points[n - 1]),
    )
}

fn assert_close(actual: (f32, f32), expected: (f32, f32), what: &str) {
    let d = ((actual.0 - expected.0).powi(2) + (actual.1 - expected.1).powi(2)).sqrt();
    assert!(
        d < 0.01,
        "{what}: expected ({:.4}, {:.4}), got ({:.4}, {:.4}) — off by {d:.4}",
        expected.0,
        expected.1,
        actual.0,
        actual.1
    );
}

/// BOUNDING CONTROL — must pass BEFORE and AFTER the basis fix.
/// A plain world-XY circle (RefDirection absent) trimmed 0 → π/2 starts
/// at (2,0) and ends at (0,2). The emitted Y is negated by the symbolic
/// projection, so (0,2) surfaces as (0,-2).
#[test]
fn world_xy_circle_with_angle_trims_is_unchanged() {
    let ifc = fixture(
        "$",
        "(IFCPARAMETERVALUE(0.))",
        "(IFCPARAMETERVALUE(1.5707963267948966))",
        ".PARAMETER.",
        "",
    );
    let (start, end) = endpoints(&ifc);
    assert_close(start, (2.0, 0.0), "world-XY arc start");
    assert_close(end, (0.0, -2.0), "world-XY arc end");
}

/// RED for finding 1 — the trim angles are measured from the circle's
/// OWN local X axis (`Position.RefDirection`), not from world X. With
/// RefDirection = (0,1,0) the local X axis is world +Y, so the 0 → π/2
/// arc runs from (0,2) to (-2,0). The old code ignored RefDirection and
/// emitted the unrotated arc, i.e. exactly the control's coordinates.
#[test]
fn rotated_circle_placement_rotates_the_trimmed_arc() {
    let ifc = fixture(
        "#54",
        "(IFCPARAMETERVALUE(0.))",
        "(IFCPARAMETERVALUE(1.5707963267948966))",
        ".PARAMETER.",
        "#54=IFCDIRECTION((0.,1.,0.));",
    );
    let (start, end) = endpoints(&ifc);
    assert_close(start, (0.0, -2.0), "rotated arc start");
    assert_close(end, (-2.0, -0.0), "rotated arc end");
}

/// RED for finding 2a — a trim expressed purely as `IfcCartesianPoint`
/// is a legal `IfcTrimmingSelect`. The old code found no float in the
/// set, fell back to (0, TAU) and drew the WHOLE circle: start and end
/// both landed on (2,0). The arc must run (2,0) → (0,2).
#[test]
fn cartesian_point_trims_produce_the_arc_not_a_full_circle() {
    let ifc = fixture(
        "$",
        "(#55)",
        "(#56)",
        ".CARTESIAN.",
        "#55=IFCCARTESIANPOINT((2.,0.,0.));\n#56=IFCCARTESIANPOINT((0.,2.,0.));",
    );
    let (start, end) = endpoints(&ifc);
    assert_close(start, (2.0, 0.0), "cartesian-trim arc start");
    assert_close(end, (0.0, -2.0), "cartesian-trim arc end");
}

/// RED for finding 2b — when the set carries BOTH representations the
/// parameter must still be found even though it is not the first member.
/// The old code only ever looked at `.first()`, so a point-first set
/// degenerated to the full circle.
#[test]
fn parameter_trim_is_found_when_it_is_not_the_first_set_member() {
    let ifc = fixture(
        "$",
        "(#55,IFCPARAMETERVALUE(0.))",
        "(#56,IFCPARAMETERVALUE(1.5707963267948966))",
        ".PARAMETER.",
        "#55=IFCCARTESIANPOINT((2.,0.,0.));\n#56=IFCCARTESIANPOINT((0.,2.,0.));",
    );
    let (start, end) = endpoints(&ifc);
    assert_close(start, (2.0, 0.0), "parameter-second arc start");
    assert_close(end, (0.0, -2.0), "parameter-second arc end");
}

/// RED for finding 4 — `radius > 100.0` collapsed any large-radius arc
/// to a two-point chord regardless of how much it actually bulges. A
/// 150 m radius swept 30° has a 5 m sagitta over a 77 m chord: visibly
/// curved, yet drawn as a straight line. Only the relative criteria
/// (sagitta vs chord, radius vs chord) may decide this.
#[test]
fn large_radius_arc_with_real_sagitta_is_not_flattened() {
    let ifc = r#"ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('issue-2356 fixture'),'2;1');
FILE_NAME('t.ifc','2026-08-08T00:00:00',(''),(''),'','','');
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
#40=IFCLOCALPLACEMENT($,#5);
#50=IFCCARTESIANPOINT((0.,0.,0.));
#51=IFCDIRECTION((0.,0.,1.));
#52=IFCAXIS2PLACEMENT3D(#50,#51,$);
#53=IFCCIRCLE(#52,150.);
#60=IFCTRIMMEDCURVE(#53,(IFCPARAMETERVALUE(0.)),(IFCPARAMETERVALUE(0.5235987755982988)),.T.,.PARAMETER.);
#61=IFCSHAPEREPRESENTATION(#2,'Annotation','Annotation2D',(#60));
#62=IFCPRODUCTDEFINITIONSHAPE($,$,(#61));
#63=IFCANNOTATION('2xScRe4drECQ4DMSqUjd6d',$,'Note',$,$,#40,#62);
ENDSEC;
END-ISO-10303-21;
"#;
    let data = extract_symbolic_data(ifc);
    assert_eq!(data.polylines.len(), 1);
    let p = &data.polylines[0];
    assert!(
        p.points.len() > 4,
        "a 150 m radius arc with a 5 m sagitta must be tessellated, not \
         collapsed to a 2-point chord; got {} points",
        p.points.len() / 2
    );
    // The tessellated midpoint must sit off the chord by ~5 m.
    let n = p.points.len();
    let (sx, sy) = (p.points[0], p.points[1]);
    let (ex, ey) = (p.points[n - 2], p.points[n - 1]);
    let mid = (n / 2) & !1;
    let (mx, my) = (p.points[mid], p.points[mid + 1]);
    let chord = ((ex - sx).powi(2) + (ey - sy).powi(2)).sqrt();
    let sagitta = ((ey - sy) * mx - (ex - sx) * my + ex * sy - ey * sx).abs() / chord;
    assert!(
        sagitta > 4.0,
        "midpoint should bulge ~5 m off the chord, got {sagitta:.3} m"
    );
}

/// BOUNDING CONTROL for finding 4 — a genuinely shallow large-radius arc
/// (150 m radius swept 1°) still collapses to a straight chord via the
/// RELATIVE criteria. Must pass before and after.
#[test]
fn shallow_large_radius_arc_still_collapses_to_a_chord() {
    let ifc = r#"ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('issue-2356 fixture'),'2;1');
FILE_NAME('t.ifc','2026-08-08T00:00:00',(''),(''),'','','');
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
#40=IFCLOCALPLACEMENT($,#5);
#50=IFCCARTESIANPOINT((0.,0.,0.));
#51=IFCDIRECTION((0.,0.,1.));
#52=IFCAXIS2PLACEMENT3D(#50,#51,$);
#53=IFCCIRCLE(#52,150.);
#60=IFCTRIMMEDCURVE(#53,(IFCPARAMETERVALUE(0.)),(IFCPARAMETERVALUE(0.017453292519943295)),.T.,.PARAMETER.);
#61=IFCSHAPEREPRESENTATION(#2,'Annotation','Annotation2D',(#60));
#62=IFCPRODUCTDEFINITIONSHAPE($,$,(#61));
#63=IFCANNOTATION('2xScRe4drECQ4DMSqUjd6d',$,'Note',$,$,#40,#62);
ENDSEC;
END-ISO-10303-21;
"#;
    let data = extract_symbolic_data(ifc);
    assert_eq!(data.polylines.len(), 1);
    assert_eq!(
        data.polylines[0].points.len(),
        4,
        "a 1-degree sweep is a chord: expected 2 points"
    );
}

/// BOUNDING CONTROL — reversed `SenseAgreement` still wraps the other
/// way. 0 → π/2 with `.F.` sweeps the long way round, so the arc ends at
/// (0,2) having travelled through (-2,0) and (0,-2).
#[test]
fn reversed_sense_sweeps_the_complementary_arc() {
    let ifc = fixture(
        "$",
        "(IFCPARAMETERVALUE(0.))",
        "(IFCPARAMETERVALUE(1.5707963267948966))",
        ".PARAMETER.",
        "",
    )
    .replace(",.T.,.PARAMETER.", ",.F.,.PARAMETER.");
    let data = extract_symbolic_data(&ifc);
    assert_eq!(data.polylines.len(), 1);
    let p = &data.polylines[0];
    let n = p.points.len();
    assert_close((p.points[0], p.points[1]), (2.0, 0.0), "reversed start");
    assert_close(
        (p.points[n - 2], p.points[n - 1]),
        (0.0, -2.0),
        "reversed end",
    );
    // Travelling the long way must pass near (-2, 0).
    let passes_left = (0..n / 2).any(|i| {
        let (x, y) = (p.points[2 * i], p.points[2 * i + 1]);
        (x + 2.0).abs() < 0.1 && y.abs() < 0.1
    });
    assert!(passes_left, "reversed sweep should pass through (-2, 0)");
}
