// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Rust half of the merged one-decomposition-parent parity pin (#5727 and
//! #5802, the twins of #5471, #5726 and #5725). The TypeScript half is
//! `packages/export/src/merged-single-parent.parity.test.ts`; both read
//! `fixtures/merged_single_parent_vectors.json`, whose expectations come from
//! IFC's `Decomposes` / `Nests : SET [0:1]`, not from either exporter's output.

use std::collections::{BTreeMap, HashMap};

use ifc_lite_export::{export_merged_models, ContainerMergeStrategy, MergedModel, MergedOptions};
use serde::Deserialize;

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default, deny_unknown_fields)]
struct CaseOptions {
    drop_empty_containers: bool,
    merge_sites: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Case {
    name: String,
    #[allow(dead_code)] // documentation for the reader of the fixture
    why: String,
    #[serde(default)]
    schema: Option<String>,
    #[serde(default)]
    output_schema: Option<String>,
    #[serde(default)]
    rels: Option<Vec<String>>,
    #[serde(default)]
    options: CaseOptions,
    models: Vec<Vec<String>>,
    parents: BTreeMap<String, Vec<String>>,
    #[serde(default)]
    absent: Vec<String>,
}

#[derive(Deserialize)]
struct Fixture {
    cases: Vec<Case>,
}

fn file(schema: &str, lines: &[String]) -> String {
    format!(
        "ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION((''),'2;1');\nFILE_SCHEMA(('{schema}'));\nENDSEC;\nDATA;\n{}\nENDSEC;\nEND-ISO-10303-21;\n",
        lines.join("\n")
    )
}

/// `#id=TYPE('guid',…` → (id, guid) for every rooted line.
fn guid_of(content: &str) -> HashMap<u32, String> {
    content
        .lines()
        .filter_map(|l| {
            let (id, rest) = l.strip_prefix('#')?.split_once('=')?;
            let guid = rest.split_once("('")?.1.split('\'').next()?;
            Some((id.trim().parse().ok()?, guid.to_string()))
        })
        .collect()
}

/// Top-level arguments of one entity line (the vectors carry no commas in strings).
fn args(line: &str) -> Vec<&str> {
    let body = &line[line.find('(').unwrap() + 1..line.rfind(')').unwrap()];
    let (mut out, mut depth, mut start) = (Vec::new(), 0, 0);
    for (i, c) in body.char_indices() {
        match c {
            '(' => depth += 1,
            ')' => depth -= 1,
            ',' if depth == 0 => {
                out.push(&body[start..i]);
                start = i + 1;
            }
            _ => {}
        }
    }
    out.push(&body[start..]);
    out
}

fn ids(arg: &str) -> Vec<u32> {
    arg.trim_matches(|c| c == '(' || c == ')')
        .split(',')
        .filter_map(|r| r.trim().strip_prefix('#')?.parse().ok())
        .collect()
}

/// Every line of `rel_types` as (single-valued end, list end): the list is the
/// one of arguments 4 and 5 that is parenthesised.
fn rels(content: &str, rel_types: &[String]) -> Vec<(u32, Vec<u32>)> {
    content
        .lines()
        .filter(|l| rel_types.iter().any(|t| l.contains(&format!("={t}("))))
        .map(|l| {
            let a = args(l);
            let (single, list) = if a[5].starts_with('(') { (a[4], a[5]) } else { (a[5], a[4]) };
            (ids(single)[0], ids(list))
        })
        .collect()
}

#[test]
fn merged_export_keeps_one_decomposition_parent_per_object() {
    let fixture: Fixture =
        serde_json::from_str(include_str!("fixtures/merged_single_parent_vectors.json")).unwrap();
    assert!(!fixture.cases.is_empty());
    for case in &fixture.cases {
        let schema = case.schema.clone().unwrap_or_else(|| "IFC4".to_string());
        let rel_types = case.rels.clone().unwrap_or_else(|| vec!["IFCRELAGGREGATES".to_string()]);
        let texts: Vec<String> = case.models.iter().map(|m| file(&schema, m)).collect();
        let models: Vec<MergedModel> = texts
            .iter()
            .enumerate()
            .map(|(i, t)| MergedModel { content: t.as_bytes(), id: i.to_string(), included: None })
            .collect();
        let mut opts = MergedOptions {
            schema: Some(case.output_schema.clone().unwrap_or_else(|| schema.clone())),
            drop_empty_containers: case.options.drop_empty_containers,
            ..MergedOptions::default()
        };
        match case.options.merge_sites.as_deref() {
            None => {}
            Some("by-name") => opts.merge_sites = ContainerMergeStrategy::ByName,
            Some(other) => panic!("{}: mergeSites {other:?} has no Rust mapping in this harness", case.name),
        }
        let (out, _) = export_merged_models(&models, &opts);
        let guids = guid_of(&out);
        let mut parents: BTreeMap<String, Vec<String>> = BTreeMap::new();
        let mut filled: HashMap<u32, usize> = HashMap::new();
        for (single, list) in rels(&out, &rel_types) {
            for id in list {
                *filled.entry(id).or_default() += 1;
                parents.entry(guids[&id].clone()).or_default().push(guids[&single].clone());
            }
        }
        let doubled: Vec<_> = filled.iter().filter(|(_, &n)| n > 1).collect();
        assert!(doubled.is_empty(), "{}: objects with two parents: {doubled:?}\n{out}", case.name);
        for (child, want) in &case.parents {
            let mut got = parents.get(child).cloned().unwrap_or_default();
            got.sort();
            assert_eq!(&got, want, "{}: parents of {child}\n{out}", case.name);
        }
        for guid in &case.absent {
            assert!(!out.contains(guid.as_str()), "{}: {guid} must not be written\n{out}", case.name);
        }
    }
}
