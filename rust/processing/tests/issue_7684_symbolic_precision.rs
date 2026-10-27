// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! #7684 PROCESSING-SYM-4: the symbolic overlay keeps georeferenced
//! precision through the RTC rebase.
//!
//! The extractor cast every placement and coordinate to f32 when it read
//! them, then subtracted an f32 offset from an f32 world coordinate. At
//! 5,000 km the f32 step is 0.5 m: `5_000_000.3` reads as `5_000_000.5`, so a
//! symbol drew 0.2 m off where the mesh beside it (re-based in f64,
//! `mapped_operator_precision.rs`) sits. `symbolic_rtc_frame.rs` only reaches
//! 12 km, where the step is 1 mm, so it could not see this.
//!
//! The expectation is the f64 analytic answer, `P − anchor` cast once. Every
//! primitive kind that turns a coordinate into a plan point is covered:
//! polyline (via `IfcCartesianPoint`), indexed poly-curve, circle centre,
//! ellipse samples, text anchor, fill ring and grid axis, plus the elevation.

use ifc_lite_processing::{extract_symbolic_data_with_provenance_in_frame, MeshFrame, SymbolicData};

/// Placement of every annotation, metres. Fractional parts are NOT multiples
/// of the f32 step at this magnitude (0.5 m in X/Y, 2^-14 m in Z).
const AT: (f64, f64, f64) = (5_000_000.3, 4_999_999.7, 412.37);
/// The frame anchor (what the bake subtracts). Exact in f32, so the whole
/// base-side error comes from reading `AT` into f32.
const ANCHOR: (f64, f64, f64) = (5_000_000.0, 5_000_000.0, 400.0);
/// Every point lands within this of its f64 answer. The f32 cast of a value
/// under 10 m is good to ~1 µm; the base error is 0.2 m.
const TOL: f32 = 1e-4;

fn fixture() -> String {
    let (x, y, z) = AT;
    format!(
        "ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('7684 symbolic precision'),'2;1');
FILE_NAME('t.ifc','2026-10-16T00:00:00',(''),(''),'','','');
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
#10=IFCCARTESIANPOINT(({x:?},{y:?},{z:?}));
#11=IFCAXIS2PLACEMENT3D(#10,$,$);
#12=IFCLOCALPLACEMENT($,#11);
#20=IFCCARTESIANPOINT((0.,0.));
#21=IFCCARTESIANPOINT((3.,1.));
#22=IFCPOLYLINE((#20,#21));
#30=IFCCARTESIANPOINTLIST2D(((1.,2.),(2.,3.)));
#31=IFCINDEXEDPOLYCURVE(#30,$,$);
#40=IFCCARTESIANPOINT((0.5,0.25,0.));
#41=IFCAXIS2PLACEMENT3D(#40,$,$);
#42=IFCCIRCLE(#41,0.75);
#43=IFCELLIPSE(#41,1.5,0.5);
#50=IFCCARTESIANPOINT((2.,-1.));
#51=IFCAXIS2PLACEMENT2D(#50,$);
#52=IFCTEXTLITERAL('Note',#51,.RIGHT.);
#60=IFCCARTESIANPOINT((0.,0.,0.));
#61=IFCCARTESIANPOINT((1.,0.,0.));
#62=IFCCARTESIANPOINT((1.,1.,0.));
#63=IFCPOLYLINE((#60,#61,#62));
#64=IFCANNOTATIONFILLAREA(#63,$);
#70=IFCSHAPEREPRESENTATION(#2,'Annotation','Annotation2D',(#22,#31,#42,#43,#52,#64));
#71=IFCPRODUCTDEFINITIONSHAPE($,$,(#70));
#72=IFCANNOTATION('2xScRe4drECQ4DMSqUjd60',$,'Note',$,$,#12,#71);
#80=IFCCARTESIANPOINT((0.,0.));
#81=IFCCARTESIANPOINT((4.,0.));
#82=IFCPOLYLINE((#80,#81));
#83=IFCGRIDAXIS('A',#82,.T.);
#84=IFCGRID('3xScRe4drECQ4DMSqUjd6d',$,'G',$,$,#12,$,(#83),$,$);
ENDSEC;
END-ISO-10303-21;
"
    )
}

fn extract() -> SymbolicData {
    let frame = MeshFrame::ModelRtc { anchor: ANCHOR };
    extract_symbolic_data_with_provenance_in_frame(fixture().as_bytes(), frame).expect("symbolic extraction must complete").into_parts().0
}

/// Render-frame plan pair of the local point `(lx, ly)`, computed in f64.
fn plan(lx: f64, ly: f64) -> (f32, f32) {
    ((AT.0 + lx - ANCHOR.0) as f32, (-(AT.1 + ly - ANCHOR.1)) as f32)
}

fn near(what: &str, got: (f32, f32), want: (f32, f32), off: &mut Vec<String>) {
    let (dx, dy) = (got.0 - want.0, got.1 - want.1);
    if dx.abs() > TOL || dy.abs() > TOL {
        off.push(format!("{what}: got {got:?}, want {want:?} (off by {dx:.4}, {dy:.4} m)"));
    }
}

/// Every kind is checked before failing, so one red run lists them all.
#[test]
fn issue_7684_symbols_at_five_thousand_kilometres_land_on_their_f64_positions() {
    let data = extract();
    let mut off = Vec::new();
    let pair = |p: &[f32], i: usize| (p[2 * i], p[2 * i + 1]);

    let by_points = |first: (f32, f32)| {
        data.polylines.iter().find(|l| {
            let d = (l.points[0] - first.0, l.points[1] - first.1);
            d.0.abs() < 0.6 && d.1.abs() < 0.6
        })
    };
    // IfcPolyline (0,0)-(3,1).
    let line = by_points(plan(0.0, 0.0)).expect("polyline");
    near("polyline start", pair(&line.points, 0), plan(0.0, 0.0), &mut off);
    near("polyline end", pair(&line.points, 1), plan(3.0, 1.0), &mut off);
    // IfcIndexedPolyCurve (1,2)-(2,3).
    let curve = by_points(plan(1.0, 2.0)).expect("indexed poly-curve");
    near("indexed poly-curve start", pair(&curve.points, 0), plan(1.0, 2.0), &mut off);
    near("indexed poly-curve end", pair(&curve.points, 1), plan(2.0, 3.0), &mut off);
    // IfcEllipse: its first sample is centre + SemiAxis1 along local +X.
    let ellipse = by_points(plan(2.0, 0.25)).expect("ellipse");
    near("ellipse sample 0", pair(&ellipse.points, 0), plan(2.0, 0.25), &mut off);

    let circle = data.circles.first().expect("circle");
    near("circle centre", (circle.center_x, circle.center_y), plan(0.5, 0.25), &mut off);

    let text = data.texts.iter().find(|t| t.content == "Note").expect("text");
    near("text anchor", (text.x, text.y), plan(2.0, -1.0), &mut off);

    let fill = data.fills.first().expect("fill");
    near("fill ring 0", pair(&fill.points, 0), plan(0.0, 0.0), &mut off);
    near("fill ring 2", pair(&fill.points, 2), plan(1.0, 1.0), &mut off);

    let axis = data.grid_axes.first().expect("grid axis");
    near("grid axis start", (axis.endpoints[0], axis.endpoints[1]), plan(0.0, 0.0), &mut off);
    near("grid axis end", (axis.endpoints[2], axis.endpoints[3]), plan(4.0, 0.0), &mut off);

    let elevation = (AT.2 - ANCHOR.2) as f32;
    if (line.world_y - elevation).abs() > TOL {
        off.push(format!("polyline world_y {} want {elevation}", line.world_y));
    }
    assert!(off.is_empty(), "symbols are off their f64 positions:\n{}", off.join("\n"));
}
