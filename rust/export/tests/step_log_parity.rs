// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Rust half of the mutation-log STEP parity pin (#5941). The TypeScript half
//! is `packages/export/src/step-log.parity.test.ts`; both read
//! `fixtures/step_log_parity_vectors.json`, whose `expected` files the
//! TypeScript `StepExporter` wrote. The contract is byte identity, generated
//! GlobalIds aside (see the fixture's `about`).

use std::collections::BTreeMap;

use ifc_lite_export::{
    export_merged_models_with_logs, export_step_with_log, export_step_with_log_to_writer, MergedModel, MergedOptions,
    MutationLog, StepOptions,
};
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
struct MergedInput {
    source: String,
    log: serde_json::Value,
}

#[derive(Deserialize)]
struct MergedCase {
    name: String,
    #[allow(dead_code)] // documentation for the reader of the fixture
    why: String,
    #[serde(default)]
    schema: Option<String>,
    models: Vec<MergedInput>,
    expected: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Fixture {
    time_stamp: String,
    sources: BTreeMap<String, Vec<String>>,
    cases: Vec<Case>,
    #[serde(default)]
    merged_cases: Vec<MergedCase>,
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

/// Every quoted 22-character GlobalId-shaped token in the sources.
fn source_guids(fx: &Fixture) -> std::collections::HashSet<String> {
    let mut out = std::collections::HashSet::new();
    for line in fx.sources.values().flatten() {
        for part in line.split('\'').skip(1).step_by(2) {
            if part.len() == 22 && part.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'$') {
                out.insert(part.to_string());
            }
        }
    }
    out
}

#[test]
fn merged_export_bakes_each_log_as_the_typescript_merge_does() {
    let fx = fixture();
    assert!(!fx.merged_cases.is_empty(), "the fixture must carry merged cases");
    let known = source_guids(&fx);
    for case in &fx.merged_cases {
        let contents: Vec<String> =
            case.models.iter().map(|m| format!("{}\n", fx.sources[&m.source].join("\n"))).collect();
        let logs: Vec<MutationLog> =
            case.models.iter().map(|m| MutationLog::from_json(&m.log.to_string()).unwrap()).collect();
        let models: Vec<MergedModel> = contents
            .iter()
            .enumerate()
            .map(|(i, c)| {
                let mut m = MergedModel::new(c.as_bytes());
                m.id = format!("m{i}");
                m
            })
            .collect();
        let log_refs: Vec<Option<&MutationLog>> = logs.iter().map(Some).collect();
        let opts = MergedOptions { schema: Some(case.schema.clone().unwrap_or_else(|| "IFC4".into())), ..MergedOptions::default() };
        let (out, _) = export_merged_models_with_logs(&models, &log_refs, &opts).expect("merge succeeds");
        let data = &out[out.find("DATA;\n").expect("a DATA section")..];
        let got: Vec<String> = data
            .lines()
            .map(|line| match line.split_once("('") {
                Some((head, tail)) if head.starts_with('#') && is_guid_then_quote(tail) && !known.contains(&tail[..22]) => {
                    line.replacen(&tail[..22], "<GUID>", 1)
                }
                _ => line.to_string(),
            })
            .collect();
        assert_eq!(got, case.expected, "{}", case.name);
    }
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
