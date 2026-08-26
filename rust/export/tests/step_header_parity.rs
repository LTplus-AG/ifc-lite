// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Pins the Rust STEP writer's `HEADER` section to the shared cross-language
//! vectors in `tests/fixtures/step_header_vectors.json`. The TypeScript writer
//! (`buildStepHeader` in `packages/export/src/step-header.ts`, held to the same
//! file by `packages/export/src/step-header.parity.test.ts`) reads the same
//! vectors, so the two cannot drift.
//!
//! The expectations are written from ISO 10303-21 and from each case's own
//! source file, not from either implementation's output — see the fixture's
//! `about` block for why anchoring on the sibling would be worthless.
//!
//! This exists because the two halves HAD drifted: this one wrote a header
//! built entirely from defaults, so `ifc-lite export --format step` replaced a
//! file's `ViewDefinition [CoordinationView_V2.0]` claim with
//! `ViewDefinition [CoordinationView]`, blanked its author, organization,
//! authoring system and authorization, and left `FILE_NAME`'s `time_stamp`
//! empty where Part 21 asks for a creation date-time.

use ifc_lite_export::{export_step, StepOptions};

/// The header section of an exported file: every line through the first
/// `ENDSEC;`. The TypeScript twin's `buildStepHeader` returns exactly this much
/// (the `DATA;` line is the assembler's), so this is the comparable span.
fn header_lines(exported: &str) -> Vec<String> {
    let mut out = Vec::new();
    for line in exported.lines() {
        out.push(line.to_string());
        if line.trim_end() == "ENDSEC;" {
            break;
        }
    }
    out
}

fn opt_string(v: &serde_json::Value, key: &str) -> Option<String> {
    v.get(key).and_then(|v| v.as_str()).map(str::to_string)
}

#[test]
fn rust_step_header_matches_shared_vectors() {
    let raw = include_str!("fixtures/step_header_vectors.json");
    let doc: serde_json::Value = serde_json::from_str(raw).expect("fixture is valid JSON");
    let cases = doc["cases"].as_array().expect("cases is an array");

    // Anti-vacuity. A fixture that shrank to nothing, or to nothing but
    // all-default headers, would let this test pass over the exact regression
    // it exists to catch, so the fixture's own reach is asserted first.
    assert!(cases.len() >= 3, "fixture must carry several cases, got {}", cases.len());
    let preserves_authored_fields = cases.iter().any(|c| {
        let want = c["expectedHeader"].as_array().expect("expectedHeader is an array");
        let file_name = want
            .iter()
            .filter_map(|l| l.as_str())
            .find(|l| l.starts_with("FILE_NAME("))
            .unwrap_or("");
        // An authored author list, and an originating_system that is NOT the
        // 'ifc-lite' default — i.e. a case where a value can only come from the
        // source file.
        !file_name.contains(",(''),") && !file_name.contains(",'ifc-lite','ifc-lite',")
    });
    assert!(
        preserves_authored_fields,
        "no case exercises carrying an authored FILE_NAME field forward; the fixture cannot \
         detect a writer that blanks the header"
    );
    let asserts_non_default_mvd = cases.iter().any(|c| {
        c["expectedHeader"].as_array().unwrap().iter().filter_map(|l| l.as_str()).any(|l| {
            l.starts_with("FILE_DESCRIPTION(")
                && !l.contains("Exported from ifc-lite")
                && !l.contains("ViewDefinition [CoordinationView]'")
        })
    });
    assert!(
        asserts_non_default_mvd,
        "no case pins a FILE_DESCRIPTION item the writer could only have read from the source"
    );

    for case in cases {
        let name = case["name"].as_str().unwrap_or("<unnamed>");
        let ifc = case["ifc"].as_str().expect("ifc is a string");
        let schema = case["schema"].as_str().expect("schema is a string");
        let options = &case["options"];
        let want: Vec<String> = case["expectedHeader"]
            .as_array()
            .expect("expectedHeader is an array")
            .iter()
            .map(|l| l.as_str().expect("header line is a string").to_string())
            .collect();

        let opts = StepOptions {
            // Stated rather than detected so the case controls the label; every
            // case names its source's own schema, so no conversion is applied.
            schema: Some(schema.to_string()),
            description: opt_string(options, "description"),
            author: opt_string(options, "author"),
            organization: opt_string(options, "organization"),
            application: opt_string(options, "application"),
            filename: opt_string(options, "filename"),
            time_stamp: opt_string(options, "timeStamp"),
            ..StepOptions::default()
        };

        let got = header_lines(&export_step(ifc.as_bytes(), &opts));
        assert_eq!(got, want, "case `{name}`");
    }
}
