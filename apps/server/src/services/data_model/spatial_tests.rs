// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Storey-elevation extraction tests (issue #1841, ratchet-exempt sibling).
//!
//! The server used to read `get_float(8)` and fall back to `get_float(7)` for
//! `IfcBuildingStorey.Elevation`. Slot 8 is `CompositionType` (an enum) and slot
//! 7 is `LongName` (a string), so neither yields a float: every storey reported
//! no elevation and the viewer displayed 0, while the wasm/parser path read the
//! correct slot 9. These pin the slot and the ObjectPlacement fallback.

use super::*;
use ifc_lite_core::EntityDecoder;

/// Millimetre-unit model. `#10` has an explicit Elevation; `#20` has a null
/// Elevation and must fall back to its ObjectPlacement Z; `#30` has neither.
/// Every storey carries a populated LongName and CompositionType — the two
/// slots the old code mistakenly read.
const STOREYS_IFC: &str = r#"ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('issue-1841 storey elevation fixture'),'2;1');
FILE_NAME('storeys.ifc','2026-07-23T00:00:00',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0$ScRe4drECQ4DMSqUjd6d',$,'P',$,$,$,$,(#2),#3);
#2=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.0E-5,#5,$);
#3=IFCUNITASSIGNMENT((#6));
#4=IFCCARTESIANPOINT((0.,0.,0.));
#5=IFCAXIS2PLACEMENT3D(#4,$,$);
#6=IFCSIUNIT(*,.LENGTHUNIT.,.MILLI.,.METRE.);
#10=IFCBUILDINGSTOREY('Storey000000000000001',$,'Level 1',$,$,#11,$,'Ground floor',.ELEMENT.,3000.);
#11=IFCLOCALPLACEMENT($,#12);
#12=IFCAXIS2PLACEMENT3D(#13,$,$);
#13=IFCCARTESIANPOINT((0.,0.,9999.));
#20=IFCBUILDINGSTOREY('Storey000000000000002',$,'Level 2',$,$,#21,$,'First floor',.ELEMENT.,$);
#21=IFCLOCALPLACEMENT($,#22);
#22=IFCAXIS2PLACEMENT3D(#23,$,$);
#23=IFCCARTESIANPOINT((0.,0.,6500.));
#30=IFCBUILDINGSTOREY('Storey000000000000003',$,'Level 3',$,$,$,$,'Second floor',.ELEMENT.,$);
#40=IFCBUILDING('Building00000000000001',$,'B',$,$,$,$,'Main',.ELEMENT.,$,$,$);
ENDSEC;
END-ISO-10303-21;
"#;

/// Millimetres -> metres, matching how the caller passes `length_unit_scale`.
const MM_TO_M: f64 = 0.001;

#[test]
fn reads_elevation_from_the_correct_attribute_slot() {
    let mut decoder = EntityDecoder::new(STOREYS_IFC.as_bytes());
    let elevation = extract_elevation_if_storey("IFCBUILDINGSTOREY", 10, &mut decoder, MM_TO_M);
    // 3000mm -> 3m. The old code read CompositionType / LongName and got None.
    assert_eq!(elevation, Some(3.0));
}

/// A null Elevation must fall back to the storey's own ObjectPlacement Z, the
/// same rule `SpatialHierarchyBuilder.extractPlacementElevation` applies (#1289).
#[test]
fn falls_back_to_object_placement_z_when_elevation_is_null() {
    let mut decoder = EntityDecoder::new(STOREYS_IFC.as_bytes());
    let elevation = extract_elevation_if_storey("IFCBUILDINGSTOREY", 20, &mut decoder, MM_TO_M);
    assert_eq!(elevation, Some(6.5));
}

/// The explicit Elevation wins over the placement Z — `#10` carries both, and
/// they deliberately disagree.
#[test]
fn explicit_elevation_takes_precedence_over_the_placement_fallback() {
    let mut decoder = EntityDecoder::new(STOREYS_IFC.as_bytes());
    let elevation = extract_elevation_if_storey("IFCBUILDINGSTOREY", 10, &mut decoder, MM_TO_M);
    assert_eq!(elevation, Some(3.0), "placement Z 9999mm must not win");
}

/// No Elevation and no ObjectPlacement: report nothing rather than inventing a
/// value from an adjacent attribute.
#[test]
fn returns_none_when_neither_elevation_nor_placement_resolves() {
    let mut decoder = EntityDecoder::new(STOREYS_IFC.as_bytes());
    let elevation = extract_elevation_if_storey("IFCBUILDINGSTOREY", 30, &mut decoder, MM_TO_M);
    assert_eq!(elevation, None);
}

/// LongName and CompositionType are populated on every storey in the fixture;
/// neither may leak into the elevation. This is the exact regression: the old
/// code read slot 8 then slot 7.
#[test]
fn never_reads_long_name_or_composition_type_as_elevation() {
    let mut decoder = EntityDecoder::new(STOREYS_IFC.as_bytes());
    let entity = decoder.decode_by_id(30).expect("storey decodes");
    assert!(
        entity.get_float(7).is_none(),
        "LongName must not parse as a float"
    );
    assert!(
        entity.get_float(8).is_none(),
        "CompositionType must not parse as a float"
    );
}

#[test]
fn ignores_entities_that_are_not_storeys() {
    let mut decoder = EntityDecoder::new(STOREYS_IFC.as_bytes());
    assert_eq!(
        extract_elevation_if_storey("IFCBUILDING", 40, &mut decoder, MM_TO_M),
        None
    );
}

/// The type-name check is case-insensitive; callers pass whatever the index
/// recorded.
#[test]
fn matches_the_storey_type_name_case_insensitively() {
    let mut decoder = EntityDecoder::new(STOREYS_IFC.as_bytes());
    assert_eq!(
        extract_elevation_if_storey("IfcBuildingStorey", 10, &mut decoder, MM_TO_M),
        Some(3.0)
    );
}

/// Metre-unit models must not be rescaled.
#[test]
fn applies_the_length_unit_scale() {
    let mut decoder = EntityDecoder::new(STOREYS_IFC.as_bytes());
    assert_eq!(
        extract_elevation_if_storey("IFCBUILDINGSTOREY", 10, &mut decoder, 1.0),
        Some(3000.0)
    );
}
