// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Whole-call instruction-count driver for historical commits (#6958).
//!
//! `scripts/perf/instructions-replay.mjs` copies this file into a throwaway
//! worktree at an old commit, builds it there, and runs it under callgrind with
//! `--dump-before=*::measured_pipeline --dump-after=*::measured_pipeline`, so
//! one dump holds exactly the instructions of one `process_geometry` call,
//! including dropping its result. Old commits have no phase markers, so this
//! counts the whole call only; per-phase counts are `perf_probe` built with
//! `--features phase-markers` (scripts/perf/instructions.sh).
//!
//! It deliberately touches only API that has been stable across the replayed
//! history: `process_geometry(&[u8])` and the three `ProcessingStats` counts.
//!
//! ```text
//! cargo run --profile profiling -p ifc-lite-processing --example instructions_driver -- <file.ifc>
//! ```

use std::hint::black_box;

/// The measured window: one full processing call plus dropping its result.
#[inline(never)]
fn measured_pipeline(content: &[u8]) -> [usize; 3] {
    let result = ifc_lite_processing::process_geometry(content);
    let counts = [
        result.stats.total_meshes,
        result.stats.total_vertices,
        result.stats.total_triangles,
    ];
    drop(black_box(result));
    counts
}

fn main() {
    let Some(path) = std::env::args().nth(1) else {
        eprintln!("usage: instructions_driver <file.ifc>");
        std::process::exit(2);
    };
    let content = match std::fs::read(&path) {
        Ok(content) => content,
        Err(error) => {
            eprintln!("instructions_driver: cannot read {path}: {error}");
            std::process::exit(2);
        }
    };
    // One rayon worker, and it is this thread: no cross-thread hand-off, so
    // the count does not depend on how idle workers spun.
    if let Err(error) = rayon::ThreadPoolBuilder::new()
        .num_threads(1)
        .use_current_thread()
        .build_global()
    {
        eprintln!("instructions_driver: could not pin the rayon pool: {error}");
        std::process::exit(2);
    }
    let [meshes, vertices, triangles] = measured_pipeline(&content);
    println!(r#"{{"meshes":{meshes},"vertices":{vertices},"triangles":{triangles}}}"#);
}
