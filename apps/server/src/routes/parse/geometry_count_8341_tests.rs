// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! #8341 C4-13c: `POST /api/v1/parse/metadata`'s `geometry_count` is the
//! native pass's scheduled job count, not a per-record name check.

use super::json_tests::metadata_json;
use serde_json::Value;

/// One record per case the two definitions can disagree on.
///
/// | record | case | name check (before) | scheduled jobs (after) |
/// |---|---|---|---|
/// | #307 `IFCWALL` | ordinary product | 1 | 1 |
/// | #308 `IFCBUILDINGSTOREY`, Representation `$` | representationless container | 0 | 0 |
/// | #309 `IFCBUILDINGSTOREY`, Representation `#306` | #1910 exception | 0 | 1 |
/// | #310 `IFCBUILDING`, Representation `$` | class-wide container | 1 | 1 |
/// | #311 `IFCOPENINGELEMENT` | opening, default filter | 1 | 1 |
/// | #312 `IFCDOOR`, Representation `$` | occurrence of #321 | 1 | 1 |
/// | #320 `IFCWALLTYPE`, maps #330, #331 | orphan type, #957 | 0 | 2 |
/// | #321 `IFCDOORTYPE`, map #332 | instanced type, suppressed | 0 | 0 |
/// | #322 `IFCSLABTYPE`, map #333 | map an `IfcMappedItem` draws | 0 | 0 |
const FIXTURE: &str = r#"ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('8341 geometry count fixture'),'2;1');
FILE_NAME('count.ifc','2026-10-30T00:00:00',(''),(''),'','','');
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
#300=IFCCARTESIANPOINT((0.,0.));
#301=IFCAXIS2PLACEMENT2D(#300,$);
#302=IFCRECTANGLEPROFILEDEF(.AREA.,$,#301,1.0,0.2);
#303=IFCDIRECTION((0.,0.,1.));
#304=IFCEXTRUDEDAREASOLID(#302,#5,#303,3.0);
#305=IFCSHAPEREPRESENTATION(#2,'Body','SweptSolid',(#304));
#306=IFCPRODUCTDEFINITIONSHAPE($,$,(#305));
#307=IFCWALL('Wall00000000000000001',$,'W1',$,$,#40,#306,$,$);
#308=IFCBUILDINGSTOREY('Storey000000000000001',$,'S1',$,$,#40,$,$,.ELEMENT.,0.);
#309=IFCBUILDINGSTOREY('Storey000000000000002',$,'S2',$,$,#40,#306,$,.ELEMENT.,3.);
#310=IFCBUILDING('Building0000000000001',$,'B',$,$,#40,$,$,.ELEMENT.,$,$,$);
#311=IFCOPENINGELEMENT('Opening0000000000001',$,'O',$,$,#40,#306,$,.OPENING.);
#312=IFCDOOR('Door00000000000000001',$,'D',$,$,#40,$,$,1.,1.,$,$,$);
#320=IFCWALLTYPE('WallType000000000001',$,'WT',$,$,$,(#330,#331),$,$,.STANDARD.);
#321=IFCDOORTYPE('DoorType000000000001',$,'DT',$,$,$,(#332),$,$,.DOOR.,.NOTDEFINED.,$,$);
#322=IFCSLABTYPE('SlabType000000000001',$,'ST',$,$,$,(#333),$,$,.FLOOR.);
#323=IFCRELDEFINESBYTYPE('RelType0000000000001',$,$,$,(#312),#321);
#330=IFCREPRESENTATIONMAP(#5,#305);
#331=IFCREPRESENTATIONMAP(#5,#305);
#332=IFCREPRESENTATIONMAP(#5,#305);
#333=IFCREPRESENTATIONMAP(#5,#305);
#340=IFCCARTESIANTRANSFORMATIONOPERATOR3D($,$,#4,$,$);
#341=IFCMAPPEDITEM(#333,#340);
ENDSEC;
END-ISO-10303-21;
"#;

/// Before #8341, `geometry_count` counted records whose name passes
/// `has_geometry_by_name`: #307, #310, #311 and #312.
const NAME_CHECK_COUNT: u64 = 4;
/// After: those four, the #1910 storey #309, and #320's two orphan maps.
const SCHEDULED_JOB_COUNT: u64 = 7;

fn geometry_count(json: &Value) -> u64 {
    json["geometry_count"].as_u64().expect("geometry_count must be a number")
}

#[tokio::test]
async fn metadata_geometry_count_is_the_scheduled_job_count_8341() {
    let json = metadata_json("geometry-count-8341", FIXTURE).await;
    assert_eq!(geometry_count(&json), SCHEDULED_JOB_COUNT);
    assert_eq!(json["entity_count"].as_u64(), Some(31));
}

/// The value that shipped before #8341, recomputed from the predicate it used,
/// so the pinned before/after pair stays a statement about this fixture.
#[test]
fn the_name_check_differs_on_this_fixture_8341() {
    let mut scanner = ifc_lite_core::EntityScanner::new(FIXTURE.as_bytes());
    let mut count = 0;
    while let Some((_, name, _, _)) = scanner.next_entity() {
        count += u64::from(ifc_lite_core::has_geometry_by_name(name));
    }
    assert_eq!(count, NAME_CHECK_COUNT);
}

/// The route and the processor share one definition: the metadata count equals
/// `geometry_entity_count` from a full default pass over the same bytes.
#[tokio::test]
async fn metadata_geometry_count_matches_the_native_pass_8341() {
    let native = ifc_lite_processing::process_geometry(FIXTURE.as_bytes());
    let json = metadata_json("geometry-count-native-8341", FIXTURE).await;
    assert_eq!(geometry_count(&json), native.metadata.geometry_entity_count as u64);
}
