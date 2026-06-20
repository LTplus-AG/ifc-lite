// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Rung-1 native CSG core-scaling microbench.
//!
//! Question it answers: does across-element exact CSG (void cutting) scale with
//! CPU cores on native? This isolates the CSG subtract from decode/parse/extrude
//! — the §12 single-controller post-mortem found the pipeline DECODE-dominated,
//! but it measured the cheap BSP kernel a month before the pure-Rust exact
//! kernel landed. If this rung shows the exact kernel scales, the wasm-threaded
//! build (rung 2) is worth measuring; if it doesn't even scale natively, stop.
//!
//! Method (no synthetic data — the corpus is REAL):
//!   1. Drive the native pipeline once on a real IFC model. The `csg_capture`
//!      feature records the (host, cutters) of every kernel subtract.
//!   2. Drain that corpus. Decode/parse/extrude are now OUT of the timed path.
//!   3. Replay the corpus through the production CSG path (`ClippingProcessor`)
//!      under scoped rayon pools of 1, 2, 4, 8, … threads.
//!   4. Report wall time, speedup, efficiency, and verify byte-identical output
//!      work across thread counts (the kernel is order-independent).
//!
//! Run:
//!   cargo run --release -p ifc-lite-processing \
//!     --example csg_scaling_bench --features csg-capture \
//!     -- tests/models/ara3d/C20-Institute-Var-2.ifc
//!   (or set CSG_BENCH_FIXTURE / CSG_BENCH_ITERS)

use ifc_lite_geometry::csg::ClippingProcessor;
use ifc_lite_geometry::csg_capture::{drain, CapturedCsgJob};
use ifc_lite_geometry::mesh::Mesh;
use ifc_lite_processing::process_geometry;
use rayon::prelude::*;
use std::time::Instant;

/// Replay ONE captured job through the production CSG path. Returns the output
/// triangle-index count — a deterministic fingerprint of the work performed.
fn replay(job: &CapturedCsgJob) -> usize {
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

fn run_pool(jobs: &[CapturedCsgJob], threads: usize) -> (u128, usize) {
    let pool = rayon::ThreadPoolBuilder::new()
        .num_threads(threads)
        .build()
        .expect("build rayon pool");
    let t = Instant::now();
    let fingerprint = pool.install(|| jobs.par_iter().map(replay).sum::<usize>());
    (t.elapsed().as_micros(), fingerprint)
}

fn main() {
    let fixture = std::env::args()
        .nth(1)
        .or_else(|| std::env::var("CSG_BENCH_FIXTURE").ok())
        .unwrap_or_else(|| "tests/models/ara3d/C20-Institute-Var-2.ifc".to_string());
    let iters: usize = std::env::var("CSG_BENCH_ITERS").ok().and_then(|s| s.parse().ok()).unwrap_or(4);

    let content = match std::fs::read_to_string(&fixture) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("skip: cannot read fixture {fixture}: {e}");
            eprintln!("      (run `pnpm fixtures` or pass a path / CSG_BENCH_FIXTURE)");
            return;
        }
    };

    let max_threads = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(8);
    println!("fixture: {fixture} ({:.1} MB)", content.len() as f64 / 1e6);
    println!("host cores (available_parallelism): {max_threads}");

    // --- Phase 1: capture the real CSG corpus (untimed) ---
    println!("\n[capture] driving native pipeline once to record real void-cut jobs…");
    let cap_t = Instant::now();
    ifc_lite_geometry::csg_capture::set_enabled(true);
    let _ = process_geometry(&content);
    ifc_lite_geometry::csg_capture::set_enabled(false);
    let cap_ms = cap_t.elapsed().as_millis();
    let jobs = drain();

    if jobs.is_empty() {
        eprintln!("skip: 0 CSG jobs captured — this model has no void cuts. Try a model with openings.");
        return;
    }

    // Corpus stats.
    let (mut n_single, mut n_many, mut n_cutters, mut host_tris, mut cutter_tris) = (0usize, 0usize, 0usize, 0usize, 0usize);
    for j in &jobs {
        match j {
            CapturedCsgJob::Single { host, cutter } => {
                n_single += 1;
                n_cutters += 1;
                host_tris += host.indices.len() / 3;
                cutter_tris += cutter.indices.len() / 3;
            }
            CapturedCsgJob::Many { host, cutters } => {
                n_many += 1;
                n_cutters += cutters.len();
                host_tris += host.indices.len() / 3;
                cutter_tris += cutters.iter().map(|c| c.indices.len() / 3).sum::<usize>();
            }
        }
    }
    let working_set_mb = jobs.iter().map(|j| match j {
        CapturedCsgJob::Single { host, cutter } => mesh_bytes(host) + mesh_bytes(cutter),
        CapturedCsgJob::Many { host, cutters } => mesh_bytes(host) + cutters.iter().map(mesh_bytes).sum::<usize>(),
    }).sum::<usize>() as f64 / 1e6;

    println!("[capture] full pipeline ran in {cap_ms} ms (incl. parse+decode+extrude+CSG)");

    // Optional: dump the real corpus to a blob for the in-browser (rung 2) replay.
    if let Ok(path) = std::env::var("CSG_BENCH_DUMP") {
        let blob = ifc_lite_geometry::csg_capture::serialize(&jobs);
        match std::fs::write(&path, &blob) {
            Ok(()) => println!("[dump] wrote {} jobs -> {path} ({:.1} MB)", jobs.len(), blob.len() as f64 / 1e6),
            Err(e) => eprintln!("[dump] failed to write {path}: {e}"),
        }
    }
    println!("\n=== CSG corpus (the timed working set, decode EXCLUDED) ===");
    println!("  jobs:            {} ({} batched 'many', {} single)", jobs.len(), n_many, n_single);
    println!("  total cutters:   {n_cutters}");
    println!("  host triangles:  {host_tris}");
    println!("  cutter triangles:{cutter_tris}");
    println!("  input working set: {working_set_mb:.1} MB  (L2/L3 cache caveat: a small set understates the memory cost wasm's imported-memory tax would expose)");

    // --- Phase 2: warm up + serial baseline ---
    println!("\n[warmup] one untimed serial pass…");
    let (_, baseline_fp) = run_pool(&jobs, 1);

    // --- Phase 3: thread sweep ---
    let mut thread_counts: Vec<usize> = vec![1, 2, 4, 8, max_threads];
    thread_counts.retain(|&n| n <= max_threads);
    thread_counts.sort_unstable();
    thread_counts.dedup();

    println!("\n=== scaling sweep ({iters} timed iters each, reporting MIN wall) ===");
    println!("{:>8} | {:>11} | {:>8} | {:>10} | {}", "threads", "min ms", "speedup", "efficiency", "parity");

    let mut serial_ms: Option<f64> = None;
    for &n in &thread_counts {
        // one untimed warmup at this thread count
        let _ = run_pool(&jobs, n);
        let mut best = u128::MAX;
        let mut ok = true;
        for _ in 0..iters {
            let (us, fp) = run_pool(&jobs, n);
            if fp != baseline_fp {
                ok = false;
            }
            best = best.min(us);
        }
        let ms = best as f64 / 1000.0;
        if n == 1 {
            serial_ms = Some(ms);
        }
        let speedup = serial_ms.map(|s| s / ms).unwrap_or(1.0);
        let eff = speedup / n as f64 * 100.0;
        println!(
            "{:>8} | {:>11.1} | {:>7.2}x | {:>9.0}% | {}",
            n, ms, speedup, eff, if ok { "ok" } else { "MISMATCH!" }
        );
    }

    println!("\nReading: efficiency near 100% at high thread counts ⇒ exact CSG is core-scalable ⇒");
    println!("rung 2 (wasm-threaded build) is worth measuring. Efficiency collapsing toward 1/N ⇒");
    println!("the work is memory/bandwidth-bound even on native ⇒ wasm threading will not help. Gate: >=2x at max threads.");
}

fn mesh_bytes(m: &Mesh) -> usize {
    m.positions.len() * 4 + m.normals.len() * 4 + m.indices.len() * 4
}
