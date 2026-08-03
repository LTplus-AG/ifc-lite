// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! CI-visible regression test for the #1910 instance-level container-geometry
//! exception, as it is applied by `classify_type_name_with_content`
//! (`rust/processing/src/shard_classes.rs`) via the exported
//! `ifc_lite_processing::scan_shard_classified`.
//!
//! This is NOT a replacement for the existing wasm-bindings pair --
//! `rust/wasm-bindings/src/api/gpu_meshes/prepass_discovery.rs`'s
//! `sharded_column_discovery_schedules_storey_geometry_job` and
//! `rust/wasm-bindings/src/api/styling/prepass.rs`'s
//! `combined_pre_pass_schedules_storey_geometry_job` -- those cover the
//! actual displaced paths this PR fixed (`discover_from_columns` and
//! `buildPrePassOnce`'s combined pre-pass) and must stay. DO NOT delete
//! either of them as a "duplicate" of this test.
//!
//! The reason this file exists at all: `ifc-lite-wasm` is excluded from the
//! required CI lane (`cargo test --workspace --exclude ifc-lite-wasm`,
//! `.github/workflows/test.yml:472`) and the only wasm-pack lane
//! (`determinism.yml`, `wide-arithmetic.yml`) runs solely
//! `--test mesh_determinism`. Neither of the two tests above is ever
//! compiled or executed by any CI job -- they only ever ran locally. This
//! test exercises `classify_type_name_with_content` through the SAME
//! production entry point (`scan_shard_classified`) the sharded browser path
//! calls, but from `ifc-lite-processing`, which IS covered by the required
//! lane, so a regression here fails the build instead of only ever being
//! caught by whoever happens to run the wasm crate's tests locally (as
//! happened once already when #1969 silently drained both wasm-side tests
//! at merge time).
//!
//! Property pinned (same as the wasm pair): a spatial container blocked by
//! name (`IfcBuildingStorey`) whose `Representation` attribute is
//! exceptionally non-null must still carry the geometry-job class flag, and
//! one with a null `Representation` must NOT.

use ifc_lite_processing::{scan_shard_classified, PREPASS_CLASS_FLAG_GEOMETRY_JOB};

const FIXTURE: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../geometry/tests/fixtures/issue_1910_storey_shell_geometry.ifc"
);

fn read_fixture() -> String {
    std::fs::read_to_string(FIXTURE).expect("issue_1910 storey fixture must be present")
}

/// Parse the raw STEP keyword at a record start (`#id=KEYWORD(...`). Mirrors
/// `prepass_discovery.rs::keyword_at` -- duplicated here rather than shared
/// because that helper is private to the excluded wasm crate.
fn keyword_at(content: &[u8], start: usize, end: usize) -> &str {
    let span = &content[start..end.min(content.len())];
    let eq = span.iter().position(|&b| b == b'=').map(|p| p + 1).unwrap_or(0);
    let kw_end = span[eq..]
        .iter()
        .position(|&b| b == b'(')
        .map(|p| eq + p)
        .unwrap_or(span.len());
    std::str::from_utf8(&span[eq..kw_end]).unwrap_or("").trim()
}

#[test]
fn shard_classification_flags_geometry_job_only_for_the_instance_with_a_representation() {
    let mut content = read_fixture();

    // Not editing the shared fixture: it has four other consumers and this
    // second storey is only relevant to this test. Injected right before the
    // DATA section's `ENDSEC;` -- `rfind`, not `find`, since the fixture has
    // two `ENDSEC;` markers (HEADER and DATA).
    let injected =
        "#42=IFCBUILDINGSTOREY('7777777777777777770108',$,'Level 2',$,$,#18,$,$,.ELEMENT.,0.);\n";
    let endsec_pos = content.rfind("ENDSEC;").expect("fixture must have an ENDSEC;");
    content.insert_str(endsec_pos, injected);
    let bytes = content.as_bytes();

    assert!(
        !ifc_lite_core::has_geometry_by_name("IFCBUILDINGSTOREY"),
        "sanity: IFCBUILDINGSTOREY must stay excluded from has_geometry_by_name -- \
         otherwise this test would pass via the ordinary by-name classification and \
         stop proving the instance-level exception fires"
    );

    let (records, classes, handoff) = scan_shard_classified(bytes, 0, bytes.len());
    assert!(handoff.is_none(), "single shard must cover the whole fixture");

    // Locate the two storeys separately, by GlobalId, not by keyword alone --
    // both entities are IFCBUILDINGSTOREY.
    let find_storey_idx = |global_id: &str| {
        records
            .iter()
            .position(|&(_, s, e)| {
                keyword_at(bytes, s, e) == "IFCBUILDINGSTOREY"
                    && bytes[s..e].windows(global_id.len()).any(|w| w == global_id.as_bytes())
            })
            .unwrap_or_else(|| panic!("fixture must contain a storey with GlobalId {global_id}"))
    };
    let with_repr_idx = find_storey_idx("7777777777777777770103");
    let without_repr_idx = find_storey_idx("7777777777777777770108");

    assert!(
        classes[with_repr_idx] & PREPASS_CLASS_FLAG_GEOMETRY_JOB != 0,
        "IFCBUILDINGSTOREY's shard class byte must carry the geometry-job flag \
         when its Representation is non-null (#1910)"
    );
    assert!(
        classes[without_repr_idx] & PREPASS_CLASS_FLAG_GEOMETRY_JOB == 0,
        "an IFCBUILDINGSTOREY with a null Representation must NOT carry the \
         geometry-job flag (#1910 negative case)"
    );
}
