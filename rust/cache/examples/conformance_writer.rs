// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Test harness for `scripts/cache-native-conformance.mjs` (#9584): writes the
//! native cache of one IFC so the TypeScript reader and writer can be run
//! against it. Not a distributed tool; the CLI is a later slice.
//!
//!   cargo run -p ifc-lite-cache --example conformance_writer -- <in.ifc> <out.ifclite>

use ifc_lite_cache::{build_cache, CacheOptions};

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let [input, output] = args.as_slice() else {
        eprintln!("usage: conformance_writer <in.ifc> <out.ifclite>");
        std::process::exit(2);
    };
    let source = std::fs::read(input).unwrap_or_else(|error| panic!("read {input}: {error}"));
    let (bytes, stats) = build_cache(&source, CacheOptions::default())
        .unwrap_or_else(|error| panic!("build {input}: {error}"));
    std::fs::write(output, &bytes).unwrap_or_else(|error| panic!("write {output}: {error}"));
    println!(
        "{{\"entityCount\":{},\"entityRows\":{},\"meshCount\":{},\"skippedMeshes\":{},\"chunkCount\":{},\"totalVertices\":{},\"totalTriangles\":{},\"cacheBytes\":{}}}",
        stats.entity_count,
        stats.entity_rows,
        stats.mesh_count,
        stats.skipped_meshes,
        stats.chunk_count,
        stats.total_vertices,
        stats.total_triangles,
        stats.cache_bytes,
    );
}
