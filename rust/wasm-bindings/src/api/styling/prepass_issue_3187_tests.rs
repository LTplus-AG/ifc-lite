//! #3187 — geometry jobs must be labelled legacy-aware.
//!
//! Split into its own file rather than grown inline: `prepass.rs` is on the
//! module-size ratchet, and the rule there is shrink or split, never raise
//! the budget. `prepass_orphan_type_tests.rs` is the same pattern.
use super::combined_pre_pass;

use ifc_lite_core::{legacy_aware_ifc_type, EntityDecoder, IfcType};

// #3187. The scan loop resolved a job's type with a BARE
// `IfcType::from_str`, which knows only the current schema. A legacy
// keyword therefore came back `IfcType::Unknown(crc32)` — and `Unknown`
// carries a CRC32 of the name, NOT the name, so nothing downstream can
// recover what it was (#3179). The element still rendered, which is why
// this survived: the geometry is right and only the label is wrong, so
// there is no blank screen to notice.
//
// #3190 fixed the four gates that DROPPED geometry. These six job-label
// sites were left, and they are reachable: every keyword below answers
// `has_geometry_by_name` = true, so it reaches the branch at first hand.
const LEGACY_WITH_GEOMETRY: &[(&str, IfcType)] = &[
    ("IFCBEAMSTANDARDCASE", IfcType::IfcBeam),
    ("IFCDOORSTANDARDCASE", IfcType::IfcDoor),
    ("IFCPROXY", IfcType::IfcBuildingElementProxy),
];

fn job_type_for(keyword: &str) -> Option<IfcType> {
    let content = format!(
        "ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION((''),'2;1');\n\
         FILE_NAME('t.ifc','2026-01-01T00:00:00',(''),(''),'','','');\n\
         FILE_SCHEMA(('IFC4'));\nENDSEC;\nDATA;\n\
         #1={keyword}('1111111111111111111111',$,'n',$,$,$,$,$);\n\
         ENDSEC;\nEND-ISO-10303-21;\n"
    );
    let bytes = content.as_bytes();
    let index = std::sync::Arc::new(ifc_lite_core::build_entity_index(bytes));
    let mut decoder = EntityDecoder::with_arc_index(bytes, index);
    let pre_pass = combined_pre_pass(bytes, &mut decoder);
    pre_pass
        .simple_jobs
        .iter()
        .chain(pre_pass.complex_jobs.iter())
        .map(|&(_, _, _, ty)| ty)
        .next()
}

#[test]
fn legacy_keywords_are_not_scheduled_as_unknown() {
    for &(keyword, expected) in LEGACY_WITH_GEOMETRY {
        // These two do DIFFERENT jobs, and only the second is anti-vacuity.
        // The first pins WHICH branch is under test: were the keyword to move
        // to the spatial-container exception branch, that branch is also
        // legacy-aware now, so this would pass while silently testing a
        // different site. It could not go quietly vacuous -- an unscheduled
        // keyword panics at the unwrap below. The second IS the guard: if the
        // generated enum ever learns the keyword, the bare resolver returns
        // the right type and this test passes with the fix reverted.
        assert!(
            ifc_lite_core::has_geometry_by_name(keyword),
            "{keyword} must reach the has_geometry branch; if it moves, this test would \
             silently exercise the spatial-container branch instead"
        );
        assert!(
            matches!(IfcType::from_str(keyword), IfcType::Unknown(_)),
            "{keyword} must be one the BARE resolver gets wrong, else this test \
             passes with the fix reverted"
        );
        assert_eq!(legacy_aware_ifc_type(keyword), expected, "table sanity: {keyword}");

        let scheduled = job_type_for(keyword)
            .unwrap_or_else(|| panic!("{keyword} must be scheduled as a geometry job"));
        assert_eq!(
            scheduled, expected,
            "{keyword} was scheduled as {scheduled:?}; a job labelled Unknown(crc32) \
             cannot be recovered downstream because Unknown stores the hash, not the name"
        );
    }
}
