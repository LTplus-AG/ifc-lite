// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! The symbolic stream must land in the SAME frame as the mesh stream.
//!
//! The mesh pipeline stores `world = origin + position + rtc_offset` in IFC
//! Z-up metres (`rust/processing/src/simplify_session.rs:231`), i.e. every
//! vertex is re-based by the whole three-component RTC offset, elevation
//! included. The viewer then reads Y-up: `renderX = ifcX - rtc.x`,
//! `renderZ = -(ifcY - rtc.y)`, `renderY = ifcZ - rtc.z`
//! (`apps/viewer/src/lib/wall-rects-from-meshes.ts:126-144`;
//! `rust/wasm-bindings/src/api/grid_lines.rs`'s `to_render_frame` is the same
//! conversion for the 3D grid overlay).
//!
//! The symbolic extractor emits a plan pair `(x, y2d)` and a separate
//! elevation `world_y`, which the viewer overlays directly on the mesh scene
//! (`apps/viewer/src/hooks/useSymbolicAnnotations.ts:110` lifts each 2D line
//! to `world_y`) and section-clips against render-frame bounds
//! (`apps/viewer/src/components/viewer/Viewport.tsx:1418-1444`). So the three
//! emitted numbers must equal `renderX`, `renderZ` and `renderY` above.
//!
//! No test pinned that agreement, and both mismatches this file covers were
//! live: the plan Y flip re-based by the RTC offset's Z (elevation) component
//! instead of its Y, and `world_y` was never re-based at all.
//!
//! Fixture notes (a frame bug is invisible in a symmetric fixture):
//!  - THREE placements, so the per-axis median RTC offset differs from every
//!    element's own coordinates and the expected values are non-zero.
//!  - the RTC offset's three components are mutually distinct, and its Y is
//!    negative, so subtracting the wrong one cannot coincide.
//!  - millimetre units (scale 0.001, not 1), with raw values below 2^24 so
//!    the f32 arithmetic stays exact enough to assert on.
//!  - every `world_y` producer in the extractor is exercised — polyline,
//!    circle, text literal, fill area, trimmed curve and grid axis — because
//!    the elevation is a bare `f32` at each of those call sites, so a missed
//!    one is silent.

use ifc_lite_processing::extract_symbolic_data;

/// Placements in raw file units (millimetres). The per-axis median — the RTC
/// offset the detector picks (`rust/geometry/src/router/rtc_offset.rs:35-64`)
/// — is `MID`, so no element sits at the offset itself.
const LOW: (f64, f64, f64) = (12_000_000.0, -14_500_000.0, 400_000.0);
const MID: (f64, f64, f64) = (12_050_000.0, -14_530_000.0, 407_000.0);
const HIGH: (f64, f64, f64) = (12_120_000.0, -14_600_000.0, 415_000.0);

const MM: f64 = 0.001;

/// Express id of the annotation at each placement.
const LOW_ID: u32 = 108;
const MID_ID: u32 = 208;
const HIGH_ID: u32 = 308;
/// The grid axis, placed at `HIGH`.
const AXIS_ID: u32 = 906;

fn annotation(index: usize, placement: (f64, f64, f64)) -> String {
    let base = 100 + 100 * index as u32;
    // Only the first annotation carries the full primitive zoo; the others
    // stay single polylines so the median placement is unambiguous.
    let items = if index == 0 {
        format!(
            "#{},#{},#{},#{},#{}",
            base + 3,
            base + 20,
            base + 30,
            base + 40,
            base + 50
        )
    } else {
        format!("#{}", base + 3)
    };
    let mut s = format!(
        "#{pt}=IFCCARTESIANPOINT(({x:.1},{y:.1},{z:.1}));\n\
         #{ax}=IFCAXIS2PLACEMENT3D(#{pt},$,$);\n\
         #{pl}=IFCLOCALPLACEMENT($,#{ax});\n\
         #{a}=IFCCARTESIANPOINT((0.,0.));\n\
         #{b}=IFCCARTESIANPOINT((3000.,0.));\n\
         #{ln}=IFCPOLYLINE((#{a},#{b}));\n\
         #{rep}=IFCSHAPEREPRESENTATION(#2,'Annotation','Annotation2D',({items}));\n\
         #{pds}=IFCPRODUCTDEFINITIONSHAPE($,$,(#{rep}));\n\
         #{an}=IFCANNOTATION('2xScRe4drECQ4DMSqUjd6{index}',$,'Note',$,$,#{pl},#{pds});\n",
        pt = base,
        ax = base + 1,
        pl = base + 2,
        a = base + 4,
        b = base + 5,
        ln = base + 3,
        rep = base + 6,
        pds = base + 7,
        an = base + 8,
        x = placement.0,
        y = placement.1,
        z = placement.2,
        items = items,
        index = index,
    );
    if index == 0 {
        s.push_str(&format!(
            "#{cp}=IFCCARTESIANPOINT((0.,0.,0.));\n\
             #{cax}=IFCAXIS2PLACEMENT3D(#{cp},$,$);\n\
             #{c}=IFCCIRCLE(#{cax},2000.);\n\
             #{tp}=IFCCARTESIANPOINT((0.,0.));\n\
             #{tax}=IFCAXIS2PLACEMENT2D(#{tp},$);\n\
             #{t}=IFCTEXTLITERAL('Note',#{tax},.RIGHT.);\n\
             #{fa}=IFCCARTESIANPOINT((0.,0.,0.));\n\
             #{fb}=IFCCARTESIANPOINT((1000.,0.,0.));\n\
             #{fc}=IFCCARTESIANPOINT((1000.,1000.,0.));\n\
             #{fl}=IFCPOLYLINE((#{fa},#{fb},#{fc}));\n\
             #{f}=IFCANNOTATIONFILLAREA(#{fl},$);\n\
             #{tc}=IFCTRIMMEDCURVE(#{c},(IFCPARAMETERVALUE(0.)),(IFCPARAMETERVALUE(1.5)),.T.,.PARAMETER.);\n",
            cp = base + 21,
            cax = base + 22,
            c = base + 20,
            tp = base + 31,
            tax = base + 32,
            t = base + 30,
            fa = base + 41,
            fb = base + 42,
            fc = base + 43,
            fl = base + 44,
            f = base + 40,
            tc = base + 50,
        ));
    }
    s
}

fn fixture() -> String {
    let mut s = String::from(
        r#"ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('symbolic rtc frame fixture'),'2;1');
FILE_NAME('t.ifc','2026-08-22T00:00:00',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0$ScRe4drECQ4DMSqUjd6d',$,'P',$,$,$,$,(#2),#3);
#2=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.0E-5,#5,$);
#3=IFCUNITASSIGNMENT((#6,#7));
#4=IFCCARTESIANPOINT((0.,0.,0.));
#5=IFCAXIS2PLACEMENT3D(#4,$,$);
#6=IFCSIUNIT(*,.LENGTHUNIT.,.MILLI.,.METRE.);
#7=IFCSIUNIT(*,.PLANEANGLEUNIT.,$,.RADIAN.);
"#,
    );
    for (i, p) in [LOW, MID, HIGH].iter().enumerate() {
        s.push_str(&annotation(i, *p));
    }
    // The grid is a separate extractor entry point with its own `world_y`.
    // Placed at HIGH — a DIFFERENT placement from the primitive zoo — so the
    // two expectations stay distinguishable.
    s.push_str(&format!(
        "#900=IFCCARTESIANPOINT(({x:.1},{y:.1},{z:.1}));\n\
         #901=IFCAXIS2PLACEMENT3D(#900,$,$);\n\
         #902=IFCLOCALPLACEMENT($,#901);\n\
         #903=IFCCARTESIANPOINT((0.,0.));\n\
         #904=IFCCARTESIANPOINT((5000.,0.));\n\
         #905=IFCPOLYLINE((#903,#904));\n\
         #906=IFCGRIDAXIS('A',#905,.T.);\n\
         #907=IFCGRID('3xScRe4drECQ4DMSqUjd6d',$,'G',$,$,#902,$,(#906),$,$);\n",
        x = HIGH.0,
        y = HIGH.1,
        z = HIGH.2,
    ));
    s.push_str("ENDSEC;\nEND-ISO-10303-21;\n");
    s
}

/// Render-frame expectation for one placement, in metres.
fn expected(p: (f64, f64, f64)) -> (f32, f32, f32) {
    (
        ((p.0 - MID.0) * MM) as f32,
        (-(p.1 - MID.1) * MM) as f32,
        ((p.2 - MID.2) * MM) as f32,
    )
}

/// The placement every primitive owned by `express_id` was authored at.
fn placement_of(express_id: u32) -> Option<(f64, f64, f64)> {
    match express_id {
        LOW_ID => Some(LOW),
        MID_ID => Some(MID),
        HIGH_ID | AXIS_ID => Some(HIGH),
        _ => None,
    }
}

fn assert_axis(actual: f32, want: f32, axis: &str, which: &str) {
    assert!(
        (actual - want).abs() < 0.01,
        "{which} {axis}: expected {want:.4} m in the render frame, got {actual:.4} m \
         (off by {:.4} m)",
        actual - want,
    );
}

/// The plan pair must re-base by the RTC offset's X and Y. Re-basing the
/// northing by the offset's Z instead leaves the overlay ~14.5 km away in the
/// render-Z direction while the meshes sit near the origin.
#[test]
fn plan_coordinates_land_in_the_mesh_render_frame() {
    let data = extract_symbolic_data(&fixture());
    let mut checked = 0;
    for (label, id) in [("LOW", LOW_ID), ("MID", MID_ID), ("HIGH", HIGH_ID)] {
        // The plain `IfcPolyline` is item 0 of each representation, so it is
        // the first polyline emitted for that owner; its local (0,0) start
        // sits exactly on the placement.
        let p = data
            .polylines
            .iter()
            .find(|p| p.express_id == id)
            .unwrap_or_else(|| panic!("{label}: no polyline emitted for #{id}"));
        assert!(p.points.len() >= 4, "{label}: degenerate polyline");
        let want = expected(placement_of(id).unwrap());
        assert_axis(p.points[0], want.0, "x", label);
        assert_axis(p.points[1], want.1, "y2d", label);
        checked += 1;
    }
    assert_eq!(checked, 3, "every placement must be covered");
}

/// `world_y` is the elevation the viewer lifts each annotation to, and the
/// value its grid section-clip compares against render-frame bounds. The mesh
/// pipeline subtracts the RTC offset's Z from every vertex, so every symbolic
/// elevation — from every producer — must be re-based by the same amount.
#[test]
fn every_primitive_kinds_elevation_lands_in_the_mesh_render_frame() {
    let data = extract_symbolic_data(&fixture());

    let mut seen: Vec<&str> = Vec::new();
    let check = |kind: &'static str, express_id: u32, world_y: f32, seen: &mut Vec<&str>| {
        let Some(placement) = placement_of(express_id) else {
            return;
        };
        assert_axis(world_y, expected(placement).2, "world_y", kind);
        if !seen.contains(&kind) {
            seen.push(kind);
        }
    };

    for p in &data.polylines {
        check("polyline", p.express_id, p.world_y, &mut seen);
    }
    for c in &data.circles {
        check("circle", c.express_id, c.world_y, &mut seen);
    }
    for t in &data.texts {
        check("text", t.express_id, t.world_y, &mut seen);
    }
    for f in &data.fills {
        check("fill", f.express_id, f.world_y, &mut seen);
    }
    for a in &data.grid_axes {
        check("grid-axis", a.express_id, a.world_y, &mut seen);
    }

    // Guard the guard: an extractor change that stops emitting a kind must not
    // read as "every elevation checked out".
    for kind in ["polyline", "circle", "text", "fill", "grid-axis"] {
        assert!(
            seen.contains(&kind),
            "no {kind} reached the elevation check — the fixture no longer \
             covers that producer (saw: {seen:?})"
        );
    }
}

/// `IfcTrimmedCurve` emits *polylines*, so the coverage guard above cannot see
/// it: the fixture's plain `IfcPolyline` fills the "polyline" slot whether or
/// not the trimmed curve produced anything. Everything a trimmed curve emits
/// also carries its owning annotation's express id, so the id cannot separate
/// them either. Its arc geometry can: a tessellated 1.5 rad sweep of a 2 m
/// radius is not something the straight two-point polyline can imitate.
#[test]
fn the_trimmed_curve_emits_its_arc_in_the_render_frame() {
    let data = extract_symbolic_data(&fixture());
    let want = expected(placement_of(LOW_ID).unwrap());

    // Radius 2000 mm about the annotation's own origin, swept 0 → 1.5 rad.
    const RADIUS_M: f32 = 2.0;
    const SWEEP_RAD: f32 = 1.5;

    let arc = data
        .polylines
        .iter()
        .filter(|p| p.express_id == LOW_ID)
        .find(|p| {
            p.points.len() > 8
                && p.points.chunks_exact(2).all(|c| {
                    let r = ((c[0] - want.0).powi(2) + (c[1] - want.1).powi(2)).sqrt();
                    (r - RADIUS_M).abs() < 0.05
                })
        })
        .expect(
            "no arc polyline at radius 2 m from the LOW placement — the trimmed \
             curve stopped emitting, or stopped being tessellated as an arc",
        );

    // Every sample sits in the render frame, not just the first: a rebase
    // applied to the start point alone would pass a start-only check.
    for c in arc.points.chunks_exact(2) {
        let r = ((c[0] - want.0).powi(2) + (c[1] - want.1).powi(2)).sqrt();
        assert!(
            (r - RADIUS_M).abs() < 0.05,
            "arc sample at radius {r:.4} m, expected {RADIUS_M:.4} m about \
             ({:.4}, {:.4})",
            want.0,
            want.1
        );
    }

    // The sweep pins the trim parameters. The plan flip mirrors the arc, which
    // reverses the direction but preserves the magnitude of the span.
    let angle = |i: usize| (arc.points[i + 1] - want.1).atan2(arc.points[i] - want.0);
    let span = (angle(arc.points.len() - 2) - angle(0)).abs();
    assert!(
        (span - SWEEP_RAD).abs() < 0.05,
        "arc sweeps {span:.4} rad, expected {SWEEP_RAD:.4} rad — the trim \
         parameters are not reaching the tessellator"
    );
}
