// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! `ifc-build-cache`: build the browser-readable `.ifclite` cache of one IFC
//! file natively (#9584). A thin CLI over
//! [`ifc_lite_cache::build_cache_to_path`]: the output streams to disk, is
//! byte-identical to the in-memory writer's, and appears atomically.
//!
//! Prints the build's stats as one JSON object on stdout.

use std::fs::File;
use std::path::PathBuf;
use std::process::ExitCode;

use ifc_lite_cache::{build_cache_to_path, CacheOptions, CacheStats, FORMAT_VERSION};

const USAGE: &str = "\
usage: ifc-build-cache [options] <input.ifc> <output.ifclite>

Builds the @ifc-lite/cache binary cache (format v{VERSION}) of an IFC STEP
file. The output is written to a temporary file beside it and renamed into
place, so it is either complete or untouched.

options:
  --no-geometry       write the data sections only (includeGeometry: false)
  --omit-source-hash  store a zero source hash and flag it unset
                      (omitSourceHash: true)
  --no-compress       store every geometry chunk raw
                      (compressGeometryChunks: false)
  -V, --version       print the crate and cache format versions
  -h, --help          print this help";

enum Command {
    Build(Args),
    Help,
    Version,
}

struct Args {
    input: PathBuf,
    output: PathBuf,
    options: CacheOptions,
}

fn parse(args: impl Iterator<Item = String>) -> Result<Command, String> {
    let mut options = CacheOptions::default();
    let mut paths = Vec::new();
    for arg in args {
        match arg.as_str() {
            "-h" | "--help" => return Ok(Command::Help),
            "-V" | "--version" => return Ok(Command::Version),
            "--no-geometry" => options.include_geometry = false,
            "--omit-source-hash" => options.omit_source_hash = true,
            "--no-compress" => options.compress_geometry_chunks = false,
            flag if flag.starts_with('-') && flag != "-" => return Err(format!("unknown option {flag}")),
            path => paths.push(PathBuf::from(path)),
        }
    }
    match <[PathBuf; 2]>::try_from(paths) {
        Ok([input, output]) => Ok(Command::Build(Args { input, output, options })),
        Err(paths) => Err(format!("expected an input and an output path, got {}", paths.len())),
    }
}

fn json(stats: &CacheStats) -> String {
    format!(
        concat!(
            r#"{{"formatVersion":{},"entityCount":{},"entityRows":{},"meshCount":{},"skippedMeshes":{},"#,
            r#""chunkCount":{},"totalVertices":{},"totalTriangles":{},"cacheBytes":{},"#,
            r#""chunkCells":{},"peakOpenChunkBytes":{}}}"#
        ),
        FORMAT_VERSION,
        stats.entity_count,
        stats.entity_rows,
        stats.mesh_count,
        stats.skipped_meshes,
        stats.chunk_count,
        stats.total_vertices,
        stats.total_triangles,
        stats.cache_bytes,
        stats.chunk_cells,
        stats.peak_open_chunk_bytes,
    )
}

fn run(args: Args) -> Result<CacheStats, String> {
    let input = args.input.display();
    let file = File::open(&args.input).map_err(|error| format!("open {input}: {error}"))?;
    let length = file.metadata().map_err(|error| format!("stat {input}: {error}"))?.len();
    // Mapped, not read: the source pages are file-backed and reclaimable
    // instead of a heap copy. That bounds nothing by itself; what bounds the
    // geometry the writer holds is the open-chunk set (see `CacheStats`).
    // An empty file cannot be mapped on every platform, and needs no map.
    let map = if length == 0 {
        None
    } else {
        // SAFETY: the map is read-only and lives until the build returns. A
        // concurrent truncation of the input by another process could fault
        // the read; the same holds for any reader of a file being rewritten.
        Some(unsafe { memmap2::Mmap::map(&file) }.map_err(|error| format!("map {input}: {error}"))?)
    };
    let source: &[u8] = map.as_deref().unwrap_or(&[]);
    build_cache_to_path(source, &args.output, args.options).map_err(|error| error.to_string())
}

fn main() -> ExitCode {
    let usage = USAGE.replace("{VERSION}", &FORMAT_VERSION.to_string());
    match parse(std::env::args().skip(1)) {
        Ok(Command::Help) => {
            println!("{usage}");
            ExitCode::SUCCESS
        }
        Ok(Command::Version) => {
            println!("ifc-build-cache {} (format v{FORMAT_VERSION})", env!("CARGO_PKG_VERSION"));
            ExitCode::SUCCESS
        }
        Err(message) => {
            eprintln!("ifc-build-cache: {message}\n\n{usage}");
            ExitCode::from(2)
        }
        Ok(Command::Build(args)) => match run(args) {
            Ok(stats) => {
                println!("{}", json(&stats));
                ExitCode::SUCCESS
            }
            Err(message) => {
                eprintln!("ifc-build-cache: {message}");
                ExitCode::FAILURE
            }
        },
    }
}
