// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Regression test for the `items.rs` half of issue #2256, follow-up to
//! #2352 (which fixed the top-level `ObjectPlacement` chain in
//! `transform.rs` but deliberately left `IfcMappedItem`'s own
//! `MappingOrigin` / `MappingTarget` resolution alone — that file was at
//! its module-size ratchet ceiling at the time).
//!
//! `extract_symbolic_item`'s `IfcMappedItem` branch composes two 2D
//! transforms before recursing into the mapped representation:
//!
//!   * `MappingOrigin` (`IfcRepresentationMap` attribute 0) — MANDATORY.
//!   * `MappingTarget` (`IfcMappedItem` attribute 1) — MANDATORY.
//!
//! Both were falling back to `Transform2D::identity()` (`tz: 0.0`) on a
//! dangling reference, which is bit-for-bit indistinguishable from a real
//! ground-floor elevation — exactly the #2256 defect, just one level
//! deeper in the recursion than the case #2352 already fixed.
//!
//! Three annotations share the same footprint square, each via a
//! different `IfcMappedItem`:
//!
//!   * `#200` — everything resolves cleanly to Z = 0. This is a genuine
//!     ground-floor elevation and `world_y` must stay exactly `0.0`
//!     (bounding control: proves the fix does not just return NaN
//!     unconditionally).
//!   * `#300` — `MappingOrigin` is a dangling reference (`#999999` does
//!     not exist). `world_y` must be non-finite.
//!   * `#400` — `MappingTarget` is a dangling reference (`#999998` does
//!     not exist). `world_y` must be non-finite.

use ifc_lite_processing::extract_symbolic_data;

const FIXTURE: &str = r#"ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('issue-2256 mapped-item fixture'),'2;1');
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

/* ---- #200: mapped item, origin + target both resolve, genuine Z=0 ---- */
#210=IFCCARTESIANPOINT((0.,0.));
#211=IFCCARTESIANPOINT((1.,0.));
#212=IFCCARTESIANPOINT((1.,1.));
#213=IFCCARTESIANPOINT((0.,1.));
#214=IFCCARTESIANPOINT((0.,0.));
#220=IFCPOLYLINE((#210,#211,#212,#213,#214));
#230=IFCSHAPEREPRESENTATION(#2,'Body','Curve2D',(#220));
#240=IFCCARTESIANPOINT((0.,0.));
#241=IFCAXIS2PLACEMENT2D(#240,$);
#250=IFCREPRESENTATIONMAP(#241,#230);
#260=IFCCARTESIANPOINT((0.,0.));
#261=IFCCARTESIANTRANSFORMATIONOPERATOR2D($,$,#260,$);
#270=IFCMAPPEDITEM(#250,#261);
#280=IFCSHAPEREPRESENTATION(#2,'Annotation','MappedRepresentation',(#270));
#281=IFCPRODUCTDEFINITIONSHAPE($,$,(#280));
#200=IFCANNOTATION('2xScRe4drECQ4DMSqUjd6d',$,'GoodMappedZero',$,$,#40,#281);

/* ---- #300: MappingOrigin (RepresentationMap attr 0) is dangling ---- */
#310=IFCCARTESIANPOINT((5.,0.));
#311=IFCCARTESIANPOINT((6.,0.));
#312=IFCCARTESIANPOINT((6.,1.));
#313=IFCCARTESIANPOINT((5.,1.));
#314=IFCCARTESIANPOINT((5.,0.));
#320=IFCPOLYLINE((#310,#311,#312,#313,#314));
#330=IFCSHAPEREPRESENTATION(#2,'Body','Curve2D',(#320));
#350=IFCREPRESENTATIONMAP(#999999,#330);
#360=IFCCARTESIANPOINT((0.,0.));
#361=IFCCARTESIANTRANSFORMATIONOPERATOR2D($,$,#360,$);
#370=IFCMAPPEDITEM(#350,#361);
#380=IFCSHAPEREPRESENTATION(#2,'Annotation','MappedRepresentation',(#370));
#381=IFCPRODUCTDEFINITIONSHAPE($,$,(#380));
#300=IFCANNOTATION('3xScRe4drECQ4DMSqUjd6d',$,'DanglingMappingOrigin',$,$,#40,#381);

/* ---- #400: MappingTarget (MappedItem attr 1) is dangling ---- */
#410=IFCCARTESIANPOINT((10.,0.));
#411=IFCCARTESIANPOINT((11.,0.));
#412=IFCCARTESIANPOINT((11.,1.));
#413=IFCCARTESIANPOINT((10.,1.));
#414=IFCCARTESIANPOINT((10.,0.));
#420=IFCPOLYLINE((#410,#411,#412,#413,#414));
#430=IFCSHAPEREPRESENTATION(#2,'Body','Curve2D',(#420));
#440=IFCCARTESIANPOINT((0.,0.));
#441=IFCAXIS2PLACEMENT2D(#440,$);
#450=IFCREPRESENTATIONMAP(#441,#430);
#470=IFCMAPPEDITEM(#450,#999998);
#480=IFCSHAPEREPRESENTATION(#2,'Annotation','MappedRepresentation',(#470));
#481=IFCPRODUCTDEFINITIONSHAPE($,$,(#480));
#400=IFCANNOTATION('4xScRe4drECQ4DMSqUjd6d',$,'DanglingMappingTarget',$,$,#40,#481);
ENDSEC;
END-ISO-10303-21;
"#;

#[test]
fn genuine_zero_elevation_mapped_item_stays_finite_zero() {
    let data = extract_symbolic_data(FIXTURE);
    let pl = data
        .polylines
        .iter()
        .find(|p| p.express_id == 200)
        .expect("annotation #200 should produce a polyline via its IfcMappedItem");
    assert_eq!(
        pl.world_y, 0.0,
        "MappingOrigin and MappingTarget both resolve cleanly to Z=0 — a \
         genuine ground-floor elevation reached through an IfcMappedItem \
         must stay exactly 0.0, not become non-finite"
    );
    assert!(pl.world_y.is_finite());
}

#[test]
fn dangling_mapping_origin_is_not_finite() {
    let data = extract_symbolic_data(FIXTURE);
    let pl = data
        .polylines
        .iter()
        .find(|p| p.express_id == 300)
        .expect("annotation #300 should still produce a polyline (points are independent of MappingOrigin resolution)");
    assert!(
        !pl.world_y.is_finite(),
        "IfcRepresentationMap #350's MappingOrigin (#999999) does not exist \
         — ifc-lite cannot resolve the mapped item's local origin. world_y \
         must be non-finite (NaN), not silently 0.0, or it becomes \
         indistinguishable from a genuine ground-floor mapped item \
         (issue #2256). Got: {}",
        pl.world_y
    );
}

#[test]
fn dangling_mapping_target_is_not_finite() {
    let data = extract_symbolic_data(FIXTURE);
    let pl = data
        .polylines
        .iter()
        .find(|p| p.express_id == 400)
        .expect("annotation #400 should still produce a polyline (points are independent of MappingTarget resolution)");
    assert!(
        !pl.world_y.is_finite(),
        "IfcMappedItem #470's MappingTarget (#999998) does not exist — \
         ifc-lite cannot resolve the mapped item's target transform. \
         world_y must be non-finite (NaN), not silently 0.0, or it becomes \
         indistinguishable from a genuine ground-floor mapped item \
         (issue #2256). Got: {}",
        pl.world_y
    );
}
