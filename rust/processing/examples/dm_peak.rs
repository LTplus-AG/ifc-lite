// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! `dm_peak` - the #9582 data-model extraction reproducer: ONE extraction per
//! process, so `/usr/bin/time` attributes the process's peak RSS to it and
//! nothing else.
//!
//! This measures `extract_data_model_with` ALONE. It is not an end-to-end
//! number: a server parse also runs geometry, symbolic extraction and two
//! Parquet serializations beside it, and its peak is the whole pipeline's.
//! For that, use `scripts/perf/dm-e2e-ab.mjs`, which drives the real
//! `POST /api/v1/parse/parquet` route on both sides of an A/B.
//!
//! ## Commands
//!
//! ```shell
//! # Build once, then one process per measurement.
//! cargo build --profile server-release -p ifc-lite-processing --example dm_peak
//!
//! # macOS: peak RSS in bytes on the "maximum resident set size" line.
//! /usr/bin/time -l ./target/server-release/examples/dm_peak \
//!     tests/models/ara3d/schependomlaan.ifc --entities rooted
//!
//! # Linux: peak RSS in KiB on the "Maximum resident set size" line.
//! /usr/bin/time -v ./target/server-release/examples/dm_peak \
//!     tests/models/ara3d/schependomlaan.ifc --entities rooted
//!
//! # The pre-#9582 path - full table, then narrowed - for the base side of a
//! # lever A/B. See "How the base side is measured" below.
//! /usr/bin/time -l ./target/server-release/examples/dm_peak \
//!     tests/models/ara3d/schependomlaan.ifc --entities rooted-postfilter
//!
//! # Machine-readable row (one JSON object on stdout; --entities both prints two).
//! ./target/server-release/examples/dm_peak model.ifc --entities both --json
//! ```
//!
//! `server-release` is the profile the server ships (release plus
//! `panic = "unwind"`), so the extraction measured here is the one a parse
//! runs. The workspace `release` profile aborts on panic and is otherwise
//! identical; `profiling` adds symbols. Do not measure a `dev` build.
//!
//! ## How the base side is measured, and why it is the same binary
//!
//! `--entities rooted-postfilter` runs `extract_data_model` and then
//! `DataModelEntities::apply`, which is EXACTLY what every caller did before
//! #9582: the full metadata table built, then narrowed. #9582 did not change
//! either of those two functions - `extract_data_model` delegates to
//! `extract_data_model_with` with the defaults, and `apply` is untouched - so
//! the base algorithm is still reachable, and `rooted` vs
//! `rooted-postfilter` in ONE binary is the lever, with codegen, allocator
//! and host held fixed.
//!
//! It is also the only way to measure it here: a base checkout has no
//! `extract_data_model_with`, so this file cannot be injected into one and
//! built (`build-at-ref.sh --inject` fails at `use`). The genuine
//! two-binary, base-vs-branch comparison is `scripts/perf/dm-e2e-ab.mjs`,
//! which builds the server from each side; this harness isolates the lever
//! inside one build.
//!
//! `rooted_tests.rs` asserts the two paths produce the same data model table
//! for table, on real models and on spatial edge-case fixtures, so the
//! `digest` below is expected to MATCH between `rooted` and
//! `rooted-postfilter`. A run where it does not is a correctness failure, not
//! a measurement.
//!
//! Interleave the variants, one `/usr/bin/time` process per run, alternating
//! which goes first, and take the MEDIAN peak across repetitions; a single
//! run is noise. Run on an otherwise idle machine: a `cargo test` running
//! beside an earlier sweep is what inflated this harness's own spread to 43%
//! once (AGENTS.md, "Guard against contaminated measurement").
//!
//! ## The digest
//!
//! `--json` and the human line both carry `digest`, a 64-bit FNV-1a over
//! EVERY table of the resulting [`DataModel`], in a fixed order, each row
//! encoded as its `serde_json` form (struct field order, so the encoding is
//! the declaration). A table's name is folded in before its rows, so moving a
//! row between two tables cannot cancel out, and `total_entities` and
//! `refused` are folded in too. `digest` is therefore an output-identity
//! check across builds, not a performance number: equal digests mean the two
//! binaries produced the same data model table for table.
//!
//! It is NOT a wire-format check. `serialize_data_model_to_parquet` names its
//! own columns, and `DataModel` is not `Serialize`; the digest reads more
//! fields than the Parquet encoding carries, so it is the stricter of the two.

use ifc_lite_core::hash::{fnv1a64_extend, FNV64_OFFSET};
use ifc_lite_processing::data_model::{
    extract_data_model, extract_data_model_with, DataModel, DataModelEntities, DataModelOptions,
};
use serde::Serialize;

/// Fold one named table into the running hash: the name first (so a row that
/// moves between tables changes the digest), then the row count, then each
/// row's `serde_json` encoding.
fn fold_rows<T: Serialize>(hash: u64, name: &str, rows: &[T]) -> u64 {
    let mut hash = fnv1a64_extend(hash, name.as_bytes());
    hash = fnv1a64_extend(hash, &(rows.len() as u64).to_le_bytes());
    for row in rows {
        let encoded = serde_json::to_vec(row).expect("data-model rows are Serialize");
        hash = fnv1a64_extend(hash, &encoded);
    }
    hash
}

/// FNV-1a over every table of the data model. See the module header.
fn digest(dm: &DataModel) -> u64 {
    let mut hash = FNV64_OFFSET;
    hash = fnv1a64_extend(hash, &(dm.total_entities as u64).to_le_bytes());
    hash = fold_rows(hash, "entities", &dm.entities);
    hash = fold_rows(hash, "property_sets", &dm.property_sets);
    hash = fold_rows(hash, "quantity_sets", &dm.quantity_sets);
    hash = fold_rows(hash, "relationships", &dm.relationships);
    hash = fold_rows(hash, "classifications", &dm.classifications);
    hash = fold_rows(hash, "materials", &dm.materials);
    hash = fold_rows(hash, "documents", &dm.documents);
    // The spatial hierarchy is one struct, not a table of rows, and every
    // field of it is a Vec: no map iteration order can reach the digest.
    let spatial = serde_json::to_vec(&dm.spatial_hierarchy)
        .expect("SpatialHierarchyData is Serialize");
    hash = fnv1a64_extend(hash, b"spatial_hierarchy");
    hash = fnv1a64_extend(hash, &spatial);
    hash = fnv1a64_extend(hash, b"refused");
    hash = fnv1a64_extend(hash, dm.refused.as_deref().unwrap_or("").as_bytes());
    hash
}

/// What one extraction reports. Printed as one JSON object per variant under
/// `--json`, so a harness can diff two builds field by field.
fn report(path: &str, bytes: usize, variant: &str, dm: &DataModel, elapsed_ms: f64, json: bool) {
    let d = digest(dm);
    if json {
        println!(
            "{}",
            serde_json::json!({
                "path": path,
                "file_bytes": bytes,
                "entities": variant,
                "rows": dm.entities.len(),
                "total_entities": dm.total_entities,
                "property_sets": dm.property_sets.len(),
                "quantity_sets": dm.quantity_sets.len(),
                "relationships": dm.relationships.len(),
                "classifications": dm.classifications.len(),
                "materials": dm.materials.len(),
                "documents": dm.documents.len(),
                "spatial_nodes": dm.spatial_hierarchy.nodes.len(),
                "refused": dm.refused,
                "extract_ms": elapsed_ms,
                "digest": format!("{d:016x}"),
            })
        );
    } else {
        println!(
            "{path}  {:.1} MB  entities={variant}  rows={} / {} instances  \
             psets={} qsets={} rels={} spatial={}  {elapsed_ms:.0} ms  digest={d:016x}",
            bytes as f64 / 1e6,
            dm.entities.len(),
            dm.total_entities,
            dm.property_sets.len(),
            dm.quantity_sets.len(),
            dm.relationships.len(),
            dm.spatial_hierarchy.nodes.len(),
        );
    }
}

const USAGE: &str =
    "usage: dm_peak <model.ifc> [--entities all|rooted|rooted-postfilter|both] [--json]";

fn main() {
    let mut path: Option<String> = None;
    let mut variants = vec!["all".to_string()];
    let mut json = false;
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--entities" => {
                let value = args.next().unwrap_or_else(|| {
                    eprintln!("dm_peak: --entities needs all|rooted|both\n{USAGE}");
                    std::process::exit(2);
                });
                variants = match value.as_str() {
                    "all" => vec!["all".to_string()],
                    "rooted" => vec!["rooted".to_string()],
                    "rooted-postfilter" => vec!["rooted-postfilter".to_string()],
                    // `both` is for a quick look, NOT for a peak measurement:
                    // two extractions in one process share a high-water mark,
                    // so `/usr/bin/time` can no longer attribute it.
                    "both" => vec!["all".to_string(), "rooted".to_string()],
                    other => {
                        eprintln!("dm_peak: unknown --entities {other:?}\n{USAGE}");
                        std::process::exit(2);
                    }
                };
            }
            "--json" => json = true,
            "-h" | "--help" => {
                println!("{USAGE}");
                return;
            }
            other if other.starts_with('-') => {
                eprintln!("dm_peak: unknown flag {other:?}\n{USAGE}");
                std::process::exit(2);
            }
            other => path = Some(other.to_string()),
        }
    }
    let Some(path) = path else {
        eprintln!("dm_peak: pass one model path\n{USAGE}");
        std::process::exit(2);
    };
    let content = match std::fs::read(&path) {
        Ok(content) => content,
        Err(e) => {
            eprintln!("dm_peak: cannot read {path}: {e} (fetch fixtures with `pnpm fixtures`)");
            std::process::exit(1);
        }
    };
    let bytes = content.len();

    for variant in &variants {
        let started = std::time::Instant::now();
        let dm = match variant.as_str() {
            // The pre-#9582 path, verbatim: build every row, then drop five
            // in six. Neither call changed in #9582, so this IS the base.
            "rooted-postfilter" => {
                let mut dm = extract_data_model(&content);
                DataModelEntities::Rooted.apply(&mut dm);
                dm
            }
            "rooted" => extract_data_model_with(
                &content,
                DataModelOptions::for_entities(DataModelEntities::Rooted),
            ),
            _ => extract_data_model_with(
                &content,
                DataModelOptions::for_entities(DataModelEntities::All),
            ),
        };
        let elapsed_ms = started.elapsed().as_secs_f64() * 1e3;
        report(&path, bytes, variant, &dm, elapsed_ms, json);
        // Dropping here rather than at the end of main keeps a `--entities
        // both` run from holding two models at once; the peak is still
        // unattributable in that mode, but it is not doubled on purpose.
        drop(dm);
    }
}
