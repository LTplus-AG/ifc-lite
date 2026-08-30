//! #3187 — geometry jobs must be labelled legacy-aware.
//!
//! Split into its own file rather than grown inline: `prepass.rs` is on the
//! module-size ratchet, and the rule there is shrink or split by default. A
//! raise is possible rather than forbidden (`module_size_ratchet.rs` records
//! one reaching main and being undone, #2658); splitting is simply the better
//! move. `prepass_orphan_type_tests.rs` is the same pattern.
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

/// Why the OTHER sites in these scan loops are not pinned by a legacy-keyword
/// test: no legacy keyword can reach them. That is a property of the tables,
/// not a fact about the tests, so it is asserted here rather than assumed.
///
/// EXACTLY WHAT THIS ASSERTS, because the raw counts invite a wrong reading:
/// the bare resolver returns `Unknown` for all **26** names in
/// `LEGACY_ENTITY_NAMES`. Of those, 22 reach the `has_geometry_by_name` arm,
/// **0** reach the `IFCSITE` arm, and **0** reach the representationless-
/// spatial-container arm. The remaining 4 reach NONE of the three and are
/// never scheduled as geometry jobs at all; three of them
/// (`IFCDOORSTYLE`, `IFCWINDOWSTYLE`, `IFCBUILDINGELEMENTTYPE`) are picked up
/// by a fourth arm, `type_product_ifc_type`, which already resolves
/// legacy-aware. So this test deliberately does NOT compare the geometry count
/// to the Unknown total: 22 against 26 is correct, not a discrepancy.
///
/// The two zeroes are the load-bearing claim. They are what makes
/// `styling/prepass.rs:68`/`:94` and `gpu_meshes/prepass.rs:349`/`:416`
/// unreachable by an input where the two resolvers disagree, and therefore
/// impossible to pin with a legacy-keyword test rather than merely untested.
///
/// WHAT ACTUALLY TRIPS THIS, stated precisely because an earlier draft
/// promised coverage it does not have. `compute_is_representationless_spatial_container`
/// returns false as its first statement for any name in the legacy table, and
/// that table is lint-enforced against the match arms, so regenerating the
/// schema cannot route a legacy keyword into the container arm. What trips it
/// is deleting that early return, or adding `IFCSITE` to the legacy table.
/// Narrow, but both are edits a person could make without seeing these sites.
#[test]
fn every_legacy_keyword_reaches_the_geometry_arm_and_no_other() {
    let mut geometry = 0;
    let mut other = Vec::new();
    for name in ifc_lite_core::LEGACY_ENTITY_NAMES.iter() {
        let name: &str = name;
        if !matches!(IfcType::from_str(name), IfcType::Unknown(_)) {
            continue;
        }
        if name == "IFCSITE" || ifc_lite_core::is_representationless_spatial_container_by_name(name)
        {
            other.push(name);
        } else if ifc_lite_core::has_geometry_by_name(name) {
            geometry += 1;
        }
    }
    assert!(
        geometry > 0,
        "anti-vacuity: the geometry arm must carry legacy keywords, or this test \
         asserts nothing about the partition"
    );
    // The OTHER half of anti-vacuity, and the one a `geometry > 0` floor misses.
    // If the container predicate ever regressed to always-false, the two
    // container sites would become dead code -- a real defect -- and the
    // `other` bucket would still be empty, so this test would still pass.
    assert!(
        ifc_lite_core::is_representationless_spatial_container_by_name("IFCBUILDINGSTOREY"),
        "anti-vacuity: the container predicate must return true for something, \
         or an empty `other` bucket proves nothing about legacy keywords"
    );
    assert_eq!(
        other,
        Vec::<&str>::new(),
        "a legacy keyword now reaches the IFCSITE or spatial-container arm; those \
         sites are only untested because nothing could reach them, so they now \
         need a job-label test of their own"
    );
}
