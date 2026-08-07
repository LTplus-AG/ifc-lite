// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Regression test for issue #2256 — `world_y == 0.0` must mean "genuinely
//! at world Y = 0", never "elevation could not be resolved". Two
//! `IfcAnnotation`s share the same footprint square:
//!
//!   * `#62` has a real `IfcLocalPlacement` chain that resolves cleanly to
//!     the origin (Z = 0.0). This IS a legitimate ground-floor elevation
//!     and `world_y` must be exactly `0.0`.
//!   * `#72` has an `ObjectPlacement` (attribute 5) that references a
//!     non-existent entity (`#999`) — a dangling reference the decoder
//!     cannot resolve. `world_y` must be `NaN`, not `0.0`; collapsing it to
//!     `0.0` is indistinguishable from `#62`'s genuine ground floor and is
//!     exactly the defect #2256 reports.

use ifc_lite_processing::extract_symbolic_data;

const FIXTURE: &str = r#"ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('issue-2256 fixture'),'2;1');
FILE_NAME('test.ifc','2026-08-07T00:00:00',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0$ScRe4drECQ4DMSqUjd6d',$,'P',$,$,$,$,(#2),#3);
#2=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.0E-5,#5,$);
#3=IFCUNITASSIGNMENT((#6));
#4=IFCCARTESIANPOINT((0.,0.,0.));
#5=IFCAXIS2PLACEMENT3D(#4,$,$);
#6=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#40=IFCLOCALPLACEMENT($,#5);
#50=IFCCARTESIANPOINT((0.,0.));
#51=IFCCARTESIANPOINT((1.,0.));
#52=IFCCARTESIANPOINT((1.,1.));
#53=IFCCARTESIANPOINT((0.,1.));
#54=IFCCARTESIANPOINT((0.,0.));
#55=IFCPOLYLINE((#50,#51,#52,#53,#54));
#60=IFCSHAPEREPRESENTATION(#2,'Annotation','Annotation2D',(#55));
#61=IFCPRODUCTDEFINITIONSHAPE($,$,(#60));
#62=IFCANNOTATION('2xScRe4drECQ4DMSqUjd6d',$,'GroundFloorNote',$,$,#40,#61);
#70=IFCCARTESIANPOINT((5.,0.));
#71=IFCCARTESIANPOINT((6.,0.));
#73=IFCCARTESIANPOINT((6.,1.));
#74=IFCCARTESIANPOINT((5.,1.));
#76=IFCCARTESIANPOINT((5.,0.));
#77=IFCPOLYLINE((#70,#71,#73,#74,#76));
#80=IFCSHAPEREPRESENTATION(#2,'Annotation','Annotation2D',(#77));
#81=IFCPRODUCTDEFINITIONSHAPE($,$,(#80));
#72=IFCANNOTATION('3xScRe4drECQ4DMSqUjd6d',$,'UnresolvableNote',$,$,#999,#81);
ENDSEC;
END-ISO-10303-21;
"#;

#[test]
fn genuine_zero_elevation_stays_finite_zero() {
    let data = extract_symbolic_data(FIXTURE);
    let pl = data
        .polylines
        .iter()
        .find(|p| p.express_id == 62)
        .expect("annotation #62 should produce a polyline");
    assert_eq!(
        pl.world_y, 0.0,
        "a real placement chain resolving to Z=0 is a genuine ground-floor \
         elevation and must stay exactly 0.0, not become non-finite"
    );
    assert!(pl.world_y.is_finite());
}

#[test]
fn dangling_placement_ref_is_not_finite() {
    let data = extract_symbolic_data(FIXTURE);
    let pl = data
        .polylines
        .iter()
        .find(|p| p.express_id == 72)
        .expect("annotation #72 should still produce a polyline (points are independent of placement resolution)");
    assert!(
        !pl.world_y.is_finite(),
        "ObjectPlacement #999 does not exist — ifc-lite cannot resolve an \
         elevation for this annotation. world_y must be non-finite (NaN), \
         not silently 0.0, or it becomes indistinguishable from a genuine \
         ground-floor annotation (issue #2256). Got: {}",
        pl.world_y
    );
}
