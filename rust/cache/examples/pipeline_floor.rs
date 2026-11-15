// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Measurement harness for #9584: the geometry pass the cache writers run,
//! with every mesh dropped as it is emitted and nothing written. Its peak RSS
//! is the pipeline's own floor, so `ifc-build-cache`'s peak minus this is
//! what the streaming writer adds (the open chunks, the directory, the
//! scalar sections), and `conformance_writer`'s minus this is what retaining
//! the mesh set costs. Same request as the streaming writer
//! (`src/pipeline.rs`): 1024-job batches, retention off, finishes on.
//!
//!   cargo build --release -p ifc-lite-cache --example pipeline_floor
//!   /usr/bin/time -l target/release/examples/pipeline_floor <in.ifc>

use ifc_lite_processing::{process, Batching, Features, OnBatch, ProcessingRequest};

fn main() {
    let Some(input) = std::env::args().nth(1) else {
        eprintln!("usage: pipeline_floor <in.ifc>");
        std::process::exit(2);
    };
    // Mapped exactly as `ifc-build-cache` maps it, so the two peaks count the
    // input under the same memory class and their difference is the writer's.
    let file = std::fs::File::open(&input).unwrap_or_else(|error| panic!("open {input}: {error}"));
    let empty = file.metadata().map(|m| m.len() == 0).unwrap_or(false);
    // SAFETY: as in the CLI, a concurrent truncation of the input could fault
    // the read; this is a measurement harness over files nothing rewrites.
    let map = (!empty).then(|| unsafe { memmap2::Mmap::map(&file) }.unwrap_or_else(|error| panic!("map {input}: {error}")));
    let source: &[u8] = map.as_deref().unwrap_or(&[]);
    let features = Features::default().properties(false).presentation_layers(false).finishes(true);
    let request = ProcessingRequest::default()
        .batching(Batching::new(1024, 1024))
        .layer_slicing(true)
        .retain_meshes(false)
        .features(features);
    let mut meshes = 0usize;
    process(source, &request, &mut OnBatch::new(|batch: &[_], _, _| meshes += batch.len()));
    println!("{{\"meshCount\":{meshes}}}");
}
