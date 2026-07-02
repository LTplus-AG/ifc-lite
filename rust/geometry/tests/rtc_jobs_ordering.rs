// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Guards `GeometryRouter::detect_rtc_offset_from_jobs` (issue #1526 follow-up):
//! the sample budget must count USABLE samples, not raw jobs. Origin-placed
//! curve/axis-only products (e.g. IfcAlignmentSegment) abstain from RTC
//! sampling; if `take(MAX_SAMPLES)` ran before the abstention filter, a file
//! that lists more than 50 such products ahead of its real large-coordinate
//! solid would sample zero positions and fail to detect the re-basing offset.

use ifc_lite_core::{build_entity_index, has_geometry_by_name, EntityDecoder, EntityScanner, IfcType};
use ifc_lite_geometry::GeometryRouter;

/// One origin-placed proxy whose only representation is an axis polyline — no
/// meshable body, so RTC sampling abstains. Ids are offset by `base`.
fn curve_only_proxy(base: u32, guid: &str) -> String {
    format!(
        "#{p0}=IFCCARTESIANPOINT((0.,0.,0.));\n\
         #{p1}=IFCCARTESIANPOINT((5.,0.,0.));\n\
         #{poly}=IFCPOLYLINE((#{p0},#{p1}));\n\
         #{rep}=IFCSHAPEREPRESENTATION(#6,'Axis','Curve3D',(#{poly}));\n\
         #{pds}=IFCPRODUCTDEFINITIONSHAPE($,$,(#{rep}));\n\
         #{ax}=IFCAXIS2PLACEMENT3D(#{p0},$,$);\n\
         #{plc}=IFCLOCALPLACEMENT($,#{ax});\n\
         #{proxy}=IFCBUILDINGELEMENTPROXY('{guid}',$,'seg',$,$,#{plc},#{pds},$,$);\n",
        p0 = base,
        p1 = base + 1,
        poly = base + 2,
        rep = base + 3,
        pds = base + 4,
        ax = base + 5,
        plc = base + 6,
        proxy = base + 7,
    )
}

/// Deterministic pseudo-GUID (22 chars) that varies by index — process_geometry
/// is not involved here, but distinct GlobalIds keep the model well-formed.
fn guid(i: u32) -> String {
    let base = b"0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ_$";
    let mut s = String::from("1zzzzzzzzzzzzzzzzzzzz");
    s.push(base[(i as usize) % base.len()] as char);
    s.push(base[((i as usize) / base.len()) % base.len()] as char);
    s
}

const SOLID_X: f64 = 200_000.0;
const SOLID_Y: f64 = 6_000_000.0;
const SOLID_Z: f64 = 100.0;

/// 55 origin-placed curve-only proxies (> MAX_SAMPLES = 50) FOLLOWED BY a single
/// large-coordinate tessellated solid.
fn model() -> String {
    let mut s = String::from(
        "ISO-10303-21;\n\
         HEADER;\n\
         FILE_DESCRIPTION((''),'2;1');\n\
         FILE_NAME('','2026-01-01T00:00:00',(''),(''),'t','t','');\n\
         FILE_SCHEMA(('IFC4X3_ADD2'));\n\
         ENDSEC;\n\
         DATA;\n\
         #1=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);\n\
         #2=IFCUNITASSIGNMENT((#1));\n\
         #3=IFCCARTESIANPOINT((0.,0.,0.));\n\
         #4=IFCAXIS2PLACEMENT3D(#3,$,$);\n\
         #5=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-05,#4,$);\n\
         #6=IFCGEOMETRICREPRESENTATIONSUBCONTEXT('Body','Model',*,*,*,*,#5,$,.MODEL_VIEW.,$);\n\
         #7=IFCPROJECT('01tEAnIV5BixApwp1YzpwS',$,'t',$,$,$,$,(#5),#2);\n",
    );

    for i in 0..55u32 {
        s.push_str(&curve_only_proxy(1000 + i * 10, &guid(i)));
    }

    // The lone large-coordinate solid, emitted AFTER all curve-only products.
    s.push_str(&format!(
        "#900=IFCCARTESIANPOINTLIST3D((({x},{y},{z}),({x1},{y},{z}),({x},{y1},{z}),({x},{y},{z1})));\n\
         #901=IFCTRIANGULATEDFACESET(#900,$,$,((1,2,3),(1,2,4),(1,3,4),(2,3,4)),$);\n\
         #902=IFCSHAPEREPRESENTATION(#6,'Body','Tessellation',(#901));\n\
         #903=IFCPRODUCTDEFINITIONSHAPE($,$,(#902));\n\
         #904=IFCAXIS2PLACEMENT3D(#3,$,$);\n\
         #905=IFCLOCALPLACEMENT($,#904);\n\
         #906=IFCBUILDINGELEMENTPROXY('11tEAnIV5BixApwp1YzpwS',$,'solid',$,$,#905,#903,$,$);\n",
        x = SOLID_X,
        y = SOLID_Y,
        z = SOLID_Z,
        x1 = SOLID_X + 1.0,
        y1 = SOLID_Y + 1.0,
        z1 = SOLID_Z + 1.0,
    ));

    s.push_str("ENDSEC;\nEND-ISO-10303-21;\n");
    s
}

#[test]
fn from_jobs_scans_past_abstaining_curve_only_entities() {
    let content = model();
    let entity_index = build_entity_index(&content);
    let mut decoder = EntityDecoder::with_index(&content, entity_index);
    let router = GeometryRouter::with_units(&content, &mut decoder);

    // Collect geometry jobs in file order (curve proxies first, solid last).
    // detect_rtc_offset_from_jobs ignores the IfcType slot, so a placeholder is
    // fine; only (id, start, end) drive decoding.
    let mut jobs: Vec<(u32, usize, usize, IfcType)> = Vec::new();
    let mut scanner = EntityScanner::new(&content);
    while let Some((id, type_name, start, end)) = scanner.next_entity() {
        if has_geometry_by_name(type_name) {
            jobs.push((id, start, end, IfcType::IfcBuildingElementProxy));
        }
    }
    assert!(jobs.len() > 50, "need >50 jobs to exercise the budget, got {}", jobs.len());
    // The solid is the LAST job, past the 50-sample window.
    assert!(jobs.len() >= 56);

    let offset = router
        .detect_rtc_offset_from_jobs(&jobs, &mut decoder)
        .expect("solid past the first 50 curve-only jobs must still yield a sample");

    assert!(
        (offset.0 - SOLID_X).abs() < 10.0 && (offset.1 - SOLID_Y).abs() < 10.0,
        "RTC must anchor on the trailing solid, got {:?}",
        offset
    );
}
