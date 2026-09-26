// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! What the mutation-log writer refuses, and says so (#5941). Byte parity is
//! `step_log_parity.rs`; these logs end before a file exists, where the
//! TypeScript replay would write one WITHOUT the edit (its behaviour for each
//! is pinned by the fixture's `refusedCases` in `step-log.parity.test.ts`).

use ifc_lite_export::{export_step_with_log, MutationLog, StepOptions};

const SOURCE: &str = "ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION((''),'2;1');\nFILE_SCHEMA(('IFC4'));\nENDSEC;\nDATA;\n\
#1=IFCWALL('3nZ2y9nY9FExK3Wg9nLvXz',$,'Wall',$,$,$,$,$,$);\nENDSEC;\nEND-ISO-10303-21;\n";

fn refused(json: &str) -> String {
    let log = MutationLog::from_json(json).expect("log parses");
    let mut out = Vec::new();
    let err = ifc_lite_export::export_step_with_log_to_writer(SOURCE.as_bytes(), &StepOptions::default(), &log, &mut out)
        .expect_err("the log is refused");
    assert!(out.is_empty(), "nothing is written before the refusal");
    err.to_string()
}

#[test]
fn an_unrecognised_mutation_type_is_refused_not_skipped() {
    let err = refused(
        r#"{"mutations":[{"type":"SOMETHING_NEW","entityId":1},
            {"type":"UPDATE_ATTRIBUTE","entityId":1,"attributeName":"Name","newValue":"x"}]}"#,
    );
    assert!(err.contains("unrecognised"), "{err}");
}

#[test]
fn a_null_attribute_value_is_refused_not_dropped() {
    let err = refused(r#"{"mutations":[{"type":"UPDATE_ATTRIBUTE","entityId":1,"attributeName":"Name","newValue":null}]}"#);
    assert!(err.contains("null newValue"), "{err}");
}

#[test]
fn an_absent_attribute_value_is_not_a_null_one() {
    // `present` keeps absent and null apart: an absent `newValue` is the
    // replay's no-op, as `applyMutationsBatch`'s `!== undefined` guard makes it.
    let log = MutationLog::from_json(r#"{"mutations":[{"type":"UPDATE_ATTRIBUTE","entityId":1,"attributeName":"Name"}]}"#).unwrap();
    let (out, _) = export_step_with_log(SOURCE.as_bytes(), &StepOptions::default(), &log).unwrap();
    assert!(out.contains("#1=IFCWALL('3nZ2y9nY9FExK3Wg9nLvXz',$,'Wall',"), "{out}");
}

#[test]
fn a_log_does_not_combine_with_the_plain_writer_options() {
    let log = MutationLog::from_json(r#"{"mutations":[]}"#).unwrap();
    let opts = StepOptions { included: Some(vec![1]), ..StepOptions::default() };
    assert!(export_step_with_log(SOURCE.as_bytes(), &opts, &log).is_err());
}
