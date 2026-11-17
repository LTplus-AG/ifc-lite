// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! #9584 conformance property 1: the native writer is byte-self-reproducible,
//! including across thread counts. The geometry chunk order is the pipeline's
//! emit order, so no batch-completion order may reach the bytes.
//!
//! The committed viewer samples are used so this never skips; the catalogued
//! fixture below is read through `ifc_lite_testkit::fixture_bytes`, so it skips
//! locally when absent and fails in CI, where the fixtures are required.

use ifc_lite_cache::{build_cache, CacheOptions, FORMAT_VERSION};

fn workspace_file(path: &str) -> Option<Vec<u8>> {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    std::fs::read(root.join(path)).ok()
}

fn sample(name: &str) -> Vec<u8> {
    workspace_file(&format!("apps/viewer/public/samples/{name}"))
        .unwrap_or_else(|| panic!("committed sample {name} is missing"))
}

fn build_on(threads: usize, source: &[u8]) -> Vec<u8> {
    let pool = rayon::ThreadPoolBuilder::new().num_threads(threads).build().unwrap();
    pool.install(|| build_cache(source, CacheOptions::default()).unwrap().0)
}

fn assert_reproducible(label: &str, source: &[u8]) {
    let one = build_on(1, source);
    let many = build_on(8, source);
    let again = build_on(8, source);
    assert_eq!(many, again, "{label}: two runs on the same pool size differ");
    assert_eq!(one, many, "{label}: 1 thread and 8 threads differ");
    assert_eq!(u16::from_le_bytes([one[4], one[5]]), FORMAT_VERSION);
}

#[test]
fn issue_9584_samples_are_byte_identical_across_runs_and_thread_counts() {
    for name in ["hello-wall.ifc", "building-architecture.ifc"] {
        assert_reproducible(name, &sample(name));
    }
}

#[test]
fn issue_9584_catalogued_fixture_is_byte_identical_across_thread_counts() {
    // Gated read: absent skips locally, but fails under IFC_LITE_REQUIRE_FIXTURES (CI).
    let path = "ara3d/AC20-FZK-Haus.ifc";
    let Some(source) = ifc_lite_testkit::fixture_bytes(path) else {
        eprintln!("SKIP: tests/models/{path} absent; run `pnpm fixtures`");
        return;
    };
    assert_reproducible(path, &source);
}

#[test]
fn issue_9584_stats_describe_the_written_cache() {
    let source = sample("building-architecture.ifc");
    let (bytes, stats) = build_cache(&source, CacheOptions::default()).unwrap();
    assert_eq!(stats.cache_bytes, bytes.len() as u64);
    assert!(stats.mesh_count > 0 && stats.chunk_count > 0);
    let word = |at: usize| u32::from_le_bytes(bytes[at..at + 4].try_into().unwrap());
    assert_eq!(u64::from(word(17)), stats.entity_count, "header entityCount");
    assert_eq!(u64::from(word(21)), stats.total_vertices);
    assert_eq!(u64::from(word(25)), stats.total_triangles);
    // HasGeometry set, SourceHashUnset (bit 3) not: the hash is real.
    assert_eq!(u16::from_le_bytes([bytes[6], bytes[7]]), 1 << 1);
}

#[test]
fn issue_9584_omitting_the_hash_sets_bit_3_and_zeroes_it() {
    let source = sample("hello-wall.ifc");
    let options = CacheOptions { omit_source_hash: true, include_geometry: false, ..CacheOptions::default() };
    let (bytes, stats) = build_cache(&source, options).unwrap();
    assert_eq!(u16::from_le_bytes([bytes[6], bytes[7]]), 1 << 3);
    assert_eq!(&bytes[8..16], &[0; 8]);
    assert_eq!(stats.mesh_count, 0);
    assert_eq!(u16::from_le_bytes([bytes[29], bytes[30]]), 6, "no Geometry section");
}

#[test]
fn issue_9584_entity_count_is_the_file_wide_scan_not_the_rooted_row_count() {
    // `extract_data_model_with` returns the narrowed model beside the scan's
    // own total. The Rooted variant drops five rows in six, so reading the
    // header count off `model.entities.len()` would under-report the file by
    // that margin -- and every other assertion here still passes when it does,
    // because both numbers would move together. Pin the gap itself.
    let source = sample("building-architecture.ifc");
    let (bytes, stats) = build_cache(&source, CacheOptions::default()).unwrap();
    assert!(
        stats.entity_count > stats.entity_rows,
        "Rooted narrowing must leave fewer rows ({}) than instances scanned ({})",
        stats.entity_rows,
        stats.entity_count,
    );
    let header_count = u32::from_le_bytes(bytes[17..21].try_into().unwrap());
    assert_eq!(u64::from(header_count), stats.entity_count, "header carries the scan total");
    assert_ne!(u64::from(header_count), stats.entity_rows, "header must not carry the row count");
}
