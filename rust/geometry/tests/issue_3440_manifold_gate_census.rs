// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! #3440 step 3 measurement: how many hosts across the fixture corpus does the
//! edge-multiplicity gate (`manifold_gate_reject`) actually REJECT?
//!
//! This is the flip-set measurement the issue demands before a gate changes
//! behaviour. It says the gate is cheap to ship - 110 of 2071 hosts reject and
//! all 110 are still cut by a downstream fallback - and that reading is what
//! made the gate look safe to turn on by default. It is not sufficient:
//! "still cut" is not "cut as well", and this repo's pinned quality fixtures
//! say the fallback is worse than the tear. See `csg_manifold_gate` in
//! `Cargo.toml` for the numbers. Keep that in mind before reading the count
//! below as a green light.
//!
//! Needs the `csg_manifold_gate` feature (this file compiles to an empty,
//! trivially-passing binary without it), and is `#[ignore]`d because it also
//! needs the fixture corpus, which `cargo test --workspace` does not have on a
//! clean checkout — an assertion over an
//! empty corpus would measure nothing while reading green. Fetch the corpus
//! (`node scripts/fixtures/fetch-fixtures.mjs`) and run:
//!
//!   cargo test -p ifc-lite-geometry --features csg_manifold_gate \
//!     --test issue_3440_manifold_gate_census -- --ignored --nocapture

#![cfg(feature = "csg_manifold_gate")]

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
    /// Rejections citing at least one >2-use edge, and at least one
    /// same-direction pair. A single rejection can be in both.
    rejections_with_over_used: usize,
    rejections_with_same_direction: usize,
    over_used_edges: usize,
    same_direction_edges: usize,
    /// Of the rejected hosts: how many end up with geometry identical to the
    /// un-voided element (the opening is gone), how many are still cut by a
    /// downstream fallback, how many failed to process either way.
    rejected_and_left_un_cut: usize,
    rejected_but_still_cut: usize,
    rejected_and_errored: usize,
    examples: Vec<String>,
}

#[test]
#[ignore = "needs the fixture corpus (node scripts/fixtures/fetch-fixtures.mjs)"]
fn manifold_gate_census_over_the_fixture_corpus() {
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
            let cut = router.process_element_with_voids(&entity, &mut decoder, &voids);
            t.hosts_swept += 1;

            let failures = router.take_csg_failures();
            let Some(host_failures) = failures.get(&host_id) else {
                continue;
            };
            for f in host_failures {
                if let BoolFailureReason::NonManifoldRejected {
                    over_used,
                    same_direction,
                } = f.reason
                {
                    t.over_used_edges += over_used;
                    t.same_direction_edges += same_direction;
                    if over_used > 0 {
                        t.rejections_with_over_used += 1;
                    }
                    if same_direction > 0 {
                        t.rejections_with_same_direction += 1;
                    }
                }
            }
            let rejected: Vec<&str> = host_failures
                .iter()
                .filter(|f| matches!(f.reason, BoolFailureReason::NonManifoldRejected { .. }))
                .map(|f| match f.op {
                    ifc_lite_geometry::BoolOp::Difference => "Difference",
                    ifc_lite_geometry::BoolOp::Union => "Union",
                    ifc_lite_geometry::BoolOp::Intersection => "Intersection",
                    ifc_lite_geometry::BoolOp::Unknown => "Unknown",
                })
                .collect();
            if !rejected.is_empty() {
                t.hosts_rejected += 1;
                // Does the rejection cost the host its opening, or does the
                // void router's own #635 AABB fallback still cut it? A gate
                // that silently returns un-cut hosts is a different failure,
                // not a fix, so the flip set has to be split this way before
                // the gate can be called an improvement. `un_cut` is the same
                // element processed with an EMPTY void index: byte-identical
                // indices mean nothing was subtracted at all.
                let mut d2 = EntityDecoder::with_index(&content, ei.clone());
                let empty: FxHashMap<u32, Vec<u32>> = FxHashMap::default();
                let un_cut = GeometryRouter::with_units(&content, &mut d2)
                    .process_element_with_voids(&entity, &mut d2, &empty);
                match (&cut, &un_cut) {
                    (Ok(a), Ok(b)) if a.indices == b.indices => t.rejected_and_left_un_cut += 1,
                    (Ok(_), Ok(_)) => t.rejected_but_still_cut += 1,
                    _ => t.rejected_and_errored += 1,
                }
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
        "#3440 step 3 manifold-gate census: {} void hosts swept across {} models, {} REJECTED",
        t.hosts_swept,
        models.len(),
        t.hosts_rejected
    );
    println!(
        "  by defect class: {} rejection(s) cite a >2-use edge ({} edges), \
         {} cite a same-direction pair ({} edges)",
        t.rejections_with_over_used,
        t.over_used_edges,
        t.rejections_with_same_direction,
        t.same_direction_edges
    );
    println!(
        "  of the {} rejected hosts: {} still cut by a downstream fallback, \
         {} left un-cut, {} errored",
        t.hosts_rejected,
        t.rejected_but_still_cut,
        t.rejected_and_left_un_cut,
        t.rejected_and_errored
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
