// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! #3440 step 2 measurement: how many hosts across the fixture corpus does
//! `csg_topology_gate` actually REJECT?
//!
//! Deliberately separate from `triangulation_invariance.rs`'s per-host
//! `edge_stats.open` census. That census and this gate's own predicate
//! (`directed_closed` / `closed_or_hairline`, shared with the analytic
//! prism-cut path) are two independently-implemented readings of
//! watertightness — issue #3435 documents them diverging — so a host this
//! test reports as gate-rejected is not guaranteed to be one `edge_stats`
//! counts as open, or vice versa. This test measures what the GATE actually
//! does (`GeometryRouter::take_csg_failures` after driving the real void-cut
//! path), not a second, independent edge count.
//!
//! Requires the `csg_topology_gate` feature (this file compiles to an empty,
//! trivially-passing binary without it) and the fixture corpus fetched via
//! `node scripts/fixtures/fetch-fixtures.mjs`:
//!
//!   cargo test -p ifc-lite-geometry --features csg_topology_gate \
//!     --test issue_3440_topology_gate_census -- --nocapture

#![cfg(feature = "csg_topology_gate")]

use ifc_lite_core::{build_entity_index, EntityDecoder, EntityScanner};
use ifc_lite_geometry::{propagate_voids_to_parts, BoolFailureReason, GeometryRouter};
use rustc_hash::FxHashMap;
use std::path::PathBuf;

fn crate_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

/// Every `.ifc` fixture in the manifest, INCLUDING ones over
/// `MAX_FIXTURE_BYTES` (unlike `triangulation_invariance.rs`'s
/// `discover_models`) — the issue's own cited host, `IFCWALLSTANDARDCASE
/// #43810` in `ISSUE_068_ARK_NUS_skolebygg.ifc`, lives in a fixture over that
/// filter, and excluding it would silently drop the one host the issue names.
fn discover_all_models() -> Vec<(String, PathBuf)> {
    let models = crate_dir().join("..").join("..").join("tests/models");
    let Ok(raw) = std::fs::read_to_string(models.join("manifest.json")) else {
        return Vec::new();
    };
    let Ok(json) = serde_json::from_str::<serde_json::Value>(&raw) else {
        return Vec::new();
    };
    let mut out: Vec<(String, PathBuf)> = json["files"]
        .as_array()
        .map(|files| {
            files
                .iter()
                .filter_map(|f| f["path"].as_str())
                .filter(|p| p.ends_with(".ifc"))
                .map(|rel| (rel.to_string(), models.join(rel)))
                .filter(|(_, p)| std::fs::metadata(p).map(|m| m.is_file()).unwrap_or(false))
                .collect()
        })
        .unwrap_or_default();
    out.sort();
    out
}

/// `IfcRelVoidsElement` host -> opening ids, plus part propagation. Same
/// query `triangulation_invariance.rs::void_index` runs; duplicated here
/// (rather than made `pub` there) because that file is a production-adjacent
/// module-size-ratchet-exempt TEST file already at its own considerable size,
/// and this query is nine lines over public crate APIs.
fn void_index(content: &str) -> FxHashMap<u32, Vec<u32>> {
    let mut idx: FxHashMap<u32, Vec<u32>> = FxHashMap::default();
    let mut scanner = EntityScanner::new(content);
    let mut decoder = EntityDecoder::new(content);
    while let Some((id, name, start, end)) = scanner.next_entity() {
        if name == "IFCRELVOIDSELEMENT" {
            if let Ok(entity) = decoder.decode_at_with_id(id, start, end) {
                if let (Some(host), Some(opening)) = (entity.get_ref(4), entity.get_ref(5)) {
                    idx.entry(host).or_default().push(opening);
                }
            }
        }
    }
    let _ = propagate_voids_to_parts(&mut idx, content, &mut decoder);
    idx
}

#[derive(Default)]
struct Tally {
    hosts_swept: usize,
    hosts_rejected: usize,
    rejections_by_op: FxHashMap<&'static str, usize>,
    examples: Vec<String>,
}

#[test]
fn topology_gate_census_over_the_fixture_corpus() {
    let models = discover_all_models();
    assert!(
        !models.is_empty(),
        "no fixtures on disk — run `node scripts/fixtures/fetch-fixtures.mjs` first; \
         this test measures nothing over an empty corpus"
    );

    let mut t = Tally::default();
    for (rel_path, abs_path) in &models {
        let Ok(content) = std::fs::read_to_string(abs_path) else {
            continue;
        };
        let voids = void_index(&content);
        if voids.is_empty() {
            continue;
        }
        let ei = build_entity_index(&content);
        for &host_id in voids.keys() {
            let mut decoder = EntityDecoder::with_index(&content, ei.clone());
            let Ok(entity) = decoder.decode_by_id(host_id) else {
                continue;
            };
            let router = GeometryRouter::with_units(&content, &mut decoder);
            let _ = router.process_element_with_voids(&entity, &mut decoder, &voids);
            t.hosts_swept += 1;

            let failures = router.take_csg_failures();
            let Some(host_failures) = failures.get(&host_id) else {
                continue;
            };
            let rejected: Vec<&str> = host_failures
                .iter()
                .filter(|f| f.reason == BoolFailureReason::OpenTopologyRejected)
                .map(|f| match f.op {
                    ifc_lite_geometry::BoolOp::Difference => "Difference",
                    ifc_lite_geometry::BoolOp::Union => "Union",
                    ifc_lite_geometry::BoolOp::Intersection => "Intersection",
                    ifc_lite_geometry::BoolOp::Unknown => "Unknown",
                })
                .collect();
            if !rejected.is_empty() {
                t.hosts_rejected += 1;
                for op in &rejected {
                    *t.rejections_by_op.entry(op).or_default() += 1;
                }
                if t.examples.len() < 20 {
                    t.examples.push(format!(
                        "{rel_path} #{host_id} ({} rejection(s): {})",
                        rejected.len(),
                        rejected.join(", ")
                    ));
                }
            }
        }
    }

    println!(
        "#3440 step 2 topology-gate census: {} void hosts swept across {} models, {} REJECTED",
        t.hosts_swept,
        models.len(),
        t.hosts_rejected
    );
    let mut by_op: Vec<(&str, usize)> = t.rejections_by_op.into_iter().collect();
    by_op.sort();
    for (op, count) in &by_op {
        println!("  by op: {op} = {count}");
    }
    for ex in &t.examples {
        println!("  e.g. {ex}");
    }

    assert!(
        t.hosts_swept >= 1000,
        "swept only {} void hosts — the corpus looks partially fetched, \
         this run's reject count is not the full-corpus number",
        t.hosts_swept
    );
}
