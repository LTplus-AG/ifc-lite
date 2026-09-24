// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Rust half of the merged one-aggregation-parent parity pin (#5727, the
//! twin of #5471). The TypeScript half is
//! `packages/export/src/merged-single-parent.parity.test.ts`; both read
//! `fixtures/merged_single_parent_vectors.json`, whose expectations come from
//! IFC's `Decomposes : SET [0:1]`, not from either exporter's output.

use std::collections::{BTreeMap, HashMap};

use ifc_lite_export::{export_merged_models, MergedModel, MergedOptions};
use serde::Deserialize;

#[derive(Deserialize)]
struct Case {
    name: String,
    models: Vec<Vec<String>>,
    parents: BTreeMap<String, Vec<String>>,
}

#[derive(Deserialize)]
struct Fixture {
    cases: Vec<Case>,
}

fn file(lines: &[String]) -> String {
    format!(
        "ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION((''),'2;1');\nFILE_SCHEMA(('IFC4'));\nENDSEC;\nDATA;\n{}\nENDSEC;\nEND-ISO-10303-21;\n",
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

/// Every IFCRELAGGREGATES as (relating, related[]).
fn aggregates(content: &str) -> Vec<(u32, Vec<u32>)> {
    content
        .lines()
        .filter(|l| l.contains("=IFCRELAGGREGATES("))
        .map(|l| {
            let (head, list) = l.rsplit_once(",(").expect("a RelatedObjects list");
            let relating = head.rsplit_once(",#").expect("a RelatingObject").1.parse().unwrap();
            let related = list
                .trim_end_matches(");")
                .trim_end_matches(')')
                .split(',')
                .map(|r| r.trim().trim_start_matches('#').parse().unwrap())
                .collect();
            (relating, related)
        })
        .collect()
}

#[test]
fn merged_export_keeps_one_aggregation_parent_per_object() {
    let fixture: Fixture =
        serde_json::from_str(include_str!("fixtures/merged_single_parent_vectors.json")).unwrap();
    assert!(!fixture.cases.is_empty());
    for case in &fixture.cases {
        let texts: Vec<String> = case.models.iter().map(|m| file(m)).collect();
        let models: Vec<MergedModel> = texts
            .iter()
            .enumerate()
            .map(|(i, t)| MergedModel { content: t.as_bytes(), id: i.to_string(), included: None })
            .collect();
        let (out, _) = export_merged_models(&models, &MergedOptions::default());
        let guids = guid_of(&out);
        let mut parents: BTreeMap<String, Vec<String>> = BTreeMap::new();
        let mut membership: HashMap<u32, usize> = HashMap::new();
        for (relating, related) in aggregates(&out) {
            for id in related {
                *membership.entry(id).or_default() += 1;
                parents.entry(guids[&id].clone()).or_default().push(guids[&relating].clone());
            }
        }
        let doubled: Vec<_> = membership.iter().filter(|(_, &n)| n > 1).collect();
        assert!(doubled.is_empty(), "{}: objects with two parents: {doubled:?}\n{out}", case.name);
        for (child, want) in &case.parents {
            let mut got = parents.get(child).cloned().unwrap_or_default();
            got.sort();
            assert_eq!(&got, want, "{}: parents of {child}\n{out}", case.name);
        }
    }
}
