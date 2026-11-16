// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Test harness for `scripts/cache-native-conformance.mjs` (#9584): writes the
//! native cache of one IFC so the TypeScript reader and writer can be run
//! against it. Not a distributed tool; the CLI is a later slice.
//!
//!   cargo run -p ifc-lite-cache --example conformance_writer -- <in.ifc> <out.ifclite>
//!   cargo run -p ifc-lite-cache --example conformance_writer -- --deflated-length <payload>
//!
//! The second form prints the length of a raw chunk payload under the
//! writer's own compressor, so the gate can check a raw chunk was stored raw
//! because compressing it was not strictly smaller.

use ifc_lite_cache::{build_cache, deflate_raw_len, CacheOptions};

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if let [flag, payload] = args.as_slice() {
        if flag == "--deflated-length" {
            let bytes = std::fs::read(payload).unwrap_or_else(|error| panic!("read {payload}: {error}"));
            println!("{}", deflate_raw_len(&bytes));
            return;
        }
    }
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
