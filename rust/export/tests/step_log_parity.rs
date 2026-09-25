// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Rust half of the mutation-log STEP parity pin (#5941). The TypeScript half
//! is `packages/export/src/step-log.parity.test.ts`; both read
//! `fixtures/step_log_parity_vectors.json`, whose `expected` files the
//! TypeScript `StepExporter` wrote. The contract is byte identity, generated
//! GlobalIds aside (see the fixture's `about`).

use std::collections::BTreeMap;

use ifc_lite_export::{export_step_with_log, export_step_with_log_to_writer, MutationLog, StepOptions};
use serde::Deserialize;

#[derive(Deserialize)]
struct Case {
    name: String,
    #[allow(dead_code)] // documentation for the reader of the fixture
    why: String,
    source: String,
    #[serde(default)]
    schema: Option<String>,
    log: serde_json::Value,
    expected: Vec<String>,
}

#[derive(Deserialize)]
struct RefusedCase {
    name: String,
    source: String,
    log: serde_json::Value,
    error: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Fixture {
    time_stamp: String,
    sources: BTreeMap<String, Vec<String>>,
    cases: Vec<Case>,
    #[serde(default)]
    refused_cases: Vec<RefusedCase>,
}

fn fixture() -> Fixture {
    serde_json::from_str(include_str!("fixtures/step_log_parity_vectors.json")).expect("fixture parses")
}

/// Replace the GlobalId of every record above `max_id` with `<GUID>`.
fn normalise(out: &str, max_id: u32) -> Vec<String> {
    out.lines()
        .map(|line| {
            let Some(rest) = line.strip_prefix('#') else { return line.to_string() };
            let Some((id, body)) = rest.split_once('=') else { return line.to_string() };
            let Ok(id) = id.parse::<u32>() else { return line.to_string() };
            match body.split_once("('") {
                Some((_, tail)) if id > max_id && is_guid_then_quote(tail) => {
                    line.replacen(&tail[..22], "<GUID>", 1)
                }
                _ => line.to_string(),
            }
        })
        .collect()
}

/// `[0-9A-Za-z_$]{22}'`, the shape the TypeScript half normalises.
fn is_guid_then_quote(tail: &str) -> bool {
    let b = tail.as_bytes();
    b.len() > 22 && b[22] == b'\'' && b[..22].iter().all(|c| c.is_ascii_alphanumeric() || *c == b'_' || *c == b'$')
}

fn max_id(source: &[String]) -> u32 {
    source
        .iter()
        .filter_map(|l| l.strip_prefix('#')?.split_once('=')?.0.parse().ok())
        .max()
        .unwrap_or(0)
}

#[test]
fn rust_writer_matches_typescript_step_exporter() {
    let fx = fixture();
    assert!(!fx.cases.is_empty(), "the fixture must carry cases");
    let mut failures = Vec::new();
    for case in &fx.cases {
        let source = &fx.sources[&case.source];
        let content = format!("{}\n", source.join("\n"));
        let log = MutationLog::from_json(&case.log.to_string()).expect("log parses");
        let opts = StepOptions {
            time_stamp: Some(fx.time_stamp.clone()),
            schema: case.schema.clone(),
            ..StepOptions::default()
        };
        let (out, _) = export_step_with_log(content.as_bytes(), &opts, &log).expect("export succeeds");
        let got = normalise(&out, max_id(source));
        if got != case.expected {
            let first = got.iter().zip(&case.expected).position(|(a, b)| a != b).unwrap_or(got.len().min(case.expected.len()));
            failures.push(format!(
                "{}: first difference at line {}\n  rust: {:?}\n  ts:   {:?}",
                case.name,
                first + 1,
                got.get(first),
                case.expected.get(first)
            ));
        }
    }
    assert!(failures.is_empty(), "{} of {} cases diverge:\n{}", failures.len(), fx.cases.len(), failures.join("\n"));
}

#[test]
fn streaming_writer_writes_the_same_bytes() {
    let fx = fixture();
    for case in fx.cases.iter().take(5) {
        let content = format!("{}\n", fx.sources[&case.source].join("\n"));
        let log = MutationLog::from_json(&case.log.to_string()).unwrap();
        let opts = StepOptions { time_stamp: Some(fx.time_stamp.clone()), ..StepOptions::default() };
        let (whole, _) = export_step_with_log(content.as_bytes(), &opts, &log).unwrap();
        let mut streamed = Vec::new();
        export_step_with_log_to_writer(content.as_bytes(), &opts, &log, &mut streamed).unwrap();
        assert_eq!(whole.as_bytes(), streamed.as_slice(), "{}", case.name);
    }
}

#[test]
fn a_repeated_export_is_byte_identical_including_generated_ids() {
    let fx = fixture();
    let case = fx.cases.iter().find(|c| c.name == "update-property-in-existing-set").unwrap();
    let content = format!("{}\n", fx.sources[&case.source].join("\n"));
    let log = MutationLog::from_json(&case.log.to_string()).unwrap();
    let opts = StepOptions::default();
    let a = export_step_with_log(content.as_bytes(), &opts, &log).unwrap().0;
    let b = export_step_with_log(content.as_bytes(), &opts, &log).unwrap().0;
    assert_eq!(a, b);
}

#[test]
fn logs_the_typescript_replay_would_save_without_an_edit_are_refused() {
    let fx = fixture();
    assert!(!fx.refused_cases.is_empty(), "the fixture must carry refused cases");
    for case in &fx.refused_cases {
        let content = format!("{}\n", fx.sources[&case.source].join("\n"));
        let log = MutationLog::from_json(&case.log.to_string()).expect("log parses");
        let err = export_step_with_log(content.as_bytes(), &StepOptions::default(), &log)
            .expect_err(&format!("{} is refused", case.name));
        assert!(err.to_string().contains(&case.error), "{}: {err}", case.name);
    }
}
