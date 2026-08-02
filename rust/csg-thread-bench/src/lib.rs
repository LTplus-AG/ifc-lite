// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Rung-2: does the pure-Rust exact CSG kernel scale with cores in a THREADED
//! WASM bundle (shared memory + atomics), net of the imported-memory per-load
//! tax and dlmalloc single-lock contention that are invisible on native?
//!
//! Two binaries are built from this one crate:
//!   - PLAIN  (no `threads` feature, no atomics): the current single-thread shape.
//!   - THREADED (`--features threads`, atomics/shared-memory RUSTFLAGS): a real
//!     rayon thread pool via wasm-bindgen-rayon.
//!
//! The browser harness loads a REAL captured void-cut corpus (serialized
//! natively) and times `replay()`. Comparing plain-serial vs threaded-serial
//! isolates the atomics tax; threaded-serial vs threaded-parallel(N) gives the
//! scaling; plain-serial vs threaded-parallel(N) is the decision number.

use ifc_lite_geometry::csg::ClippingProcessor;
use ifc_lite_geometry::csg_capture::{deserialize, CapturedCsgJob};
use ifc_lite_geometry::mesh::Mesh;
use std::sync::OnceLock;
use wasm_bindgen::prelude::*;

#[cfg(feature = "threads")]
pub use wasm_bindgen_rayon::init_thread_pool;

#[cfg(feature = "threads")]
use rayon::prelude::*;

static CORPUS: OnceLock<Vec<CapturedCsgJob>> = OnceLock::new();

/// Replay one captured cut through the production CSG path. Returns the output
/// triangle-index count — a deterministic, order-independent work fingerprint.
fn replay_one(job: &CapturedCsgJob) -> usize {
    let csg = ClippingProcessor::new();
    match job {
        CapturedCsgJob::Single { host, cutter } => {
            csg.subtract_mesh(host, cutter).map(|m| m.indices.len()).unwrap_or(0)
        }
        CapturedCsgJob::Many { host, cutters } => {
            let refs: Vec<&Mesh> = cutters.iter().collect();
            csg.subtract_mesh_many(host, &refs).map(|m| m.indices.len()).unwrap_or(0)
        }
    }
}

/// Load the captured corpus blob. Returns the job count.
#[wasm_bindgen]
pub fn load_corpus(blob: &[u8]) -> usize {
    match deserialize(blob) {
        Ok(jobs) => {
            let n = jobs.len();
            // OnceLock: first load wins. If the corpus is already initialized
            // (a second call in the same wasm instance), keep the existing one
            // and report ITS length — so the returned count never disagrees
            // with what `replay` actually iterates.
            match CORPUS.set(jobs) {
                Ok(()) => n,
                Err(_) => CORPUS.get().map_or(0, Vec::len),
            }
        }
        // Controlled failure (returns 0) instead of trapping on a bad blob.
        Err(_) => 0,
    }
}

/// Replay the whole corpus once. `parallel=true` uses the rayon pool (threaded
/// build only); otherwise a plain serial fold. JS times the call. Returns the
/// work fingerprint so the harness can verify byte-identical output across runs.
#[wasm_bindgen]
pub fn replay(parallel: bool) -> f64 {
    let jobs = CORPUS.get().expect("corpus not loaded");
    let fp: usize = if parallel {
        #[cfg(feature = "threads")]
        {
            jobs.par_iter().map(replay_one).sum()
        }
        #[cfg(not(feature = "threads"))]
        {
            jobs.iter().map(replay_one).sum()
        }
    } else {
        jobs.iter().map(replay_one).sum()
    };
    fp as f64
}

/// True if this binary was built with the threaded feature.
#[wasm_bindgen]
pub fn is_threaded() -> bool {
    cfg!(feature = "threads")
}

/// Run the FULL native pipeline (parse + prepass + decode + extrude + CSG) on
/// raw IFC bytes. process_geometry's internal element loop is a rayon par_iter,
/// so under the threaded build + an initialized pool it parallelizes
/// decode+CSG together (the §12 "thread the whole batch" shape). Comparing this
/// to the pure-CSG `replay` quantifies the serial parse/prepass + decode drag.
/// Returns the mesh count as a fingerprint; JS times the call.
#[wasm_bindgen]
pub fn run_pipeline(bytes: &[u8]) -> f64 {
    let result = ifc_lite_processing::process_geometry(bytes);
    result.meshes.len() as f64
}
