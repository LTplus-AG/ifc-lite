//! #1910 — `combined_pre_pass` must schedule a spatial container that
//! exceptionally carries a non-null Representation.
//!
//! Split out of `prepass.rs` for the module-size ratchet, matching
//! `prepass_orphan_type_tests.rs` and `prepass_issue_3187_tests.rs`.
use super::combined_pre_pass;
use ifc_lite_core::EntityDecoder;

// #1910 (third instance, Greptile-flagged displaced-path gap):
// `buildPrePassOnce`'s single-shot `combined_pre_pass` had the same
// `has_geometry_by_name` gap as the serial + sharded scans: a container
// like `IfcBuildingStorey` with an exceptional non-null Representation
// was dropped from both `simple_jobs` and `complex_jobs`. Uses the storey
// fixture, not `IfcBuilding`: post-#1969 `has_geometry_by_name` is
// unconditionally `true` for `IFCBUILDING`, so a building job would pass
// via the by-name branch whether or not the exception fires.
const FIXTURE: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../geometry/tests/fixtures/issue_1910_storey_shell_geometry.ifc"
);

// Injected here rather than added to the fixture file: it has four
// consumers and this second storey is only meaningful to the two
// exception tests. `rfind`, not `find` -- the fixture has two `ENDSEC;`
// markers (HEADER and DATA) and this must land inside DATA.
const NULL_REPR_STOREY: &str =
    "#42=IFCBUILDINGSTOREY('7777777777777777770108',$,'Level 2',$,$,#18,$,$,.ELEMENT.,0.);\n";

fn storey_jobs(content: &[u8], global_id: &str) -> bool {
    let index = std::sync::Arc::new(ifc_lite_core::build_entity_index(content));
    let mut decoder = EntityDecoder::with_arc_index(content, index);
    let pre_pass = combined_pre_pass(content, &mut decoder);
    pre_pass
        .simple_jobs
        .iter()
        .chain(pre_pass.complex_jobs.iter())
        .any(|&(_, start, end, _)| {
            let span = &content[start..end];
            let eq = span.iter().position(|&b| b == b'=').map(|p| p + 1).unwrap_or(0);
            span[eq..].starts_with(b"IFCBUILDINGSTOREY(")
                && span.windows(global_id.len()).any(|w| w == global_id.as_bytes())
        })
}

#[test]
fn combined_pre_pass_schedules_storey_geometry_job() {
    let raw = std::fs::read_to_string(FIXTURE).expect("issue_1910 storey fixture must be present");
    assert!(
        !ifc_lite_core::has_geometry_by_name("IFCBUILDINGSTOREY"),
        "sanity: must stay blocked by name, else this test never reaches the exception"
    );
    // A second storey with a NULL Representation, so that forcing the
    // instance-level check to always report "present" fails this test
    // instead of leaving it vacuous in the other direction (#1910).
    let mut content = raw.clone();
    content.insert_str(
        content.rfind("ENDSEC;").expect("fixture must have an ENDSEC;"),
        NULL_REPR_STOREY,
    );
    let bytes = content.as_bytes();
    assert!(
        storey_jobs(bytes, "7777777777777777770103"),
        "combined_pre_pass must schedule a geometry job for the storey whose \
         Representation is non-null, via the instance-level exception (#1910)"
    );
    assert!(
        !storey_jobs(bytes, "7777777777777777770108"),
        "combined_pre_pass must NOT schedule a geometry job for a storey whose \
         Representation is null (#1910 negative case)"
    );
}
