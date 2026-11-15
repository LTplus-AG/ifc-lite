// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! #9584 slice 3: the streaming writer is byte-identical to the in-memory
//! one. `build_cache` is the surface the cross-language conformance gate
//! (`scripts/cache-native-conformance.mjs`) checks against the TS reader and
//! writer, so this identity carries that conformance over to
//! `build_cache_to_path` and the `ifc-build-cache` CLI.
//!
//! The streamed path never holds the mesh set: it chunks the pipeline's jobs,
//! retains nothing, groups each mesh as it is emitted and spools each chunk as
//! it closes. Any drift in mesh order, grouping, the cap-closed chunk order,
//! the totals, the bounds or the spool copy shows up here as a byte diff.
//!
//! The committed viewer samples always run; the catalogued fixtures are read
//! through `ifc_lite_testkit::fixture_bytes`, so they skip locally when absent
//! and fail in CI, where the fixtures are required.

use std::path::{Path, PathBuf};

use ifc_lite_cache::{build_cache, build_cache_to_path, CacheOptions};

fn workspace(path: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../..").join(path)
}

fn scratch(test: &str) -> PathBuf {
    let dir = Path::new(env!("CARGO_TARGET_TMPDIR")).join(format!("{test}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn assert_identical(label: &str, source: &[u8], options: CacheOptions, dir: &Path) {
    let (expected, expected_stats) = build_cache(source, options).unwrap();
    let output = dir.join("model.ifclite");
    let stats = build_cache_to_path(source, &output, options).unwrap();
    let streamed = std::fs::read(&output).unwrap();
    if let Some(at) = expected.iter().zip(&streamed).position(|(a, b)| a != b) {
        panic!("{label} {options:?}: streamed differs from in-memory at byte {at}");
    }
    assert_eq!(streamed.len(), expected.len(), "{label} {options:?}: length");
    assert_eq!(stats, expected_stats, "{label} {options:?}: stats");
    let names: Vec<_> = std::fs::read_dir(dir).unwrap().map(|e| e.unwrap().file_name()).collect();
    assert_eq!(names, ["model.ifclite"], "{label}: only the output is left behind");
}

#[test]
fn issue_9584_committed_samples_stream_byte_identical_under_every_option() {
    let dir = scratch("committed");
    let variants = [
        CacheOptions::default(),
        CacheOptions { compress_geometry_chunks: false, ..CacheOptions::default() },
        CacheOptions { omit_source_hash: true, ..CacheOptions::default() },
        CacheOptions { include_geometry: false, ..CacheOptions::default() },
    ];
    // The last two are rotated-site models: the streamed pass learns the
    // removed site rotation from `on_frame`, the retained one from the
    // result's frame, and both must restore it to the same bytes.
    for name in [
        "apps/viewer/public/samples/hello-wall.ifc",
        "apps/viewer/public/samples/building-architecture.ifc",
        "apps/viewer/public/samples/infra-bridge.ifc",
        "rust/cache/tests/fixtures/rotated_site_90.ifc",
        "rust/processing/tests/fixtures/issue_8190_slab_12381.ifc",
    ] {
        let source = std::fs::read(workspace(name)).unwrap_or_else(|e| panic!("committed sample {name}: {e}"));
        for options in variants {
            assert_identical(name, &source, options, &dir);
        }
    }
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn issue_9584_catalogued_fixtures_stream_byte_identical() {
    let dir = scratch("catalogued");
    // A real authoring-tool house, and a CSG/void-heavy model whose chunks
    // deflate (the AGENTS.md perf fixtures).
    // Gated reads: absent skips locally, but fails under IFC_LITE_REQUIRE_FIXTURES (CI).
    for path in [
        "ara3d/AC20-FZK-Haus.ifc",
        "ara3d/ISSUE_129_N1540_17_EXE_MOD_448200_02_09_11SMC_IGC_V17.ifc",
    ] {
        let Some(source) = ifc_lite_testkit::fixture_bytes(path) else {
            eprintln!("SKIP: tests/models/{path} absent; run `pnpm fixtures`");
            continue;
        };
        assert_identical(path, &source, CacheOptions::default(), &dir);
    }
    std::fs::remove_dir_all(dir).unwrap();
}
