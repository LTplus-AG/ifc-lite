// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! LandXML parse -> serde JSON golden hashes (#7671, charter #7670 §2 T3, gate G8).
//!
//! The parsers' serde output is what the wasm `parseLandXml*Bytes` entry
//! points hand the viewer, and nothing pinned it byte for byte. Each output
//! kind is pinned per fixture in `golden/<kind>.json`; a parse error is pinned
//! as its message, so a changed refusal moves the pin too. The hash, the file
//! format and the re-pin rule are shared with the export corpus
//! (`rust/export/tests/support/golden.rs`), and the fixture rule with the
//! export unit tests (`IFC_LITE_REQUIRE_FIXTURES`).

#[path = "../../export/src/test_support.rs"]
#[allow(dead_code, unused_macros)] // shared with the export unit tests; this file uses `fixture_opt` only
mod test_support;
#[path = "../../export/tests/support/golden.rs"]
mod golden;

use std::path::Path;

use golden::Golden;
use ifc_lite_landxml::alignment::{alignment_render_data, parse_landxml_alignments_optional};
use ifc_lite_landxml::{parse_landxml_document, parse_landxml_pipe_networks};
use serde::Serialize;

/// `(key, path)`: catalogued paths are under `tests/models/`; the one in-tree
/// sample is repo-relative and always present.
const FIXTURES: &[(&str, &str)] = &[
    ("viewer-sample-tin", "apps/viewer/public/samples/terrain-tin-metric.xml"),
    ("bonsai-terrain", "landxml/federation/bonsai-topo-control-v1/terrain.xml"),
    ("civil3d-foot-tin", "landxml/producers/autodesk-civil3d-2020-international-foot-tin.xml"),
    ("3dwin-rockbed-terrain", "landxml/producers/3d-win-6.6.4-m3-rockbed-terrain.xml"),
    ("3dwin-road-alignment", "landxml/producers/3d-win-6.6.4-m3-road-alignment.xml"),
    ("3dwin-lighting-cgpoints", "landxml/producers/3d-win-6.6.4-m3-lighting-cgpoints.xml"),
    ("aplitop-alignment", "landxml/producers/aplitop-mdt-8.0-alignment.xml"),
    ("openroads-survey-foot-alignment", "landxml/producers/bentley-openroads-designer-10.09-us-survey-foot-alignment.xml"),
    ("novapoint-drainage", "landxml/producers/trimble-novapoint-21.354-drainage.xml"),
];

fn fixtures() -> Vec<(&'static str, Vec<u8>)> {
    FIXTURES
        .iter()
        .filter_map(|(key, path)| {
            let bytes = if path.starts_with("apps/") {
                let abs = format!("{}/../../{path}", env!("CARGO_MANIFEST_DIR"));
                Some(std::fs::read(&abs).unwrap_or_else(|e| panic!("in-tree fixture {abs}: {e}")))
            } else {
                test_support::fixture_opt(path)
            };
            bytes.map(|b| (*key, b))
        })
        .collect()
}

/// The JSON of `Ok`, or the error message.
fn json<T: Serialize, E: std::fmt::Display>(result: Result<T, E>) -> Vec<u8> {
    match result {
        Ok(value) => serde_json::to_vec(&value).expect("parser output serialises"),
        Err(e) => format!("ERROR: {e}").into_bytes(),
    }
}

fn pin(kind: &'static str, output: impl Fn(&[u8]) -> Vec<u8>) {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/golden");
    let test = kind.replace('-', "_");
    let mut g = Golden::new(&dir, kind, &format!("cargo test -p ifc-lite-landxml --test landxml_golden -- --exact {test}"));
    for (key, bytes) in fixtures() {
        g.record(key, &output(&bytes));
    }
    g.finish(&FIXTURES.iter().map(|(k, _)| k.to_string()).collect::<Vec<_>>());
}

/// Terrain and plan, as `parseLandXmlTinBytes` reads them.
#[test]
fn document() {
    pin("document", |bytes| json(parse_landxml_document(bytes)));
}

#[test]
fn alignments() {
    pin("alignments", |bytes| json(parse_landxml_alignments_optional(bytes)));
}

/// The derived display spans `parseLandXmlSourceBytes` adds.
#[test]
fn alignment_render() {
    pin("alignment-render", |bytes| json(parse_landxml_alignments_optional(bytes).map(|d| alignment_render_data(&d))));
}

#[test]
fn pipe_networks() {
    pin("pipe-networks", |bytes| json(parse_landxml_pipe_networks(bytes)));
}
